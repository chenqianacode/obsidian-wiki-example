import fs from 'node:fs';
import path from 'node:path';
import { DOC_SOURCES, MULTI_DOCS, EXTENSIONS, config } from './config.mjs';
import { tryGit } from './git.mjs';

const gitInfoCache = new Map();

export function getSourceGitInfo(source) {
  if (!source) return { exists: false, isGit: false, topLevel: '', prefix: '', isStandalone: false };
  if (gitInfoCache.has(source.absPath)) return gitInfoCache.get(source.absPath);

  const exists = fs.existsSync(source.absPath);
  if (!exists) {
    const info = { exists: false, isGit: false, topLevel: '', prefix: '', isStandalone: false };
    gitInfoCache.set(source.absPath, info);
    return info;
  }

  const topRaw = tryGit(['rev-parse', '--show-toplevel'], source.absPath);
  if (!topRaw) {
    const info = { exists: true, isGit: false, topLevel: '', prefix: '', isStandalone: false };
    gitInfoCache.set(source.absPath, info);
    return info;
  }

  const topLevel = path.resolve(topRaw.trim());
  const prefix = (tryGit(['rev-parse', '--show-prefix'], source.absPath) || '').trim();
  const info = { exists: true, isGit: true, topLevel, prefix, isStandalone: prefix === '' };
  gitInfoCache.set(source.absPath, info);
  return info;
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export function isExcluded(f, sourceId = '') {
  const norm = String(f).replace(/\\/g, '/').replace(/^\.\//, '');
  const base = path.posix.basename(norm);

  return (config.exclude || []).some((rawPattern) => {
    let pat = String(rawPattern || '').trim().replace(/\\/g, '/');
    if (!pat) return false;

    // 支持 sourceId:pattern 仅对指定文档目录生效
    const colonIdx = pat.indexOf(':');
    if (colonIdx > 0 && !pat.slice(0, colonIdx).includes('/')) {
      const targetId = pat.slice(0, colonIdx);
      if (sourceId && targetId !== sourceId) return false;
      if (!sourceId && DOC_SOURCES.some((s) => s.id === targetId)) return false;
      pat = pat.slice(colonIdx + 1);
    }

    // 显式根相对匹配：./README.md 或 /README.md 仅排除目录根下该文件
    if (pat.startsWith('./') || pat.startsWith('/')) {
      const rootPat = pat.replace(/^(\.\/|\/)+/, '');
      if (rootPat.endsWith('/')) return norm.startsWith(rootPat);
      if (rootPat.includes('*')) return globToRegExp(rootPat).test(norm);
      return norm === rootPat;
    }

    // 目录前缀：archive/ 匹配根目录及任意子目录中的 archive/
    if (pat.endsWith('/')) {
      return norm.startsWith(pat) || norm.includes(`/${pat}`);
    }

    // 通配符 glob：*.draft.md、**/temp/**
    if (pat.includes('*')) {
      const re = globToRegExp(pat);
      return re.test(norm) || (!pat.includes('/') && re.test(base));
    }

    // 含路径分隔符：按完整相对路径匹配；纯文件名：按 basename 匹配
    return pat.includes('/') ? norm === pat : base === pat;
  });
}

export function hasAllowedExtension(f) {
  const lower = String(f).toLowerCase();
  return EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isDocIncluded(relPath, sourceId = '') {
  return Boolean(relPath) && hasAllowedExtension(relPath) && !isExcluded(relPath, sourceId);
}

export function formatDocPath(source, relPath) {
  const normRel = String(relPath).replace(/\\/g, '/');
  return MULTI_DOCS ? `${source.id}:${normRel}` : normRel;
}

export function parseDocPath(docPath) {
  const raw = String(docPath || '').trim().replace(/\\/g, '/');
  if (!raw) return null;

  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0 && !raw.slice(0, colonIdx).includes('/')) {
    const id = raw.slice(0, colonIdx);
    const source = DOC_SOURCES.find((s) => s.id === id);
    if (source) {
      const relPath = raw.slice(colonIdx + 1);
      return { source, relPath, docPath: formatDocPath(source, relPath), absPath: path.join(source.absPath, relPath) };
    }
  }

  // 单目录模式或从单目录升级多目录时的旧无前缀 doc_path 兜底
  if (DOC_SOURCES.length === 1) {
    const source = DOC_SOURCES[0];
    return { source, relPath: raw, docPath: formatDocPath(source, raw), absPath: path.join(source.absPath, raw) };
  }
  for (const source of DOC_SOURCES) {
    const candidate = path.join(source.absPath, raw);
    if (fs.existsSync(candidate)) {
      return { source, relPath: raw, docPath: formatDocPath(source, raw), absPath: candidate, legacyUnprefixed: true };
    }
  }
  const fallback = DOC_SOURCES[0];
  if (!fallback) return null;
  return { source: fallback, relPath: raw, docPath: raw, absPath: path.join(fallback.absPath, raw), legacyUnprefixed: true };
}

export function byOrder(a, b) {
  const o = config.order || [];
  const docPathA = typeof a === 'string' ? a : a.docPath;
  const docPathB = typeof b === 'string' ? b : b.docPath;
  const relA = typeof a === 'string' ? a : a.relPath;
  const relB = typeof b === 'string' ? b : b.relPath;

  const rank = (docPath, relPath) => {
    const i = o.findIndex((x) => docPath.startsWith(x) || relPath.startsWith(x));
    return i < 0 ? 99 : i;
  };
  return rank(docPathA, relA) - rank(docPathB, relB) || docPathA.localeCompare(docPathB, 'zh');
}

export function listDocsForSource(source, rev) {
  const info = getSourceGitInfo(source);
  if (!info.exists || !info.isGit) return [];
  const out = rev
    ? tryGit(['ls-tree', '-r', '--name-only', rev, '.'], source.absPath)
    : tryGit(['ls-files'], source.absPath);
  if (!out) return [];
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((relPath) => isDocIncluded(relPath, source.id))
    .map((relPath) => ({
      source,
      relPath,
      docPath: formatDocPath(source, relPath),
      absPath: path.join(source.absPath, relPath),
      displayPath: `${source.relFromProject}/${relPath}`.replace(/\/+/g, '/'),
    }))
    .sort(byOrder);
}

export function listAllDocs() {
  return DOC_SOURCES.flatMap((source) => listDocsForSource(source)).sort(byOrder);
}

export function listDocs(rev) {
  if (rev && DOC_SOURCES.length === 1) {
    return listDocsForSource(DOC_SOURCES[0], rev).map((d) => d.docPath);
  }
  return listAllDocs().map((d) => d.docPath);
}

/**
 * 解析文档目录的当前有效 commit：
 * - 同仓子目录（!isStandalone）：取最近一次触及该目录的 commit（避免业务代码提交击穿水位线）
 * - 独立文档仓 / submodule（isStandalone）：取仓库 HEAD commit
 */
export function sourceHeadCommit(source, rev = 'HEAD') {
  const info = getSourceGitInfo(source);
  if (!info.exists || !info.isGit) return '';
  if (!info.isStandalone) {
    return (tryGit(['log', '-1', '--format=%H', rev, '--', '.'], source.absPath) || '').trim();
  }
  return (tryGit(['rev-parse', '--verify', `${rev}^{commit}`], source.absPath) || '').trim();
}

export function sourceDirtyFiles(source) {
  const info = getSourceGitInfo(source);
  if (!info.exists || !info.isGit) return [];
  const out = tryGit(['status', '--porcelain', '--', '.'], source.absPath) || '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawFile = line.slice(3).trim();
      const filePart = rawFile.includes(' -> ') ? rawFile.split(' -> ').at(-1) : rawFile;
      // status --porcelain 返回相对仓库根路径，去除 source prefix
      const rel = info.prefix && filePart.startsWith(info.prefix) ? filePart.slice(info.prefix.length) : filePart;
      return { code, rel };
    })
    .filter((item) => isDocIncluded(item.rel, source.id));
}

