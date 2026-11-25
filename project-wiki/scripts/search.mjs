// 0-token 本地检索与影响面分析工具：
// 用法：
//   node scripts/search.mjs <关键词...> [--type=table|feature|module|term|question|source|faq] [--status=...] [--limit=15]
//   node scripts/search.mjs --impact=<实体名>
import { pathToFileURL } from 'node:url';
import { args, flagValue } from './lib/config.mjs';
import { loadAll, norm, unlink, splitColon, extractWikiLinks } from './lib/pages.mjs';

function cjkBigrams(str) {
  const onlyCjk = String(str).match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const grams = [];
  for (const seg of onlyCjk) {
    for (let i = 0; i < seg.length - 1; i++) grams.push(seg.slice(i, i + 2));
  }
  return [...new Set(grams)];
}

export function searchWiki(queries, { type = '', status = '', limit = 15 } = {}) {
  const terms = queries.map((q) => String(q).trim().toLowerCase()).filter(Boolean);
  if (!terms.length && !status) return [];

  const pages = loadAll().filter((p) => (!type || p.data.type === type) && (!status || p.data.status === status));

  // 仅按 --status / --type 筛选浏览
  if (!terms.length) {
    return pages
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .slice(0, limit)
      .map((page) => ({ page, score: 1, matchedTerms: 0, metaHits: [], snippets: [] }));
  }

  const results = [];

  for (const p of pages) {
    const d = p.data;
    const aliases = Array.isArray(d.aliases) ? d.aliases : [];
    const nameStr = `${p.name} ${d.title || ''} ${aliases.join(' ')} ${d.cn_name || ''}`.toLowerCase();
    const nameNorm = norm(nameStr);
    const metaFields = [
      ...(Array.isArray(d.entrypoints) ? d.entrypoints.map((x) => `入口: ${x}`) : []),
      ...(Array.isArray(d.error_codes) ? d.error_codes.map((x) => `错误码: ${x}`) : []),
      ...(Array.isArray(d.crud) ? d.crud.map((x) => `CRUD: ${x}`) : []),
      ...(d.service ? [`服务: ${unlink(d.service)}`] : []),
    ];
    const metaStr = metaFields.join(' ').toLowerCase();
    const metaNorm = norm(metaStr);
    const sumStr = String(d.summary || '').toLowerCase();
    const bodyText = String(p.body || '');
    const bodyLower = bodyText.toLowerCase();

    let score = 0;
    let matchedTerms = 0;

    for (const t of terms) {
      const tNorm = norm(t);
      let hit = false;

      if (
        p.name.toLowerCase() === t ||
        (tNorm && norm(p.name) === tNorm) ||
        aliases.some((a) => String(a).toLowerCase() === t || (tNorm && norm(a) === tNorm))
      ) {
        score += 120;
        hit = true;
      } else if (nameStr.includes(t) || (tNorm.length >= 2 && nameNorm.includes(tNorm))) {
        score += 60;
        hit = true;
      }

      if (metaStr.includes(t) || (tNorm.length >= 2 && metaNorm.includes(tNorm))) {
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

      // 中文连续长词未整串命中时，用 2-gram 覆盖率做平滑回退匹配（如 "积分过期规则" 命中 "积分有效期及过期清理规则"）
      if (!hit) {
        const grams = cjkBigrams(t);
        if (grams.length >= 2) {
          const allText = `${nameStr} ${sumStr} ${bodyLower}`;
          const matchedGrams = grams.filter((g) => allText.includes(g));
          const ratio = matchedGrams.length / grams.length;
          if (ratio >= 0.5) {
            score += Math.round(ratio * 20);
            hit = true;
          }
        }
      }

      if (hit) matchedTerms++;
    }

    if (!score) continue;
    if (terms.length > 1 && matchedTerms === terms.length) score += 80;

    const metaHits = metaFields
      .filter((m) => terms.some((t) => m.toLowerCase().includes(t) || (norm(t).length >= 2 && norm(m).includes(norm(t)))))
      .slice(0, 2);

    const snippets = [];
    for (const line of bodyText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const lower = trimmed.toLowerCase();
      if (terms.some((t) => lower.includes(t) || cjkBigrams(t).some((g) => lower.includes(g)))) {
        snippets.push(trimmed.slice(0, 120));
        if (snippets.length >= 2) break;
      }
    }

    results.push({ page: p, score, matchedTerms, metaHits, snippets });
  }

  return results
    .sort((a, b) => b.score - a.score || a.page.name.localeCompare(b.page.name, 'zh'))
    .slice(0, limit);
}

export function impactAnalysis(targetQuery) {
  const pages = loadAll();
  const qNorm = norm(unlink(targetQuery));
  const target = pages.find(
    (p) =>
      p.name.toLowerCase() === unlink(targetQuery).toLowerCase() ||
      norm(p.name) === qNorm ||
      (Array.isArray(p.data.aliases) && p.data.aliases.some((a) => norm(a) === qNorm)),
  );
  if (!target) return null;

  const features = pages.filter((p) => p.data.type === 'feature');
  const questions = pages.filter((p) => p.data.type === 'question' && p.data.status !== 'resolved');

  const callersOf = (featName) =>
    features.filter((f) => (f.data.calls || []).map(unlink).includes(featName)).map((f) => f.name);
  const calleesOf = (feat) => (feat.data.calls || []).map(unlink).filter(Boolean);
  const crudMapOf = (feat) => {
    const out = {};
    for (const c of feat.data.crud || []) {
      const [rawT, op] = splitColon(c);
      const t = unlink(rawT);
      if (t) out[t] = (out[t] || '') + op;
    }
    return out;
  };

  const directFeatures = [];
  const relatedTables = new Set();
  const upstream = new Set();
  const downstream = new Set();

  if (target.data.type === 'table') {
    for (const f of features) {
      const op = crudMapOf(f)[target.name];
      if (op) {
        directFeatures.push({ name: f.name, service: unlink(f.data.service || ''), op });
        for (const c of callersOf(f.name)) upstream.add(c);
        for (const c of calleesOf(f)) downstream.add(c);
      }
    }
  } else if (target.data.type === 'feature') {
    for (const [t, op] of Object.entries(crudMapOf(target))) relatedTables.add(`${t}:${op}`);
    for (const c of callersOf(target.name)) upstream.add(c);
    for (const c of calleesOf(target)) downstream.add(c);
  } else if (target.data.type === 'module') {
    for (const f of features) {
      if (unlink(f.data.service || '') === target.name) {
        directFeatures.push({ name: f.name, service: target.name, op: '' });
        for (const t of Object.keys(crudMapOf(f))) relatedTables.add(t);
        for (const c of callersOf(f.name)) upstream.add(c);
        for (const c of calleesOf(f)) downstream.add(c);
      }
    }
  }

  const backlinks = pages
    .filter((p) => p.name !== target.name && p.data.type !== 'source' && extractWikiLinks(p.body).has(target.name))
    .map((p) => p.name);

  const openQuestions = questions
    .filter((q) => (q.data.related || []).map(unlink).includes(target.name))
    .map((q) => ({ name: q.name, status: q.data.status, summary: q.data.summary || '' }));

  return {
    target,
    directFeatures,
    relatedTables: [...relatedTables].sort(),
    upstream: [...upstream].sort(),
    downstream: [...downstream].sort(),
    backlinks: backlinks.sort(),
    openQuestions,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const impactTarget = flagValue('impact');
  if (impactTarget) {
    const res = impactAnalysis(impactTarget);
    if (!res) {
      console.log(`未找到与 "${impactTarget}" 匹配的 Wiki 实体页。`);
      process.exit(0);
    }
    const { target, directFeatures, relatedTables, upstream, downstream, backlinks, openQuestions } = res;
    console.log(`影响面分析：[[${target.name}]] (${target.data.type}${target.data.status ? ` · ${target.data.status}` : ''}) · wiki/${target.rel}`);
    if (target.data.summary) console.log(`摘要：${target.data.summary}`);
    if (directFeatures.length) {
      console.log(`\n直连/归属功能（${directFeatures.length}）：`);
      for (const f of directFeatures) {
        console.log(`- [[${f.name}]]${f.op ? ` (${f.op})` : ''}${f.service ? ` · 服务：[[${f.service}]]` : ''}`);
      }
    }
    if (relatedTables.length) console.log(`\n涉及物理表（${relatedTables.length}）：${relatedTables.map((t) => `\`${t}\``).join('、')}`);
    if (upstream.length) console.log(`\n上游调用方（${upstream.length}）：${upstream.map((x) => `[[${x}]]`).join('、')}`);
    if (downstream.length) console.log(`\n下游被调方（${downstream.length}）：${downstream.map((x) => `[[${x}]]`).join('、')}`);
    if (openQuestions.length) {
      console.log(`\n关联未闭环问题（${openQuestions.length}）：`);
      for (const q of openQuestions) console.log(`- [[${q.name}]] [${q.status}] — ${q.summary}`);
    }
    if (backlinks.length) console.log(`\n正文提及页面（${backlinks.length}）：${backlinks.slice(0, 12).map((x) => `[[${x}]]`).join('、')}${backlinks.length > 12 ? ' 等' : ''}`);
    process.exit(0);
  }

  const type = flagValue('type') || '';
  const status = flagValue('status') || '';
  const limit = Number(flagValue('limit') || 15);
  if (!args.length && !status) {
    console.log(
      '用法：\n  node project-wiki/scripts/search.mjs <关键词...> [--type=table|feature|module|term|question|source|faq] [--status=...] [--limit=15]\n  node project-wiki/scripts/search.mjs --impact=<实体名>',
    );
    process.exit(0);
  }
  const hits = searchWiki(args, { type, status, limit });
  if (!hits.length) {
    console.log(`未找到与 "${args.join(' ') || status}" 匹配的 Wiki 页面。`);
    process.exit(0);
  }
  console.log(`找到 ${hits.length} 个相关页面：\n`);
  for (const { page: p, metaHits, snippets } of hits) {
    const st = p.data.status && !['active', 'draft'].includes(p.data.status) ? ` [${p.data.status}]` : '';
    console.log(`- [[${p.name}]] (${p.data.type}${st}) · wiki/${p.rel}`);
    if (p.data.summary) console.log(`  摘要：${p.data.summary}`);
    for (const m of metaHits) console.log(`  元信息：${m}`);
    for (const s of snippets) console.log(`  命中：${s}`);
  }
}
