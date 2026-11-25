import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROJECT_ROOT = path.resolve(ROOT, '..');
export const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'wiki.config.json'), 'utf8'));
export const WIKI = path.join(ROOT, 'wiki');
export const SYNC_STATE_FILE = path.join(ROOT, '.sync-state.json');

export const EXTENSIONS = (
  Array.isArray(config.extensions) && config.extensions.length ? config.extensions : ['.md']
).map((ext) => {
  const s = String(ext).trim().toLowerCase();
  return s.startsWith('.') ? s : `.${s}`;
});

function sanitizeId(raw) {
  return String(raw)
    .replace(/\\/g, '/')
    .replace(/^(\.\.\/|\.\/|\/)+/, '')
    .replace(/\/+$/, '')
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'docs';
}

function normalizeDocSources() {
  const rawList = config.docsDirs !== undefined ? config.docsDirs : config.docsDir;
  const items = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
  const defaultBranch = config.docsBranch || 'main';

  const parsed = items
    .map((item) => {
      if (typeof item === 'string') {
        return { rawPath: item, explicitId: '', branch: defaultBranch };
      }
      if (item && typeof item === 'object' && item.path) {
        return {
          rawPath: String(item.path),
          explicitId: item.id ? sanitizeId(item.id) : '',
          branch: item.branch || defaultBranch,
        };
      }
      return null;
    })
    .filter(Boolean)
    .map((entry) => {
      const absPath = path.resolve(ROOT, entry.rawPath);
      const relFromProject = path.relative(PROJECT_ROOT, absPath).replace(/\\/g, '/');
      const relFromWiki = path.relative(ROOT, absPath).replace(/\\/g, '/');
      const parts = path.normalize(absPath).split(path.sep).filter(Boolean);
      return {
        ...entry,
        absPath,
        relFromProject: relFromProject && !relFromProject.startsWith('..') ? relFromProject : absPath.replace(/\\/g, '/'),
        relFromWiki,
        _parts: parts,
      };
    });

  // 为未显式指定 id 的目录生成最短唯一 id（优先目录名，重名时向上补父目录段）
  const autoEntries = parsed.filter((e) => !e.explicitId);
  const usedIds = new Set(parsed.filter((e) => e.explicitId).map((e) => e.explicitId));

  // 先按 basename 分组检查冲突
  const baseCounts = new Map();
  for (const e of autoEntries) {
    const base = sanitizeId(e._parts.at(-1) || 'docs');
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
  }

  for (const e of parsed) {
    if (e.explicitId) {
      e.id = e.explicitId;
      continue;
    }
    let id = '';
    const base = sanitizeId(e._parts.at(-1) || 'docs');
    if (baseCounts.get(base) === 1 && !usedIds.has(base)) {
      id = base;
    } else {
      for (let depth = 2; depth <= e._parts.length; depth++) {
        const cand = sanitizeId(e._parts.slice(-depth).join('-'));
        if (!usedIds.has(cand)) {
          id = cand;
          break;
        }
      }
      if (!id) {
        let seq = 2;
        while (usedIds.has(`${base}-${seq}`)) seq++;
        id = `${base}-${seq}`;
      }
    }
    usedIds.add(id);
    e.id = id;
  }

  return parsed.map(({ _parts, ...rest }) => rest);
}

export const DOC_SOURCES = normalizeDocSources();
export const MULTI_DOCS = DOC_SOURCES.length > 1 || DOC_SOURCES.some((s) => Boolean(s.explicitId));
export const DOCS = DOC_SOURCES[0]?.absPath || path.resolve(ROOT, '../docs');

export function findOverlappingDocSources() {
  const overlaps = [];
  for (let i = 0; i < DOC_SOURCES.length; i++) {
    for (let j = i + 1; j < DOC_SOURCES.length; j++) {
      const a = DOC_SOURCES[i];
      const b = DOC_SOURCES[j];
      const relAB = path.relative(a.absPath, b.absPath);
      const relBA = path.relative(b.absPath, a.absPath);
      if (relAB === '' || (!relAB.startsWith('..') && !path.isAbsolute(relAB))) {
        overlaps.push([a, b]);
      } else if (!relBA.startsWith('..') && !path.isAbsolute(relBA)) {
        overlaps.push([b, a]);
      }
    }
  }
  return overlaps;
}

// 解析命令行参数：同时支持 --flag=val 与 --flag val（布尔开关不会误吞后续位置参数）
const VALUE_FLAGS = new Set(['type', 'limit', 'status', 'impact', 'since', 'to', 'source', 'format']);
const argv = process.argv.slice(2);
export const flags = new Set();
const flagValues = new Map();
export const args = [];

for (let i = 0; i < argv.length; i++) {
  const tok = argv[i];
  if (tok.startsWith('--')) {
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      const name = tok.slice(2, eq);
      flags.add(`--${name}`);
      flagValues.set(name, tok.slice(eq + 1));
    } else {
      const name = tok.slice(2);
      flags.add(tok);
      if (VALUE_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flagValues.set(name, argv[++i]);
      }
    }
  } else {
    args.push(tok);
  }
}

export function flagValue(name) {
  return flagValues.get(name);
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

export function getSourceSyncedCommit(state, source) {
  if (!state) return '';
  if (state.sources && typeof state.sources === 'object') {
    if (state.sources[source.id]?.lastSyncedCommit) return state.sources[source.id].lastSyncedCommit;
    const byDir = Object.values(state.sources).find(
      (entry) => entry && entry.dir && path.resolve(ROOT, entry.dir) === source.absPath,
    );
    if (byDir?.lastSyncedCommit) return byDir.lastSyncedCommit;
  }
  // 兼容旧版单目录 .sync-state.json（仅当单源或首个源时回退）
  if (!MULTI_DOCS && state.lastSyncedCommit) return state.lastSyncedCommit;
  return '';
}

export function writeSyncState(commitOrMap) {
  const prev = readSyncState();
  const prevSources = prev?.sources && typeof prev.sources === 'object' ? { ...prev.sources } : {};

  if (typeof commitOrMap === 'string') {
    const first = DOC_SOURCES[0];
    if (first) {
      prevSources[first.id] = { dir: first.rawPath, lastSyncedCommit: commitOrMap };
    }
    const state = MULTI_DOCS
      ? { version: 2, updatedAt: now(), sources: prevSources }
      : { version: 2, lastSyncedCommit: commitOrMap, updatedAt: now(), sources: prevSources };
    fs.writeFileSync(SYNC_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }

  for (const [id, commit] of Object.entries(commitOrMap || {})) {
    const src = DOC_SOURCES.find((s) => s.id === id);
    if (!src || !commit) continue;
    prevSources[id] = { dir: src.rawPath, lastSyncedCommit: commit };
  }

  const state = { version: 2, updatedAt: now(), sources: prevSources };
  if (!MULTI_DOCS && DOC_SOURCES[0] && prevSources[DOC_SOURCES[0].id]?.lastSyncedCommit) {
    state.lastSyncedCommit = prevSources[DOC_SOURCES[0].id].lastSyncedCommit;
  }
  fs.writeFileSync(SYNC_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}