export function docCommitFull(docPath, rev = 'HEAD') {
  const parsed = parseDocPath(docPath);
  if (!parsed) return '';
  const info = getSourceGitInfo(parsed.source);
  if (!info.exists || !info.isGit) return '';
  return (tryGit(['log', '-1', '--format=%H', rev, '--', parsed.relPath], parsed.source.absPath) || '').trim();
}

export function docCommit(docPath, rev = 'HEAD') {
  return docCommitFull(docPath, rev).slice(0, 7);
}

export function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  if (!/^[0-9a-f]+$/.test(x) || !/^[0-9a-f]+$/.test(y)) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export function stripDocExt(filePath) {
  const base = path.posix.basename(String(filePath).replace(/\\/g, '/'));
  for (const ext of EXTENSIONS) {
    if (base.toLowerCase().endsWith(ext)) return base.slice(0, -ext.length);
  }
  return path.posix.basename(base, path.posix.extname(base));
}

export function findDocBasenameCollisions(docs = listAllDocs()) {
  const map = new Map();
  for (const entry of docs) {
    const rel = typeof entry === 'string' ? (parseDocPath(entry)?.relPath || entry) : entry.relPath;
    const docPath = typeof entry === 'string' ? entry : entry.docPath;
    const base = stripDocExt(rel);
    const arr = map.get(base) || [];
    arr.push(docPath);
    map.set(base, arr);
  }
  return [...map.entries()].filter(([, list]) => list.length > 1);
}

export function suggestSourcePageName(docEntry, allDocs = listAllDocs()) {
  const base = stripDocExt(docEntry.relPath);
  const sameBase = allDocs.filter((d) => stripDocExt(d.relPath) === base);
  const clean = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '_').replace(/\s+/g, ' ').trim();
  if (sameBase.length <= 1) return `src-${clean(base)}`;

  const dirPart = path.posix.dirname(docEntry.relPath);
  const prefixParts = [];
  if (MULTI_DOCS) prefixParts.push(docEntry.source.id);
  if (dirPart && dirPart !== '.') prefixParts.push(dirPart.replace(/\//g, '-'));
  const prefix = prefixParts.length ? `${clean(prefixParts.join('-'))}-` : '';
  return `src-${prefix}${clean(base)}`;
}

export function readDoc(docPath) {
  const parsed = parseDocPath(docPath);
  if (!parsed) throw new Error(`无法解析文档路径：${docPath}`);
  return fs.readFileSync(parsed.absPath, 'utf8');
}
