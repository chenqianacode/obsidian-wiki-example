// 纯脚本（0 token）：对比 .sync-state.json 水位线与最新文档版本，支持单目录与多目录（同仓多目录 / 多仓库）
// 用法：
//   node scripts/sync-diff.mjs [--source=<id>] [--since=<rev>] [--to=<rev>] [--no-fetch] [--no-checkout]
//   node scripts/sync-diff.mjs --pending [--limit=10] [--source=<id>]
//   node scripts/sync-diff.mjs --advance [--source=<id>] [--to=<rev>] [--force]
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  DOC_SOURCES,
  MULTI_DOCS,
  flags,
  flagValue,
  readSyncState,
  getSourceSyncedCommit,
  writeSyncState,
  findOverlappingDocSources,
} from './lib/config.mjs';
import { git, tryGit } from './lib/git.mjs';
import {
  getSourceGitInfo,
  isDocIncluded,
  formatDocPath,
  parseDocPath,
  listDocsForSource,
  listAllDocs,
  sourceHeadCommit,
  sourceDirtyFiles,
  docCommit,
  docCommitFull,
  sameCommit,
  suggestSourcePageName,
} from './lib/docs.mjs';
import { loadAll, link, unlink } from './lib/pages.mjs';

const short = (r) => String(r || '').slice(0, 7);
const targetSourceId = flagValue('source') || '';
const activeSources = targetSourceId ? DOC_SOURCES.filter((s) => s.id === targetSourceId) : DOC_SOURCES;

if (!activeSources.length) {
  console.error(
    targetSourceId
      ? `错误：找不到名为 "${targetSourceId}" 的文档源（已配置：${DOC_SOURCES.map((s) => s.id).join('、') || '无'}）。`
      : `错误：wiki.config.json 未配置有效的 docsDir / docsDirs。`,
  );
  process.exit(1);
}

const overlaps = findOverlappingDocSources();
if (overlaps.length) {
  for (const [parent, child] of overlaps) {
    console.warn(`⚠ 警告：文档目录配置存在嵌套重叠：${parent.id} (${parent.rawPath}) 包含 ${child.id} (${child.rawPath})，可能导致重复摄入。`);
  }
}

const resolveRev = (source, ref) =>
  ref ? (tryGit(['rev-parse', '--verify', `${ref}^{commit}`], source.absPath) || '').trim() : '';
const isAncestor = (source, anc, desc) => tryGit(['merge-base', '--is-ancestor', anc, desc], source.absPath) !== null;

function resolveTargetRev(source, info) {
  const explicitTo = flagValue('to');
  if (explicitTo) {
    return info.isStandalone ? resolveRev(source, explicitTo) : sourceHeadCommit(source, explicitTo);
  }

  // 同仓子目录：严格以本地工作区 HEAD 对应目录最新提交为准，不擅自 fetch/切到 origin/<branch>，避免“diff 读远程但正文读本地旧文件”
  if (!info.isStandalone) {
    return sourceHeadCommit(source, 'HEAD');
  }

  // 独立文档仓 / submodule：允许尝试 fetch 并跟踪远端快进分支
  const hasRemote = Boolean((tryGit(['remote'], source.absPath) || '').trim());
  if (hasRemote && !flags.has('--no-fetch')) {
    if (tryGit(['fetch', '-q', 'origin'], source.absPath) === null) {
      console.warn(`提示：[${source.id}] git fetch origin 未成功，将基于本地已有提交计算变更。`);
    }
  }

  let target = resolveRev(source, 'HEAD');
  const branchRef = source.branch || 'main';
  for (const candRef of [`origin/${branchRef}`, branchRef]) {
    const cand = resolveRev(source, candRef);
    if (cand && (!target || (cand !== target && isAncestor(source, target, cand)))) {
      target = cand;
    }
  }
  return target;
}

function checkoutDocsIfStandalone(source, info, rev) {
  if (!info.isStandalone || !rev) return false;
  const head = resolveRev(source, 'HEAD');
  if (head === rev) return true;
  const dirty = (tryGit(['status', '--porcelain'], source.absPath) || '').trim();
  if (dirty) {
    console.warn(`提示：[${source.id}] (${source.rawPath}) 存在未提交改动，跳过自动切换工作区。`);
    return false;
  }
  git(['checkout', '-q', rev], source.absPath);
  return true;
}

