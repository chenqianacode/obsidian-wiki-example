import fs from 'node:fs';
import path from 'node:path';
import { DOCS, config } from './config.mjs';
import { git, tryGit } from './git.mjs';

export function isExcluded(f) {
  const norm = String(f).replace(/\\/g, '/');
  return (config.exclude || []).some((x) => norm === x || path.posix.basename(norm) === x);
}

export function byOrder(a, b) {
  const o = config.order || [];
  const rank = (s) => {
    const i = o.findIndex((x) => s.startsWith(x));
    return i < 0 ? 99 : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b, 'zh');
}

export function listDocs(rev) {
  if (!fs.existsSync(DOCS)) return [];
  const out = rev ? tryGit(['ls-tree', '-r', '--name-only', rev, '.'], DOCS) : tryGit(['ls-files'], DOCS);
  if (!out) return [];
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.md') && !isExcluded(f))
    .sort(byOrder);
}

export function docCommitFull(docPath, rev = 'HEAD') {
  if (!fs.existsSync(DOCS)) return '';
  return (tryGit(['log', '-1', '--format=%H', rev, '--', docPath], DOCS) || '').trim();
}

export function docCommit(docPath, rev = 'HEAD') {
  return docCommitFull(docPath, rev).slice(0, 7);
}

export function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

export function findDocBasenameCollisions(docs = listDocs()) {
  const map = new Map();
  for (const d of docs) {
    const base = path.posix.basename(d, '.md');
    const arr = map.get(base) || [];
    arr.push(d);
    map.set(base, arr);
  }
  return [...map.entries()].filter(([, list]) => list.length > 1);
}

export function readDoc(docPath) {
  return fs.readFileSync(path.join(DOCS, docPath), 'utf8');
}
