import fs from 'node:fs';
import path from 'node:path';
import { WIKI } from './config.mjs';
import { parse } from './fm.mjs';

export const ENTITY_TYPES = ['table', 'feature', 'module', 'term'];
export const TYPE_DIRS = {
  source: 'sources',
  table: 'tables',
  feature: 'features',
  module: 'modules',
  term: 'terms',
  question: 'questions',
  faq: 'faq',
};
export const TYPE_LABELS = {
  module: '模块 / 系统',
  feature: '功能',
  table: '表',
  term: '术语',
  source: '文档',
  question: '待确认问题',
  faq: 'FAQ',
};
export const VALID_STATUS = {
  source: ['active', 'expired', 'deleted'],
  table: ['active', 'draft', 'verified', 'contested', 'pending-doc', 'missing-def', 'needs-review'],
  feature: ['active', 'draft', 'verified', 'contested', 'pending-doc', 'needs-review'],
  module: ['active', 'draft', 'verified', 'contested', 'pending-doc', 'needs-review'],
  term: ['active', 'draft', 'verified', 'contested', 'pending-doc', 'needs-review'],
  question: ['open', 'decided', 'resolved'],
  faq: ['active', 'draft', 'verified', 'needs-review'],
};

export const safeName = (n) =>
  String(n).replace(/[\\/:*?"<>|#^[\]]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
export const norm = (s) => String(s).toLowerCase().replace(/[\s_\-·（）()]/g, '');
export const link = (n) => `[[${safeName(n)}]]`;
export const unlink = (s) => String(s).replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim();

/** 剥离代码块与行内反引号，防止代码示例中的 [[...]] 被误判为双链 */
export function stripCode(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]+`/g, '');
}

/** 读取 wiki/ 下所有页面（不含 _indexes、_reports） */
export function loadAll() {
  if (!fs.existsSync(WIKI)) return [];
  return fs
    .readdirSync(WIKI, { recursive: true })
    .map((f) => String(f).replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => {
      const full = path.join(WIKI, f);
      const { data, body, errors } = parse(fs.readFileSync(full, 'utf8'));
      return { rel: f, full, name: path.basename(f, '.md'), data, body, fmErrors: errors };
    });
}
