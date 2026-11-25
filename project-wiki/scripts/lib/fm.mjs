// 轻量零依赖 YAML Frontmatter 解析器：
// 兼容单行 JSON 语法，同时也原生兼容 Obsidian Properties/重命名自动写回的标准多行 YAML 列表与单引号标量。

const FORCE_STRING_KEYS = new Set([
  'doc_commit',
  'version',
  'updated',
  'created',
  'doc_date',
  'valid_until',
  'title',
  'summary',
  'cn_name',
  'doc_path',
  'service',
  'type',
  'status',
  'doc_type',
  'author',
  'kind',
  'db',
  'tech',
]);

function parseScalar(raw, key = '') {
  const v = String(raw).trim();
  if (v === '') return { value: '', error: '' };

  // 单引号 YAML 字符串：'' 表示转义的单引号
  if (v.startsWith("'")) {
    if (v.length >= 2 && v.endsWith("'")) {
      return { value: v.slice(1, -1).replace(/''/g, "'"), error: '' };
    }
    return { value: v, error: `字段 "${key}" 的单引号字符串未闭合` };
  }

  // 强制保持字符串类型的字段（避免 1234e56 被解析为 Infinity 或 1.0 被解析为 1）
  if (FORCE_STRING_KEYS.has(key) && !v.startsWith('"') && !v.startsWith('[') && !v.startsWith('{')) {
    return { value: v, error: '' };
  }

  // JSON 值（双引号字符串、数组、对象、数字、布尔、null）
  if (/^[\[{"\-0-9]/.test(v) || ['true', 'false', 'null'].includes(v)) {
    try {
      const parsed = JSON.parse(v);
      // 日期、版本号等避免非预期数字转换（若原值看起来是普通字符串，JSON.parse 会失败并走下方裸字符串）
      return { value: parsed, error: '' };
    } catch {
      if (/^[\[{"]/.test(v)) {
        return { value: v, error: `字段 "${key}" 的 JSON/YAML 值语法错误（${v.slice(0, 40)}）` };
      }
    }
  }

  // 标准 YAML 无引号标量字符串
  return { value: v, error: '' };
}

export function parse(text) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!/^---[ \t]*(?:\n|$)/.test(text)) {
    return { data: {}, body: text, errors: ['缺少 frontmatter 头部'] };
  }

  const firstNewline = text.indexOf('\n');
  if (firstNewline < 0) {
    return { data: {}, body: '', errors: ['frontmatter 未闭合（缺少结束 ---）'] };
  }

  const afterOpen = text.slice(firstNewline + 1);
  // 匹配空 frontmatter（首行即 ---）或正常结束行 \n---
  let fmBlock = '';
  let body = '';
  const emptyClose = afterOpen.match(/^---[ \t]*(?:\n|$)/);
  if (emptyClose) {
    fmBlock = '';
    body = afterOpen.slice(emptyClose[0].length);
  } else {
    const closeMatch = afterOpen.match(/\n---[ \t]*(?:\n|$)/);
    if (!closeMatch || closeMatch.index === undefined) {
      return { data: {}, body: text, errors: ['frontmatter 未闭合（缺少结束 ---）'] };
    }
    fmBlock = afterOpen.slice(0, closeMatch.index);
    body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  }

  const data = {};
  const errors = [];
  let lastArrayKey = null;

  for (const [idx, rawLine] of (fmBlock ? fmBlock.split('\n') : []).entries()) {
    const lineNo = idx + 2;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;

    // 原生兼容 Obsidian 多行 YAML 列表（- item）
    const listMatch = rawLine.match(/^\s*-\s+(.*)$/);
    if (listMatch && lastArrayKey) {
      const { value, error } = parseScalar(listMatch[1], `${lastArrayKey}[]`);
      if (error) errors.push(`第 ${lineNo} 行：${error}`);
      if (!Array.isArray(data[lastArrayKey])) data[lastArrayKey] = [];
      data[lastArrayKey].push(value);
      continue;
    }

    const m = rawLine.match(/^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/);
    if (!m) {
      errors.push(`第 ${lineNo} 行：无法解析的 frontmatter 行 "${rawLine.trim()}"`);
      lastArrayKey = null;
      continue;
    }

    const [, key, rawVal = ''] = m;
    const v = rawVal.trim();
    if (v === '') {
      data[key] = '';
      lastArrayKey = key;
      continue;
    }

    lastArrayKey = null;
    const { value, error } = parseScalar(v, key);
    if (error) errors.push(`第 ${lineNo} 行：${error}`);
    data[key] = value;
  }

  return { data, body: body.replace(/^\n+/, ''), errors };
}

export function stringify(data, body) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).trim()}\n`;
}