function classifyDiffChanges(source, oldRev, newRev) {
  const diffOut = git(['diff', '--relative', '--name-status', '-M', oldRev, newRev, '--', '.'], source.absPath);
  const items = [];

  for (const line of diffOut.split('\n').filter(Boolean)) {
    const [statusRaw, ...paths] = line.split('\t');
    const code = statusRaw[0];

    if (code === 'R') {
      const [fromRel, toRel] = paths;
      const fromIn = isDocIncluded(fromRel, source.id);
      const toIn = isDocIncluded(toRel, source.id);
      if (!fromIn && !toIn) continue;
      if (fromIn && !toIn) {
        items.push({ kind: 'D', relPath: fromRel, fromRel: '' });
      } else if (!fromIn && toIn) {
        items.push({ kind: 'A', relPath: toRel, fromRel: '' });
      } else {
        items.push({ kind: 'R', relPath: toRel, fromRel });
      }
      continue;
    }

    if (code === 'C') {
      const toRel = paths.at(-1);
      if (!isDocIncluded(toRel, source.id)) continue;
      items.push({ kind: 'A', relPath: toRel, fromRel: '' });
      continue;
    }

    const relPath = paths.at(-1);
    if (!isDocIncluded(relPath, source.id)) continue;

    let kind = code;
    if (kind === 'M') {
      const sig = git(
        ['diff', '--relative', '-w', '--ignore-blank-lines', '--numstat', oldRev, newRev, '--', relPath],
        source.absPath,
      ).trim();
      const [add = '0', del = '0'] = sig.split('\t');
      if (!sig || (add === '0' && del === '0')) kind = 'W';
    }
    items.push({ kind, relPath, fromRel: '' });
  }
  return items;
}

const pages = loadAll();
const activeSrcPages = pages.filter((p) => p.data.type === 'source' && p.data.status !== 'deleted');
const srcByDocPath = new Map();
for (const sp of activeSrcPages) {
  const parsed = parseDocPath(sp.data.doc_path);
  const canonical = parsed ? parsed.docPath : sp.data.doc_path;
  if (canonical) srcByDocPath.set(canonical, sp);
  if (sp.data.doc_path) srcByDocPath.set(sp.data.doc_path, sp);
}

