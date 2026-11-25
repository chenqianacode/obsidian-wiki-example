import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'wiki.config.json'), 'utf8'));
export const DOCS = path.join(ROOT, config.docsDir);
export const WIKI = path.join(ROOT, 'wiki');
export const SYNC_STATE_FILE = path.join(ROOT, '.sync-state.json');

const argv = process.argv.slice(2);
export const args = argv.filter((a) => !a.startsWith('--'));
export const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
export function flagValue(name) {
  const prefix = `--${name}=`;
  return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const pad = (n) => String(n).padStart(2, '0');
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function now() {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function readSyncState() {
  if (!fs.existsSync(SYNC_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSyncState(commit) {
  const state = { lastSyncedCommit: commit, updatedAt: now() };
  fs.writeFileSync(SYNC_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}
