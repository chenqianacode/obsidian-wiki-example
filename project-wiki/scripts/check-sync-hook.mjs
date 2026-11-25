// SessionStart Hook（0-token，纯本地快检，不执行 git fetch）：
// 对比当前文档仓库 commit 与 .sync-state.json 水位线；若不一致，输出提醒文本注入会话上下文，要求 Agent 先向用户确认是否同步 Wiki。
// 用法：node project-wiki/scripts/check-sync-hook.mjs [--since=<rev>]
import fs from 'node:fs';
import { DOCS, config, flagValue, readSyncState } from './lib/config.mjs';
import { tryGit } from './lib/git.mjs';
import { isExcluded, sameCommit } from './lib/docs.mjs';

if (!fs.existsSync(DOCS)) process.exit(0);

const short = (r) => String(r || '').slice(0, 7);
const resolveRev = (ref) => (ref ? (tryGit(['rev-parse', '--verify', `${ref}^{commit}`], DOCS) || '').trim() : '');

const currentHead = resolveRev('HEAD');
if (!currentHead) process.exit(0);

const state = readSyncState();
const syncedRev = resolveRev(flagValue('since') || state?.lastSyncedCommit);

// 水位线一致：静默退出，不打扰会话
if (syncedRev && sameCommit(syncedRev, currentHead)) {
  process.exit(0);
}

// 未初始化水位线
if (!syncedRev) {
  console.log(
    [
      `[Wiki 同步提醒] 尚未记录同步水位线（project-wiki/.sync-state.json 缺失或无效），当前设计文档 commit 为 ${short(currentHead)}。`,
      `请在开始工作前先向用户确认：是否需要先执行 wiki-ingest / wiki-sync 初始化并同步知识库？（在用户确认前不要擅自执行同步）`,
    ].join('\n'),
  );
  process.exit(0);
}

// 统计变更的受监控 .md 设计文档
const diffOut = tryGit(['diff', '--relative', '--name-status', '-M', syncedRev, currentHead], DOCS) || '';
const changedDocs = [];
for (const line of diffOut.split('\n').filter(Boolean)) {
  const [status, ...paths] = line.split('\t');
  const p = paths.at(-1);
  if (!p || !p.endsWith('.md') || isExcluded(p)) continue;
  changedDocs.push(`${status[0]} ${p}`);
}

const header = `[Wiki 同步提醒] 检测到设计文档当前 commit (${short(currentHead)}) 与上次同步水位线 (${short(syncedRev)}) 不一致。`;
const detail = changedDocs.length
  ? `涉及 ${changedDocs.length} 篇设计文档变更：${changedDocs.slice(0, 8).join('、')}${changedDocs.length > 8 ? ` 等共 ${changedDocs.length} 篇` : ''}。`
  : `当前区间内无受监控的 .md 设计文档变更（仅其他文件提交或水位线落后，可直接跳过或推进水位线）。`;
const action = `请在回复用户时，优先简短向用户确认：是否需要先运行 wiki-sync 同步 project-wiki？（在用户明确同意前不要擅自执行同步或修改 wiki）`;

console.log(`${header}\n${detail}\n${action}`);
