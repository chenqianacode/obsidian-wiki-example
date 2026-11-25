// 结构与一致性体检（0-token 纯脚本）：Schema、断链、同名冲突、孤立页、CRUD/服务对称性、错误码重号、过期/到期文档、冲突与文档债
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DOCS, WIKI, today, now } from './lib/config.mjs';
import { ENTITY_TYPES, VALID_STATUS, loadAll, link, unlink, stripCode } from './lib/pages.mjs';
import { listDocs, docCommitFull, sameCommit, findDocBasenameCollisions } from './lib/docs.mjs';

const GENERATED_NAMES = new Set(['CRUD矩阵', '接口与消息总表', '错误码字典', '文档对照表', 'lint报告', 'index']);

export function lint() {
  const pages = loadAll();
  const names = new Set([...pages.map((p) => p.name), ...GENERATED_NAMES]);
  const exists = (t) =>
    names.has(t) ||
    fs.existsSync(path.join(WIKI, `${t}.md`)) ||
    fs.existsSync(path.join(WIKI, t)) ||
    fs.existsSync(path.join(ROOT, `${t}.md`)) ||
    fs.existsSync(path.join(ROOT, t));

  const entities = pages.filter((p) => ENTITY_TYPES.includes(p.data.type));
  const sources = pages.filter((p) => p.data.type === 'source');
  const srcByName = new Map(sources.map((s) => [s.name, s]));
  const entityByName = new Map(entities.map((e) => [e.name, e]));

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
    }
    if (ENTITY_TYPES.includes(d.type) && !Array.isArray(d.sources)) {
      schemaErrors.push(`${link(p.name)}：实体页 \`sources\` 必须是 JSON 数组`);
    }
    if (d.type === 'feature') {
      if (!d.service) schemaErrors.push(`${link(p.name)}：feature 页缺少 \`service\``);
      if (!Array.isArray(d.crud)) schemaErrors.push(`${link(p.name)}：feature 页 \`crud\` 必须是 JSON 数组`);
    }
  }

  // 2. 同名冲突检测（Wiki 页面同名 + 原文档跨目录同名）
  const nameCollisions = [];
  const pagePathsByName = new Map();
  for (const p of pages) {
    const arr = pagePathsByName.get(p.name) || [];
    arr.push(p.rel);
    pagePathsByName.set(p.name, arr);
  }
  for (const [n, rels] of pagePathsByName.entries()) {
    if (rels.length > 1) nameCollisions.push(`Wiki 重名 \`${n}\`：${rels.map((r) => `\`${r}\``).join('、')}`);
  }
  for (const [base, docs] of findDocBasenameCollisions()) {
    nameCollisions.push(`原文档跨目录同名 \`${base}.md\`（会导致 src- 页面覆盖）：${docs.map((d) => `\`${d}\``).join('、')}`);
  }

  // 3. 断链与入站链接统计（剥离代码块避免误判）
  const broken = new Set();
  const inbound = new Map();
  const extractLinks = (p) => {
    const fmLinks = ['sources', 'related', 'calls', 'entities']
      .flatMap((k) => (Array.isArray(p.data[k]) ? p.data[k] : []))
      .join('\n');
    return `${stripCode(p.body)}\n${fmLinks}`;
  };

  for (const p of pages) {
    for (const m of extractLinks(p).matchAll(/\[\[([^\]]+)\]\]/g)) {
      const t = unlink(m[1]);
      if (!t) continue;
      if (!exists(t)) broken.add(`[[${p.name}]] → \`${t}\``);
      else if (t !== p.name && p.data.type !== 'source') inbound.set(t, (inbound.get(t) || 0) + 1);
    }
  }

  const orphans = entities.filter((p) => !inbound.get(p.name));
  const noSource = entities.filter(
    (p) => !(p.data.sources || []).some((s) => srcByName.get(unlink(s))?.data.status !== 'deleted'),
  );
  const noTableDef = entities.filter(
    (p) => p.data.type === 'table' && !(p.data.sources || []).some((s) => srcByName.get(unlink(s))?.data.doc_type === '表定义'),
  );

  // 4. CRUD / 服务归属 / 下游调用 / 错误码重号一致性检查
  const relationIssues = [];
  const errCodeOwners = new Map();
  for (const f of entities.filter((p) => p.data.type === 'feature')) {
    if (f.data.service) {
      const svc = entityByName.get(f.data.service);
      if (!svc || svc.data.type !== 'module') {
        relationIssues.push(`[[${f.name}]]：\`service\` 指向不存在的模块页 \`${f.data.service}\``);
      } else if (!stripCode(svc.body).includes(`[[${f.name}]]`)) {
        relationIssues.push(`[[${svc.name}]]：模块页正文漏列其负责的功能 [[${f.name}]]`);
      }
    }
    for (const c of f.data.crud || []) {
      const [rawT, rawOp = ''] = String(c).split(':').map((s) => s.trim());
      if (!rawT) continue;
      if (!rawOp || !/^[CRUD]+$/.test(rawOp)) {
        relationIssues.push(`[[${f.name}]]：CRUD 声明格式异常 \`${c}\`（应如 \`T_XXX:CRU\`）`);
      }
      const tp = entityByName.get(rawT);
      if (!tp || tp.data.type !== 'table') {
        relationIssues.push(`[[${f.name}]]：CRUD 引用了不存在的表页面 \`${rawT}\``);
      } else if (!stripCode(tp.body).includes(`[[${f.name}]]`)) {
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
    for (const item of f.data.error_codes || []) {
      const code = String(item).split(':')[0].trim();
      if (!code) continue;
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

  // 5. 文档摄入、Git 同步状态与临时规则时效检查
  const ingested = new Set(sources.filter((s) => s.data.status !== 'deleted').map((s) => s.data.doc_path));
  const notIngested = listDocs().filter((d) => !ingested.has(d));
  const stale = [];
  for (const s of sources.filter((x) => x.data.status !== 'deleted')) {
    const fullDocPath = path.join(DOCS, s.data.doc_path || '');
    if (!s.data.doc_path || !fs.existsSync(fullDocPath)) {
      stale.push(`[[${s.name}]]：原文档 \`${s.data.doc_path}\` 已不存在，需同步标为 deleted`);
      continue;
    }
    const headFull = docCommitFull(s.data.doc_path);
    if (headFull && !sameCommit(headFull, s.data.doc_commit)) {
      stale.push(`[[${s.name}]]：wiki 基于 \`${s.data.doc_commit}\`，原文档已更新到 \`${headFull.slice(0, 7)}\``);
    }
  }

  const todayStr = today();
  const expiredActive = pages.filter(
    (p) => p.data.valid_until && String(p.data.valid_until) < todayStr && p.data.status === 'active',
  );

  // 6. 冲突与待修订文档债分层汇总
  const contestedPages = entities.filter((p) => ['contested', 'needs-review'].includes(p.data.status));
  const pendingDocPages = entities.filter((p) => p.data.status === 'pending-doc');
  const openQs = pages.filter((p) => p.data.type === 'question' && p.data.status === 'open');
  const decidedQs = pages.filter((p) => p.data.type === 'question' && p.data.status === 'decided');

  const sections = [
    ['Frontmatter 语法与必填字段错误', schemaErrors],
    ['同名冲突（Wiki 页面或跨目录原文档）', nameCollisions],
    ['断链', [...broken]],
    ['孤立页面（无入站链接的知识页）', orphans.map((p) => link(p.name))],
    ['没有有效来源的实体页', noSource.map((p) => link(p.name))],
    ['CRUD / 服务归属 / 错误码一致性问题', relationIssues],
    ['尚未摄入的文档', notIngested.map((d) => `\`${d}\``)],
    ['过期未同步页面（原文档有新提交或已删除）', stale],
    [
      '已到期未归档的临时规则/文档（valid_until 已过期但仍为 active）',
      expiredActive.map((p) => `${link(p.name)}（有效期至 \`${p.data.valid_until}\`）`),
    ],
    ['缺少表定义的表（仅在设计中出现，无表定义文档）', noTableDef.map((p) => link(p.name))],
    ['待拍板的冲突实体页（contested / needs-review）', contestedPages.map((p) => `${link(p.name)} \`${p.data.status}\``)],
    ['待拍板的跨文档问题（open）', openQs.map((p) => `${link(p.name)} — ${p.data.summary || ''}`)],
    ['已决议但原文档待修订（pending-doc / decided）', [
      ...decidedQs.map((p) => `${link(p.name)} \`decided\` — ${p.data.summary || ''}`),
      ...pendingDocPages.map((p) => `${link(p.name)} \`pending-doc\``),
    ]],
  ];

  let md = `---\ntype: "report"\nupdated: "${now()}"\n---\n\n# lint报告\n\n> 由 \`scripts/lint.mjs\` 生成于 ${now()}。结构、Schema、时效与双向引用由脚本自动校验；跨文档语义矛盾由 Agent 在 ingest/sync 时识别并记录到 \`wiki/questions/\`。\n\n| 检查项 | 数量 |\n|---|---|\n`;
  md += sections.map(([t, l]) => `| ${t} | ${l.length} |`).join('\n');
  for (const [t, l] of sections) {
    if (l.length) md += `\n\n## ${t}\n${l.map((x) => `- ${x}`).join('\n')}`;
  }
  const f = path.join(ROOT, 'wiki/_reports/lint报告.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${md}\n`, 'utf8');
  return sections.map(([t, l]) => [t, l.length]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [t, n] of lint()) console.log(`${n ? '⚠' : '✓'} ${t}：${n}`);
  console.log('详细报告：wiki/_reports/lint报告.md');
}
