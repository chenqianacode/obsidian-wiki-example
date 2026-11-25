// SessionStart Hook（0-token，纯本地快检，不执行 git fetch）：
// 对比各文档目录当前有效 commit 与 .sync-state.json 水位线；仅当存在真实受监控文档变更或未初始化文档时才提醒。
// 用法：node project-wiki/scripts/check-sync-hook.mjs [--since=<rev>] [--format=text|gemini]
import { DOC_SOURCES, MULTI_DOCS, flagValue, readSyncState, getSourceSyncedCommit } from './lib/config.mjs';
import { tryGit } from './lib/git.mjs';
import {
  getSourceGitInfo,
  isDocIncluded,
  formatDocPath,
  listDocsForSource,
  sourceHeadCommit,
  sameCommit,
} from './lib/docs.mjs';

const format = (flagValue('format') || 'text').toLowerCase();
const short = (r) => String(r || '').slice(0, 7);

function emitAndExit(message = '') {
  if (format === 'gemini') {
    if (!message) {
      console.log('{}');
    } else {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: message,
          },
        }),
      );
    }
  } else if (message) {
    console.log(message);
  }
  process.exit(0);
}

const resolveRev = (source, ref) =>
  ref ? (tryGit(['rev-parse', '--verify', `${ref}^{commit}`], source.absPath) || '').trim() : '';

const state = readSyncState();
const explicitSince = flagValue('since');
const uninitNotices = [];
const changedDocs = [];
const divergedSources = [];

for (const source of DOC_SOURCES) {
  const info = getSourceGitInfo(source);
  if (!info.exists || !info.isGit) continue;

  const currentHead = sourceHeadCommit(source, 'HEAD');
  if (!currentHead) continue;

  const syncedRaw = explicitSince || getSourceSyncedCommit(state, source);
  const syncedRev = resolveRev(source, syncedRaw);

  if (syncedRev && sameCommit(syncedRev, currentHead)) continue;

  if (!syncedRev) {
    const docs = listDocsForSource(source);
    if (!docs.length) continue;
    uninitNotices.push(`${MULTI_DOCS ? `[${source.id}] ` : ''}${docs.length} 篇文档（commit ${short(currentHead)}）`);
    continue;
  }

  if (tryGit(['merge-base', '--is-ancestor', syncedRev, currentHead], source.absPath) === null) {
    divergedSources.push(`${source.id}(${short(syncedRev)}..${short(currentHead)})`);
  }

  const diffOut = tryGit(['diff', '--relative', '--name-status', '-M', syncedRev, currentHead, '--', '.'], source.absPath) || '';
  for (const line of diffOut.split('\n').filter(Boolean)) {
    const [statusRaw, ...paths] = line.split('\t');
    const code = statusRaw[0];

    if (code === 'R') {
      const [fromRel, toRel] = paths;
      const fromIn = isDocIncluded(fromRel, source.id);
      const toIn = isDocIncluded(toRel, source.id);
      if (fromIn && toIn) changedDocs.push(`R ${formatDocPath(source, toRel)}`);
      else if (fromIn) changedDocs.push(`D ${formatDocPath(source, fromRel)}`);
      else if (toIn) changedDocs.push(`A ${formatDocPath(source, toRel)}`);
      continue;
    }

    const p = paths.at(-1);
    if (!isDocIncluded(p, source.id)) continue;
    changedDocs.push(`${code === 'C' ? 'A' : code} ${formatDocPath(source, p)}`);
  }
}

// 没有任何未初始化文档且没有任何受监控文档变更：完全静默退出，不打扰会话
if (!uninitNotices.length && !changedDocs.length) {
  emitAndExit('');
}

const msgParts = [];
if (uninitNotices.length) {
  msgParts.push(
    `[Wiki 同步提醒] 尚未记录同步水位线（project-wiki/.sync-state.json 缺失或未覆盖全部文档源），检测到：${uninitNotices.join('；')}。`,
  );
}
if (changedDocs.length) {
  msgParts.push(
    `[Wiki 同步提醒] 检测到 ${changedDocs.length} 篇受监控设计文档有未同步提交：${changedDocs.slice(0, 8).join('、')}${
      changedDocs.length > 8 ? ` 等共 ${changedDocs.length} 篇` : ''
    }。`,
  );
}
if (divergedSources.length) {
  msgParts.push(`注意：以下文档源的水位线与当前提交存在分叉/rebase：${divergedSources.join('、')}。`);
}
msgParts.push(
  `请在回复用户时，优先简短向用户确认：是否需要先执行 ${
    uninitNotices.length && !changedDocs.length ? 'wiki-ingest / wiki-sync 初始化并同步' : 'wiki-sync 同步'
  } project-wiki？（在用户明确同意前不要擅自执行同步或修改 wiki）`,
);

emitAndExit(msgParts.join('\n'));
