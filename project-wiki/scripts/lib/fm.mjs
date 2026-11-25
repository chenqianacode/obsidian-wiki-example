// 轻量 frontmatter 解析器：推荐单行 JSON 值（合法 YAML 子集，Obsidian 可直接识别），并捕获多行/语法异常供 lint 报告
export function parse(text) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { data: {}, body: text, errors: ['缺少 frontmatter 头部'] };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: text, errors: ['frontmatter 未闭合（缺少结束 ---）'] };

  const data = {};
  const errors = [];
  let lastArrayKey = null;

  for (const [idx, rawLine] of text.slice(4, end).split('\n').entries()) {
    const lineNo = idx + 2;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;

    // 兼容兜底：若 Agent 误写多行 YAML 列表（- item），不静默吞数据，但记录格式告警
    const listMatch = rawLine.match(/^\s*-\s+(.*)$/);
    if (listMatch && lastArrayKey) {
      const itemRaw = listMatch[1].trim();
      let itemVal = itemRaw;
      try {
        itemVal = JSON.parse(itemRaw);
      } catch {
        itemVal = itemRaw.replace(/^['"]|['"]$/g, '');
      }
      if (!Array.isArray(data[lastArrayKey])) data[lastArrayKey] = [];
      data[lastArrayKey].push(itemVal);
      if (!errors.some((e) => e.includes(lastArrayKey))) {
        errors.push(`第 ${lineNo} 行：字段 "${lastArrayKey}" 使用了多行 YAML 列表，应改为单行 JSON 数组`);
      }
      continue;
    }

    const m = rawLine.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) {
      errors.push(`第 ${lineNo} 行：无法解析的 frontmatter 行 "${rawLine.trim()}"`);
      lastArrayKey = null;
      continue;
    }

    const [, key, rawVal] = m;
    const v = rawVal.trim();
    if (v === '') {
      data[key] = '';
      lastArrayKey = key;
      continue;
    }

    lastArrayKey = null;
    try {
      data[key] = JSON.parse(v);
    } catch {
      if (/^[\[{"']/.test(v)) {
        errors.push(`第 ${lineNo} 行：字段 "${key}" 的 JSON 值语法错误（${v.slice(0, 40)}）`);
      }
      data[key] = v;
    }
  }

  return { data, body: text.slice(end + 4).replace(/^\n+/, ''), errors };
}

export function stringify(data, body) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).trim()}\n`;
}
