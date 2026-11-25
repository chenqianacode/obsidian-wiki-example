// 结构与一致性体检（0-token 纯脚本）：配置、Schema、断链、同名冲突、孤立页、CRUD/服务/状态机一致性、错误码重号、过期/到期文档、冲突与文档债
// 用法：node scripts/lint.mjs [--strict]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, WIKI, DOC_SOURCES, MULTI_DOCS, flags, today, now, findOverlappingDocSources } from './lib/config.mjs';
import {
  ENTITY_TYPES,
  VALID_STATUS,
  loadAll,
  link,
  unlink,
  norm,
  splitColon,
  stripCode,
  extractWikiLinks,
} from './lib/pages.mjs';
import {
  getSourceGitInfo,
  listAllDocs,
  parseDocPath,
  docCommitFull,
  sameCommit,
  findDocBasenameCollisions,
  stripDocExt,
} from './lib/docs.mjs';

const GENERATED_NAMES = new Set(['CRUD矩阵', '接口与消息总表', '错误码字典', '文档对照表', 'lint报告', 'index']);

function writeIfChanged(filePath, content) {
  const stripTs = (s) =>
    String(s)
      .replace(/^updated: ".*"$/m, 'updated: ""')
      .replace(/生成于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '生成于 ');
  if (fs.existsSync(filePath)) {
    const prev = fs.readFileSync(filePath, 'utf8');
    if (stripTs(prev) === stripTs(content)) return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

export function lint() {
  const pages = loadAll();
  const pageByName = new Map(pages.map((p) => [p.name, p]));
  const pageByRelNoExt = new Map(pages.map((p) => [p.rel.replace(/\.md$/i, ''), p]));
  const names = new Set([...pages.map((p) => p.name), ...GENERATED_NAMES]);

  const resolvePageName = (target) => {
    const t = unlink(target);
    if (!t) return '';
    if (pageByName.has(t)) return t;
    const cleanRel = t.replace(/^wiki\//, '').replace(/\.md$/i, '');
    if (pageByRelNoExt.has(cleanRel)) return pageByRelNoExt.get(cleanRel).name;
    return '';
  };

  const exists = (t) =>
    names.has(t) ||
    Boolean(resolvePageName(t)) ||
    fs.existsSync(path.join(WIKI, `${t}.md`)) ||
    fs.existsSync(path.join(WIKI, t)) ||
    fs.existsSync(path.join(ROOT, `${t}.md`)) ||
    fs.existsSync(path.join(ROOT, t));

  const entities = pages.filter((p) => ENTITY_TYPES.includes(p.data.type));
  const sources = pages.filter((p) => p.data.type === 'source');
  const questions = pages.filter((p) => p.data.type === 'question');
  const srcByName = new Map(sources.map((s) => [s.name, s]));
  const entityByName = new Map(entities.map((e) => [e.name, e]));

  // 0. 配置与文档源校验
  const configIssues = [];
  if (!DOC_SOURCES.length) {
    configIssues.push('`wiki.config.json` 未配置有效的 `docsDir` / `docsDirs`');
  }
  for (const s of DOC_SOURCES) {
    const info = getSourceGitInfo(s);
    if (!info.exists) {
      configIssues.push(`文档源 \`${s.id}\` 路径不存在：\`${s.rawPath}\``);
    } else if (!info.isGit) {
      configIssues.push(`文档源 \`${s.id}\` 不在 Git 仓库中：\`${s.rawPath}\`（无法追踪提交与增量同步）`);
    }
  }
  for (const [parent, child] of findOverlappingDocSources()) {
    configIssues.push(`文档源目录嵌套重叠：\`${parent.id}\`（\`${parent.rawPath}\`）包含 \`${child.id}\`（\`${child.rawPath}\`）`);
  }

  // 1. Frontmatter 语法与必填字段校验
  const schemaErrors = [];
  for (const p of pages) {
    for (const err of p.fmErrors || []) schemaErrors.push(`${link(p.name)}：${err}`);
    const d = p.data;
    for (const req of ['type', 'title', 'summary', 'status', 'updated']) {
      if (!d[req]) schemaErrors.push(`${link(p.name)}：缺少必填字段 \`${req}\``);
    }
    if (d.type && VALID_STATUS[d.type] && d.status && !VALID_STATUS[d.type].includes(d.status)) {
      schemaErrors.push(`${link(p.name)}：非法 status 值 \`${d.status}\`（允许：${VALID_STATUS[d.type].join('/')}）`);
    }
    if (d.type === 'source') {
      for (const req of ['doc_type', 'doc_path', 'doc_commit']) {
        if (!d[req]) schemaErrors.push(`${link(p.name)}：source 页缺少 \`${req}\``);
      }
      if (MULTI_DOCS && d.doc_path && parseDocPath(d.doc_path)?.legacyUnprefixed) {
        schemaErrors.push(`${link(p.name)}：多目录模式下 \`doc_path\`（\`${d.doc_path}\`）应补充文档源前缀 \`<id>:<relPath>\``);
      }
    }
    if (ENTITY_TYPES.includes(d.type) && !Array.isArray(d.sources)) {
      schemaErrors.push(`${link(p.name)}：实体页 \`sources\` 必须是数组`);
    }
    if (d.type === 'feature') {
      if (!d.service) schemaErrors.push(`${link(p.name)}：feature 页缺少 \`service\``);
      if (!Array.isArray(d.crud)) schemaErrors.push(`${link(p.name)}：feature 页 \`crud\` 必须是数组`);
    }
  }

  // 2. 同名冲突检测（Wiki 页面同名/大小写重名 + aliases 重名 + 未消歧的跨目录原文档同名）
  const nameCollisions = [];
  const pagePathsByLowerName = new Map();
  for (const p of pages) {
    const key = p.name.toLowerCase();
    const arr = pagePathsByLowerName.get(key) || [];
    arr.push(p);
    pagePathsByLowerName.set(key, arr);
  }
  for (const [, list] of pagePathsByLowerName.entries()) {
    if (list.length > 1) {
      nameCollisions.push(`Wiki 重名（含大小写冲突）：${list.map((p) => `\`${p.rel}\``).join('、')}`);
    }
  }

  // 实体/术语别名撞名检查
  const conceptOwners = new Map();
  for (const p of entities) {
    const keys = new Set([norm(p.name), ...(Array.isArray(p.data.aliases) ? p.data.aliases.map(norm) : [])]);
    for (const k of keys) {
      if (!k) continue;
      const arr = conceptOwners.get(k) || [];
      arr.push(p.name);
      conceptOwners.set(k, arr);
    }
  }
  const seenAliasPair = new Set();
  for (const [k, owners] of conceptOwners.entries()) {
    if (owners.length > 1) {
      const pairKey = [...owners].sort().join('|');
      if (seenAliasPair.has(pairKey)) continue;
      seenAliasPair.add(pairKey);
      nameCollisions.push(`实体名称或 aliases 冲突（归一化键 \`${k}\`）：${owners.map(link).join('、')}`);
    }
  }

  // 原文档跨目录同名检查：仅当未全部在 wiki/sources/ 中以不同页名消歧时才报错
  const allDocs = listAllDocs();
  const activeSrcByDocPath = new Map();
  for (const s of sources.filter((x) => x.data.status !== 'deleted')) {
    const parsed = parseDocPath(s.data.doc_path);
    const canonical = parsed ? parsed.docPath : s.data.doc_path;
    if (canonical) activeSrcByDocPath.set(canonical, s);
  }
  for (const [base, docPaths] of findDocBasenameCollisions(allDocs)) {
    const mappedNames = docPaths.map((dp) => activeSrcByDocPath.get(dp)?.name || '');
    const allDisambiguated =
      mappedNames.every(Boolean) && new Set(mappedNames).size === docPaths.length;
    if (!allDisambiguated) {
      nameCollisions.push(
        `原文档跨目录同名 \`${base}\`（摄入时须加目录/文档源前缀消歧）：${docPaths.map((d) => `\`${d}\``).join('、')}`,
      );
    }
  }

  // 3. 断链与入站链接统计（剥离代码块并规范化路径形式双链）
  const broken = new Set();
  const inbound = new Map();
  const extractLinks = (p) => {
    const fmLinks = ['sources', 'related', 'calls', 'entities']
      .flatMap((k) => (Array.isArray(p.data[k]) ? p.data[k] : []))
      .map((item) => {
        const s = String(item).trim();
        return s.startsWith('[[') ? s : `[[${s}]]`;
      })
      .join('\n');
    return `${stripCode(p.body)}\n${fmLinks}`;
  };

  for (const p of pages) {
    for (const m of extractLinks(p).matchAll(/\[\[([^\]]+)\]\]/g)) {
      const t = unlink(m[1]);
      if (!t) continue;
      if (!exists(t)) {
        broken.add(`[[${p.name}]] → \`${t}\``);
      } else if (p.data.type !== 'source') {
        const canonicalTarget = resolvePageName(t) || t;
        if (canonicalTarget !== p.name) {
          inbound.set(canonicalTarget, (inbound.get(canonicalTarget) || 0) + 1);
        }
      }
    }
  }

  const orphans = entities.filter((p) => !inbound.get(p.name));
  // 修复：指向不存在的 source 链接不能算有效来源
  const noSource = entities.filter(
    (p) =>
      !(p.data.sources || []).some((s) => {
        const src = srcByName.get(unlink(s));
        return Boolean(src && src.data.status !== 'deleted');
      }),
  );
  const noTableDef = entities.filter(
    (p) =>
      p.data.type === 'table' &&
      !(p.data.sources || []).some((s) => {
        const src = srcByName.get(unlink(s));
        return Boolean(src && src.data.status !== 'deleted' && src.data.doc_type === '表定义');
      }),
  );

  // 4. CRUD / 服务归属 / 下游调用 / 错误码重号一致性检查
  const relationIssues = [];
  const errCodeOwners = new Map();
  const bodyLinksCache = new Map(pages.map((p) => [p.name, extractWikiLinks(p.body)]));

  for (const f of entities.filter((p) => p.data.type === 'feature')) {
    if (f.data.service) {
      const rawSvc = String(f.data.service).trim();
      const svcName = unlink(rawSvc);
      if (rawSvc !== svcName) {
        relationIssues.push(`[[${f.name}]]：\`service\` 应写裸模块名 \`"${svcName}"\`，无需外包 \`[[]]\``);
      }
      const svc = entityByName.get(svcName);
      if (!svc || svc.data.type !== 'module') {
        relationIssues.push(`[[${f.name}]]：\`service\` 指向不存在的模块页 \`${svcName}\``);
      } else if (!bodyLinksCache.get(svc.name)?.has(f.name)) {
        relationIssues.push(`[[${svc.name}]]：模块页正文漏列其负责的功能 [[${f.name}]]`);
      }
    }

    const seenCrudTables = new Set();
    for (const c of f.data.crud || []) {
      const rawStr = String(c);
      if (rawStr.includes('：')) {
        relationIssues.push(`[[${f.name}]]：CRUD 声明 \`${rawStr}\` 使用了中文全角冒号，应改为半角 \`:\``);
      }
      const [rawT, rawOp] = splitColon(rawStr);
      const tName = unlink(rawT);
      if (!tName) continue;
      if (rawT !== tName) {
        relationIssues.push(`[[${f.name}]]：CRUD 声明 \`${rawStr}\` 中的表名无需外包 \`[[]]\``);
      }
      if (seenCrudTables.has(tName)) {
        relationIssues.push(`[[${f.name}]]：CRUD 声明重复列出了表 \`${tName}\`，应合并为一条（如 \`${tName}:CRU\`）`);
      }
      seenCrudTables.add(tName);
      if (!rawOp || !/^[CRUD]+$/.test(rawOp)) {
        relationIssues.push(`[[${f.name}]]：CRUD 声明格式异常 \`${rawStr}\`（应如 \`T_XXX:CRU\`）`);
      }
      const tp = entityByName.get(tName);
      if (!tp || tp.data.type !== 'table') {
        relationIssues.push(`[[${f.name}]]：CRUD 引用了不存在的表页面 \`${tName}\``);
      } else if (!bodyLinksCache.get(tp.name)?.has(f.name)) {
        relationIssues.push(`[[${tp.name}]]：表页面正文未列出使用它的功能 [[${f.name}]]`);
      }
    }

    for (const callTarget of f.data.calls || []) {
      const targetName = unlink(callTarget);
      const targetPage = entityByName.get(targetName);
      if (!targetPage || !['feature', 'module'].includes(targetPage.data.type)) {
        relationIssues.push(`[[${f.name}]]：\`calls\` 引用了不存在的功能/模块页 \`${targetName}\``);
      }
    }

    const seenErrInFeat = new Set();
    for (const item of f.data.error_codes || []) {
      const rawStr = String(item);
      if (rawStr.includes('：') && !rawStr.includes(':')) {
        relationIssues.push(`[[${f.name}]]：错误码 \`${rawStr}\` 使用了中文全角冒号，应改为半角 \`:\``);
      }
      const [code] = splitColon(rawStr);
      if (!code) continue;
      if (seenErrInFeat.has(code)) {
        relationIssues.push(`[[${f.name}]]：功能内重复声明错误码 \`${code}\``);
        continue;
      }
      seenErrInFeat.add(code);
      const arr = errCodeOwners.get(code) || [];
      arr.push(f.name);
      errCodeOwners.set(code, arr);
    }
  }
  for (const [code, owners] of errCodeOwners.entries()) {
    if (owners.length > 1) {
      relationIssues.push(`错误码重复定义 \`${code}\`：${owners.map(link).join('、')}`);
    }
  }

  // 5. 三态冲突状态机 & missing-def 一致性检查
  const stateIssues = [];
  const openRefsByEntity = new Map();
  const decidedRefsByEntity = new Map();

  for (const q of questions) {
    const relTargets = (Array.isArray(q.data.related) ? q.data.related : []).map(unlink).filter(Boolean);
    if (q.data.status === 'open') {
      for (const target of relTargets) {
        const ent = entityByName.get(target);
        if (!ent) continue;
        (openRefsByEntity.get(target) || openRefsByEntity.set(target, []).get(target)).push(q.name);
        if (!['contested', 'needs-review'].includes(ent.data.status)) {
          stateIssues.push(`[[${ent.name}]] 状态为 \`${ent.data.status}\`，但关联了未拍板问题 [[${q.name}]]（应标为 \`contested\`）`);
        }
      }
    } else if (q.data.status === 'decided') {
      for (const target of relTargets) {
        const ent = entityByName.get(target);
        if (!ent) continue;
        (decidedRefsByEntity.get(target) || decidedRefsByEntity.set(target, []).get(target)).push(q.name);
        if (!['pending-doc', 'contested', 'needs-review'].includes(ent.data.status)) {
          stateIssues.push(`[[${ent.name}]] 状态为 \`${ent.data.status}\`，但关联了待改原文档决议 [[${q.name}]]（应标为 \`pending-doc\`）`);
        }
      }
    }
  }

  const noTableDefNames = new Set(noTableDef.map((t) => t.name));
  for (const ent of entities) {
    if (ent.data.status === 'contested' && !(openRefsByEntity.get(ent.name)?.length)) {
      stateIssues.push(`[[${ent.name}]] 状态为 \`contested\`，但 \`wiki/questions/\` 中无关联它的 \`open\` 问题页`);
    }
    if (ent.data.status === 'pending-doc' && !(decidedRefsByEntity.get(ent.name)?.length)) {
      stateIssues.push(`[[${ent.name}]] 状态为 \`pending-doc\`，但 \`wiki/questions/\` 中无关联它的 \`decided\` 问题页`);
    }
    if (ent.data.type === 'table') {
      if (ent.data.status === 'missing-def' && !noTableDefNames.has(ent.name)) {
        stateIssues.push(`[[${ent.name}]] 已有正式「表定义」来源，状态仍为 \`missing-def\`（应恢复为 \`active\`）`);
      } else if (ent.data.status === 'active' && noTableDefNames.has(ent.name)) {
        stateIssues.push(`[[${ent.name}]] 缺少「表定义」来源，但状态为 \`active\`（建议标为 \`missing-def\`）`);
      }
    }
  }

  // 6. 文档摄入、Git 同步状态与临时规则时效检查
  const ingestedDocPaths = new Set();
  for (const s of sources.filter((x) => x.data.status !== 'deleted')) {
    const parsed = parseDocPath(s.data.doc_path);
    if (parsed) {
      ingestedDocPaths.add(parsed.docPath);
      ingestedDocPaths.add(parsed.relPath);
    } else if (s.data.doc_path) {
      ingestedDocPaths.add(s.data.doc_path);
    }
  }
  const notIngested = allDocs.filter((d) => !ingestedDocPaths.has(d.docPath) && !ingestedDocPaths.has(d.relPath));

  const stale = [];
  for (const s of sources.filter((x) => x.data.status !== 'deleted')) {
    const parsed = parseDocPath(s.data.doc_path);
    if (!parsed || !fs.existsSync(parsed.absPath)) {
      stale.push(`[[${s.name}]]：原文档 \`${s.data.doc_path}\` 已不存在，需同步标为 deleted`);
      continue;
    }
    const headFull = docCommitFull(parsed.docPath);
    if (headFull && !sameCommit(headFull, s.data.doc_commit)) {
      stale.push(`[[${s.name}]]：wiki 基于 \`${s.data.doc_commit}\`，原文档已更新到 \`${headFull.slice(0, 7)}\``);
    }
  }

  const todayStr = today();
  const expiredActive = pages.filter(
    (p) => p.data.valid_until && String(p.data.valid_until) < todayStr && p.data.status === 'active',
  );

  // 7. 冲突与待修订文档债分层汇总
  const contestedPages = entities.filter((p) => ['contested', 'needs-review'].includes(p.data.status));
  const pendingDocPages = entities.filter((p) => p.data.status === 'pending-doc');
  const openQs = questions.filter((p) => p.data.status === 'open');
  const decidedQs = questions.filter((p) => p.data.status === 'decided');

  const blockingCount =
    configIssues.length +
    schemaErrors.length +
    nameCollisions.length +
    broken.size +
    relationIssues.length +
    stateIssues.length;

  const sections = [
    ['配置与文档源问题', configIssues],
    ['Frontmatter 语法与必填字段错误', schemaErrors],
    ['同名冲突（Wiki 页面、别名或未消歧原文档）', nameCollisions],
    ['断链', [...broken]],
    ['孤立页面（无入站链接的知识页）', orphans.map((p) => link(p.name))],
    ['没有有效来源的实体页', noSource.map((p) => link(p.name))],
    ['CRUD / 服务归属 / 错误码一致性问题', relationIssues],
    ['状态机与表定义状态一致性问题', stateIssues],
    ['尚未摄入的文档', notIngested.map((d) => `\`${d.docPath}\``)],
    ['过期未同步页面（原文档有新提交或已删除）', stale],
    [
      '已到期未归档的临时规则/文档（valid_until 已过期但仍为 active）',
      expiredActive.map((p) => `${link(p.name)}（有效期至 \`${p.data.valid_until}\`）`),
    ],
    ['缺少表定义的表（仅在设计中出现，无表定义文档）', noTableDef.map((p) => link(p.name))],
    ['待拍板的冲突实体页（contested / needs-review）', contestedPages.map((p) => `${link(p.name)} \`${p.data.status}\``)],
    ['待拍板的跨文档问题（open）', openQs.map((p) => `${link(p.name)} — ${p.data.summary || ''}`)],
    [
      '已决议但原文档待修订（pending-doc / decided）',
      [
        ...decidedQs.map((p) => `${link(p.name)} \`decided\` — ${p.data.summary || ''}`),
        ...pendingDocPages.map((p) => `${link(p.name)} \`pending-doc\``),
      ],
    ],
  ];

  let md = `---\ntype: "report"\nupdated: "${now()}"\n---\n\n# lint报告\n\n> 由 \`scripts/lint.mjs\` 生成于 ${now()}。结构、Schema、时效、状态机与双向引用由脚本自动校验；跨文档语义矛盾由 Agent 在 ingest/sync 时识别并记录到 \`wiki/questions/\`。\n\n| 检查项 | 数量 |\n|---|---|\n`;
  md += sections.map(([t, l]) => `| ${t} | ${l.length} |`).join('\n');
  for (const [t, l] of sections) {
    if (l.length) md += `\n\n## ${t}\n${l.map((x) => `- ${x}`).join('\n')}`;
  }
  const reportFile = path.join(ROOT, 'wiki/_reports/lint报告.md');
  writeIfChanged(reportFile, `${md}\n`);
  return { summary: sections.map(([t, l]) => [t, l.length]), blockingCount };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { summary, blockingCount } = lint();
  for (const [t, n] of summary) console.log(`${n ? '⚠' : '✓'} ${t}：${n}`);
  console.log('详细报告：wiki/_reports/lint报告.md');
  if (flags.has('--strict') && blockingCount > 0) {
    console.error(`✖ --strict 检查未通过：存在 ${blockingCount} 项阻塞性错误。`);
    process.exit(1);
  }
}
