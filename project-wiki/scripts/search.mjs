// 0-token 本地检索工具：在大规模 Wiki 中按关键词、表名、接口路径、错误码或类型快速定位候选页面，避免每次全量读取 index.md
// 用法：node scripts/search.mjs <关键词...> [--type=table|feature|module|term|question|source|faq] [--limit=15]
import { pathToFileURL } from 'node:url';
import { args, flagValue } from './lib/config.mjs';
import { loadAll } from './lib/pages.mjs';

export function searchWiki(queries, { type = '', limit = 15 } = {}) {
  const terms = queries.map((q) => String(q).trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return [];

  const pages = loadAll().filter((p) => !type || p.data.type === type);
  const results = [];

  for (const p of pages) {
    const d = p.data;
    const nameStr = `${p.name} ${d.title || ''} ${(d.aliases || []).join(' ')} ${d.cn_name || ''}`.toLowerCase();
    const metaStr = `${(d.entrypoints || []).join(' ')} ${(d.error_codes || []).join(' ')} ${(d.crud || []).join(' ')} ${d.service || ''}`.toLowerCase();
    const sumStr = String(d.summary || '').toLowerCase();
    const bodyText = String(p.body || '');
    const bodyLower = bodyText.toLowerCase();

    let score = 0;
    let matchedTerms = 0;
    for (const t of terms) {
      let hit = false;
      if (p.name.toLowerCase() === t || (d.aliases || []).some((a) => String(a).toLowerCase() === t)) {
        score += 120;
        hit = true;
      } else if (nameStr.includes(t)) {
        score += 60;
        hit = true;
      }
      if (metaStr.includes(t)) {
        score += 50;
        hit = true;
      }
      if (sumStr.includes(t)) {
        score += 25;
        hit = true;
      }
      if (bodyLower.includes(t)) {
        score += 10;
        hit = true;
      }
      if (hit) matchedTerms++;
    }

    if (!score) continue;
    // 多关键词全部命中时加权置顶
    if (terms.length > 1 && matchedTerms === terms.length) score += 80;

    const snippets = [];
    for (const line of bodyText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (terms.some((t) => trimmed.toLowerCase().includes(t))) {
        snippets.push(trimmed.slice(0, 120));
        if (snippets.length >= 2) break;
      }
    }

    results.push({ page: p, score, matchedTerms, snippets });
  }

  return results
    .sort((a, b) => b.score - a.score || a.page.name.localeCompare(b.page.name, 'zh'))
    .slice(0, limit);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!args.length) {
    console.log('用法：node project-wiki/scripts/search.mjs <关键词...> [--type=table|feature|module|term|question|source|faq] [--limit=15]');
    process.exit(0);
  }
  const type = flagValue('type') || '';
  const limit = Number(flagValue('limit') || 15);
  const hits = searchWiki(args, { type, limit });
  if (!hits.length) {
    console.log(`未找到与 "${args.join(' ')}" 匹配的 Wiki 页面。`);
    process.exit(0);
  }
  console.log(`找到 ${hits.length} 个相关页面：\n`);
  for (const { page: p, snippets } of hits) {
    const st = p.data.status && !['active', 'draft'].includes(p.data.status) ? ` [${p.data.status}]` : '';
    console.log(`- [[${p.name}]] (${p.data.type}${st}) · wiki/${p.rel}`);
    if (p.data.summary) console.log(`  摘要：${p.data.summary}`);
    for (const s of snippets) console.log(`  命中：${s}`);
  }
}
