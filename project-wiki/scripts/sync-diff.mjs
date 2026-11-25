// 纯脚本（0 token）：对比 .sync-state.json 水位线与最新文档版本，输出变更清单并准备文档工作区
// 用法：
//   node scripts/sync-diff.mjs [--since=<rev>] [--to=<rev>] [--no-checkout]
//   node scripts/sync-diff.mjs --advance [--to=<rev>]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DOCS, config, flags, flagValue, readSyncState, writeSyncState } from './lib/config.mjs';
import { git, tryGit } from './lib/git.mjs';
import { isExcluded, docCommit, sameCommit } from './lib/docs.mjs';
import { loadAll, link, unlink } from './lib/pages.mjs';

const short = (r) => String(r || '').slice(0, 7);
if (!fs.existsSync(DOCS)) {
  console.error(`错误：找不到设计文档目录 "${config.docsDir}"（解析路径：${DOCS}）。\n请先在 project-wiki/wiki.config.json 中将 docsDir 指向你的项目设计文档目录。`);
  process.exit(1);
}
const isAncestor = (anc, desc) => tryGit(['merge-base', '--is-ancestor', anc, desc], DOCS) !== null;
const resolveRev = (ref) => (ref ? (tryGit(['rev-parse', '--verify', `${ref}^{commit}`], DOCS) || '').trim() : '');

// 1. 若配置了远程仓库则尝试拉取（离线或沙箱环境下失败不阻塞本地对比）
const hasRemote = Boolean((tryGit(['remote'], DOCS) || '').trim());
if (hasRemote && !flags.has('--no-fetch')) {
  if (tryGit(['fetch', '-q', 'origin'], DOCS) === null) {
    console.warn('提示：git fetch origin 未成功，将基于本地已有提交计算变更。');
  }
}

// 2. 解析目标最新版本 newRev（兼容 submodule 游离 HEAD、本地分支提交、同仓目录）
function resolveTargetRev() {
  const explicitTo = resolveRev(flagValue('to'));
  if (explicitTo) return explicitTo;

  let target = resolveRev('HEAD');
  const branchRef = config.docsBranch || 'main';
  for (const candRef of [`origin/${branchRef}`, branchRef]) {
    const cand = resolveRev(candRef);
    if (cand && (!target || (cand !== target && isAncestor(target, cand)))) {
      target = cand;
    }
  }
  return target;
}

// 3. 解析上次同步水位线 oldRev（优先 --since，其次 .sync-state.json，最后回退 HEAD）
function resolveBaseRev() {
  const explicitSince = resolveRev(flagValue('since'));
  if (explicitSince) return explicitSince;

  const state = readSyncState();
  const stateRev = resolveRev(state?.lastSyncedCommit);
  if (stateRev) return stateRev;

  return resolveRev('HEAD');
}

const oldRev = resolveBaseRev();
const newRev = resolveTargetRev();

if (!newRev) {
  console.error('错误：无法解析设计文档仓库的 Git 提交，请检查 docsDir 配置。');
  process.exit(1);
}

// 将独立文档仓库/submodule 切到目标版本（若原文档与主工程同仓且为子目录，则不擅自切换分支）
function checkoutDocsIfStandalone(rev) {
  const head = resolveRev('HEAD');
  if (head === rev) return true;
  const prefix = (tryGit(['rev-parse', '--show-prefix'], DOCS) || '').trim();
  if (prefix) return false;
  const dirty = (tryGit(['status', '--porcelain'], DOCS) || '').trim();
  if (dirty) {
    console.warn(`提示：${config.docsDir} 存在未提交改动，跳过自动切换工作区。`);
    return false;
  }
  git(['checkout', '-q', rev], DOCS);
  return true;
}

if (flags.has('--advance')) {
  checkoutDocsIfStandalone(newRev);
  writeSyncState(newRev);
  console.log(`同步水位线已推进到 ${short(newRev)}（已记录至 .sync-state.json）`);
  process.exit(0);
}

if (sameCommit(oldRev, newRev)) {
  if (!readSyncState()) writeSyncState(newRev);
  console.log(`已是最新（${short(newRev)}），无需同步。`);
  process.exit(0);
}

// 预先把独立文档库切到 newRev，确保后续 Agent 能直接读取新增/修改后的新全文；
// 由于 .sync-state.json 尚未推进，重复运行本脚本完全幂等。
if (!flags.has('--no-checkout')) {
  checkoutDocsIfStandalone(newRev);
}

const pages = loadAll();
const srcByPath = new Map(
  pages.filter((p) => p.data.type === 'source' && p.data.status !== 'deleted').map((p) => [p.data.doc_path, p]),
);
const affectedOf = (docPath) => {
  const s = srcByPath.get(docPath);
  if (!s) return [];
  return pages
    .filter((p) => p.data.type !== 'source' && (p.data.sources || []).map(unlink).includes(s.name))
    .map((p) => p.name);
};

const LABEL = { A: '新增', M: '修改', D: '删除', R: '重命名', T: '仅格式变化（仅更新 doc_commit）' };
const lines = [
  `# Sync ${short(oldRev)}..${short(newRev)}`,
  '',
  `> 查看单篇改动命令：\`git -C project-wiki/${config.docsDir} diff -w ${short(oldRev)} ${short(newRev)} -- "<doc_path>"\``,
  '',
];

const diffOut = git(['diff', '--relative', '--name-status', '-M', oldRev, newRev], DOCS);
let count = 0;
for (const line of diffOut.split('\n').filter(Boolean)) {
  const [status, ...paths] = line.split('\t');
  const p = paths.at(-1);
  if (!p.endsWith('.md') || isExcluded(p)) continue;
  count++;
  let kind = status[0];
  if (kind === 'M') {
    const sig = git(['diff', '--relative', '-w', '--ignore-blank-lines', '--numstat', oldRev, newRev, '--', p], DOCS).trim();
    const [add = '0', del = '0'] = sig.split('\t');
    if (!sig || (add === '0' && del === '0')) kind = 'T';
  }
  const from = paths.length > 1 ? paths[0] : '';
  const srcPage = srcByPath.get(from || p);
  const refs = affectedOf(from || p);
  const fileCommit = kind === 'D' ? short(newRev) : docCommit(p, newRev);
  const parts = [`- [${LABEL[kind] || kind}] ${from ? `\`${from}\` → ` : ''}\`${p}\` (doc_commit: \`${fileCommit}\`)`];
  if (srcPage) parts.push(`摘要页：${link(srcPage.name)}`);
  if (refs.length) parts.push(`受影响页面：${refs.map(link).join('、')}`);
  lines.push(parts.join(' | '));
}

if (!count) {
  lines.push('- （本次提交区间内无受监控的设计文档变更，可直接运行 `--advance` 推进水位线）');
}

const out = `${lines.join('\n')}\n`;
fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.cache/changes.md'), out, 'utf8');
console.log(out);