// 模式 1：--pending（0-token 首次/分批摄入计划清单）
if (flags.has('--pending')) {
  const limit = Number(flagValue('limit') || 0);
  const allDocs = listAllDocs();
  const scopedDocs = targetSourceId ? allDocs.filter((d) => d.source.id === targetSourceId) : allDocs;
  const pending = scopedDocs.filter((d) => !srcByDocPath.has(d.docPath) && !srcByDocPath.has(d.relPath));

  if (!pending.length) {
    console.log('✓ 所有已跟踪的设计文档均已摄入，无待摄入文档。');
    process.exit(0);
  }

  const batch = limit > 0 ? pending.slice(0, limit) : pending;
  const lines = [
    `# 待摄入文档清单（本次展示 ${batch.length} / 共待摄入 ${pending.length} 篇）`,
    '',
    '> 按 `wiki.config.json` 的 `order` 排序；直接将每行给出的 `doc_path`、`doc_commit` 与建议 `src-` 页名写入摘要页。',
    '',
  ];
  for (const [i, d] of batch.entries()) {
    const commit = docCommit(d.docPath);
    const suggested = suggestSourcePageName(d, allDocs);
    lines.push(
      `${i + 1}. \`${d.docPath}\` | 读取路径：\`${d.displayPath}\` | \`doc_commit: "${commit}"\` | 建议摘要页：\`${suggested}.md\``,
    );
  }
  if (limit > 0 && pending.length > limit) {
    lines.push('', `> 还有 ${pending.length - limit} 篇未列出；处理完本批后再次运行 \`--pending\` 获取下一批。`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

// 模式 2：--advance（带分批防漏同步保护的水位线推进）
if (flags.has('--advance')) {
  const force = flags.has('--force');
  const toUpdate = {};
  const skipped = [];
  const advanced = [];

  for (const source of activeSources) {
    const info = getSourceGitInfo(source);
    if (!info.exists || !info.isGit) {
      skipped.push(`[${source.id}] 目录不存在或非 Git 仓库（${source.rawPath}）`);
      continue;
    }

    const newRev = resolveTargetRev(source, info);
    if (!newRev) {
      skipped.push(`[${source.id}] 目录尚无已提交文档历史`);
      continue;
    }

    if (!force) {
      const docs = listDocsForSource(source, newRev);
      const notIngested = docs.filter((d) => !srcByDocPath.has(d.docPath) && !srcByDocPath.has(d.relPath));
      const stale = [];
      for (const sp of activeSrcPages) {
        const parsed = parseDocPath(sp.data.doc_path);
        if (!parsed || parsed.source.id !== source.id) continue;
        const headFull = docCommitFull(parsed.docPath, newRev);
        if (!docs.some((d) => d.docPath === parsed.docPath)) {
          stale.push(`${sp.name}（原文档已删除）`);
        } else if (headFull && !sameCommit(headFull, sp.data.doc_commit)) {
          stale.push(`${sp.name}（${sp.data.doc_commit || '空'} → ${short(headFull)}）`);
        }
      }
      if (notIngested.length || stale.length) {
        const reasons = [];
        if (notIngested.length) reasons.push(`尚有 ${notIngested.length} 篇未摄入`);
        if (stale.length) reasons.push(`尚有 ${stale.length} 篇过期未同步`);
        skipped.push(`[${source.id}] ${reasons.join('、')}（完成全部摄入/同步后再推进，或加 --force 强制推进）`);
        continue;
      }
    }

    if (!flags.has('--no-checkout')) checkoutDocsIfStandalone(source, info, newRev);
    toUpdate[source.id] = newRev;
    advanced.push(`[${source.id}] → ${short(newRev)}`);
  }

  if (Object.keys(toUpdate).length) {
    writeSyncState(toUpdate);
    console.log(`同步水位线已推进：${advanced.join('，')}（已记录至 .sync-state.json）`);
  }
  if (skipped.length) {
    for (const msg of skipped) console.warn(`⚠ 跳过推进：${msg}`);
    if (!Object.keys(toUpdate).length) {
      console.log('提示：分批摄入期间无需提前推进全局水位线；请运行 `--pending` 继续处理剩余文档，全部完成后再执行 `--advance`。');
    }
  }
  process.exit(0);
}

// 模式 3：默认增量 diff 计算
const state = readSyncState();
const affectedOf = (docPath) => {
  const s = srcByDocPath.get(docPath);
  if (!s) return [];
  return pages
    .filter((p) => p.data.type !== 'source' && (p.data.sources || []).map(unlink).includes(s.name))
    .map((p) => p.name);
};

const LABEL = {
  A: '新增',
  M: '修改',
  D: '删除',
  R: '重命名',
  T: '类型变更',
  W: '仅格式变化（仅更新 doc_commit）',
};

const lines = ['# Sync 增量变更清单', ''];
let totalChanges = 0;
let validSourceCount = 0;
let initializedNewState = {};

for (const source of activeSources) {
  const info = getSourceGitInfo(source);
  if (!info.exists) {
    lines.push(`## [${source.id}] \`${source.rawPath}\``, '', `- ⚠ 错误：找不到设计文档目录（解析路径：\`${source.absPath}\`）`, '');
    continue;
  }
  if (!info.isGit) {
    lines.push(`## [${source.id}] \`${source.rawPath}\``, '', `- ⚠ 错误：目录不在 Git 仓库中，无法计算提交差异。`, '');
    continue;
  }
  validSourceCount++;

  const dirty = sourceDirtyFiles(source);
  const newRev = resolveTargetRev(source, info);
  if (!newRev) {
    lines.push(`## [${source.id}] \`${source.rawPath}\``, '', '- （该目录尚无已提交的文档记录）', '');
    continue;
  }

  const explicitSince = flagValue('since');
  const syncedRaw = explicitSince || getSourceSyncedCommit(state, source);
  const oldRev = syncedRaw ? resolveRev(source, syncedRaw) : '';

  const headerTitle = MULTI_DOCS
    ? `## [${source.id}] \`${source.relFromProject}\` (${oldRev ? short(oldRev) : '未初始化'}..${short(newRev)})`
    : `## ${short(oldRev || newRev)}..${short(newRev)}（\`${source.relFromProject}\`）`;
  lines.push(headerTitle, '');

  if (dirty.length) {
    lines.push(
      `> ⚠ 本地存在 ${dirty.length} 个未提交/未跟踪文档改动（Git diff 仅覆盖已提交版本）：${dirty
        .slice(0, 5)
        .map((d) => `\`${d.rel}\``)
        .join('、')}${dirty.length > 5 ? ' 等' : ''}`,
      '',
    );
  }

  if (!oldRev) {
    const docs = listDocsForSource(source, newRev);
    const pending = docs.filter((d) => !srcByDocPath.has(d.docPath) && !srcByDocPath.has(d.relPath));
    if (pending.length) {
      lines.push(
        `- ⚠ 尚未记录同步水位线，当前有 **${pending.length} 篇** 待首次摄入文档。请先运行 \`node project-wiki/scripts/sync-diff.mjs --pending${MULTI_DOCS ? ` --source=${source.id}` : ''}\` 并通过 \`wiki-ingest\` 完成摄入后再执行 \`--advance\`。`,
        '',
      );
      totalChanges += pending.length;
    } else {
      initializedNewState[source.id] = newRev;
      lines.push(`- 全部文档均已摄入，自动初始化水位线为 \`${short(newRev)}\`。`, '');
    }
    continue;
  }

  if (sameCommit(oldRev, newRev)) {
    lines.push(`- 已是最新（\`${short(newRev)}\`），无需同步。`, '');
    continue;
  }

  if (!isAncestor(source, oldRev, newRev)) {
    lines.push(
      `> ⚠ 注意：上次水位线 \`${short(oldRev)}\` 不是 \`${short(newRev)}\` 的祖先（可能发生过 rebase / 强推 / 切换分支），请仔细核对变更范围。`,
      '',
    );
  }

  // 独立文档仓库预先切到 newRev，同仓子目录不切换分支
  if (!flags.has('--no-checkout')) {
    checkoutDocsIfStandalone(source, info, newRev);
  }

  lines.push(
    `> 查看单篇改动命令：\`git -C "${source.relFromProject}" diff -w ${short(oldRev)} ${short(newRev)} -- "<rel_path>"\``,
    '',
  );

  const items = classifyDiffChanges(source, oldRev, newRev);
  if (!items.length) {
    lines.push('- （本次提交区间内无受监控的设计文档变更，可直接运行 `--advance` 推进水位线）', '');
    continue;
  }

  for (const item of items) {
    totalChanges++;
    const toDocPath = formatDocPath(source, item.relPath);
    const fromDocPath = item.fromRel ? formatDocPath(source, item.fromRel) : '';
    const lookupKey = fromDocPath || toDocPath;
    const srcPage = srcByDocPath.get(lookupKey) || srcByDocPath.get(item.fromRel || item.relPath);
    const refs = affectedOf(lookupKey);
    const fileCommit = item.kind === 'D' ? short(newRev) : docCommit(toDocPath, newRev);
    const displayFile = `${source.relFromProject}/${item.relPath}`.replace(/\/+/g, '/');

    const parts = [
      `- [${LABEL[item.kind] || item.kind}] ${fromDocPath ? `\`${fromDocPath}\` → ` : ''}\`${toDocPath}\` (doc_commit: \`${fileCommit}\`, 文件: \`${displayFile}\`)`,
    ];
    if (srcPage) parts.push(`摘要页：${link(srcPage.name)}`);
    if (refs.length) parts.push(`受影响页面：${refs.map(link).join('、')}`);
    lines.push(parts.join(' | '));
  }
  lines.push('');
}

if (!validSourceCount) {
  console.error(`错误：没有可用的 Git 设计文档目录，请检查 project-wiki/wiki.config.json 中的 docsDir / docsDirs 配置。`);
  process.exit(1);
}

if (Object.keys(initializedNewState).length) {
  writeSyncState(initializedNewState);
}

const out = `${lines.join('\n').trimEnd()}\n`;
fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.cache/changes.md'), out, 'utf8');
console.log(out);
