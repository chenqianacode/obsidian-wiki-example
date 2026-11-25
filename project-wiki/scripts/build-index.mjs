// 根据各页面的 frontmatter 自动生成 index.md、按服务分组的 CRUD 矩阵、接口与消息总表、错误码字典、文档对照表（0-token 纯脚本）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, now } from './lib/config.mjs';
import { loadAll, TYPE_LABELS, unlink } from './lib/pages.mjs';

function write(rel, text) {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, 'utf8');
}

function parseCrud(feat) {
  return Object.fromEntries(
    (feat.data.crud || [])
      .map((c) => String(c).split(':').map((s) => s.trim()))
      .filter((x) => x[0]),
  );
}

export function buildIndex() {
  const pages = loadAll();
  const by = (t) => pages.filter((p) => p.data.type === t).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const badge = (s) => (s && !['draft', 'active'].includes(s) ? ` \`${s}\`` : '');
  const line = (p) => `- [[${p.name}]]${badge(p.data.status)} — ${p.data.summary || p.data.title || ''}`;

  // 1. index.md
  let out = `---\ntype: "index"\nupdated: "${now()}"\n---\n\n# 项目 Wiki 索引\n\n> 由 \`scripts/build-index.mjs\` 自动生成，请勿手动修改。共 ${pages.length} 页 · [[CRUD矩阵]] · [[接口与消息总表]] · [[错误码字典]] · [[文档对照表]] · [[lint报告]]\n`;
  for (const t of ['module', 'feature', 'table', 'term']) {
    const l = by(t);
    if (l.length) out += `\n## ${TYPE_LABELS[t]}（${l.length}）\n${l.map(line).join('\n')}\n`;
  }
  const qs = by('question');
  if (qs.length) {
    const statusOrder = { open: 0, decided: 1, resolved: 2 };
    const sortedQs = [...qs].sort(
      (a, b) => (statusOrder[a.data.status] ?? 9) - (statusOrder[b.data.status] ?? 9) || a.name.localeCompare(b.name, 'zh'),
    );
    const openCnt = qs.filter((q) => q.data.status === 'open').length;
    const decidedCnt = qs.filter((q) => q.data.status === 'decided').length;
    out += `\n## ${TYPE_LABELS.question}（待拍板 ${openCnt} · 待改原文档 ${decidedCnt} / 共 ${qs.length}）\n${sortedQs.map(line).join('\n')}\n`;
  }
  const faq = by('faq');
  if (faq.length) out += `\n## FAQ（${faq.length}）\n${faq.map(line).join('\n')}\n`;

  const srcs = by('source');
  const DOC_GROUP_ORDER = ['基础设计', '表定义', '详细设计', '变更与评审'];
  const groups = {};
  for (const s of srcs) (groups[s.data.doc_type || '其他'] ??= []).push(s);
  const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
    const ia = DOC_GROUP_ORDER.indexOf(a);
    const ib = DOC_GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'zh');
  });
  out += `\n## 文档（${srcs.length}）\n`;
  for (const g of sortedGroupKeys) out += `\n### ${g}\n${groups[g].map(line).join('\n')}\n`;
  write('index.md', out);

  // 2. CRUD矩阵.md（按所属服务分表避免列爆炸 + 表维度反向汇总）
  const feats = by('feature');
  const tablePages = by('table');
  const tableMap = new Map(tablePages.map((t) => [t.name, t]));
  const allTableNames = [...new Set([...tablePages.map((t) => t.name), ...feats.flatMap((f) => Object.keys(parseCrud(f)))])].sort();

  let crud = `# CRUD矩阵\n\n> 自动生成：仅统计各服务**直连数据库**的表读写关系（C 新增 / R 查询 / U 更新 / D 删除）；跨服务 RPC/MQ 调用见 [[接口与消息总表]]。\n`;

  const featsByService = new Map();
  for (const f of feats) {
    const svc = f.data.service || '未指定服务';
    if (!featsByService.has(svc)) featsByService.set(svc, []);
    featsByService.get(svc).push(f);
  }
  for (const [svc, svcFeats] of [...featsByService.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
    const svcTables = [...new Set(svcFeats.flatMap((f) => Object.keys(parseCrud(f))))].sort();
    if (!svcTables.length) continue;
    crud += `\n## [[${svc}]]\n\n`;
    crud += `| 功能 | ${svcTables.map((t) => `[[${t}]]`).join(' | ')} |\n|---|${svcTables.map(() => ':-:').join('|')}|\n`;
    for (const f of svcFeats) {
      const m = parseCrud(f);
      crud += `| [[${f.name}]] | ${svcTables.map((t) => m[t] || '').join(' | ')} |\n`;
    }
  }

  crud += `\n## 表读写反向索引（共 ${allTableNames.length} 张表）\n\n| 物理表 | 中文名 | 状态 | 新增(C) | 查询(R) | 更新(U) | 删除(D) |\n|---|---|---|---|---|---|---|\n`;
  for (const tName of allTableNames) {
    const tp = tableMap.get(tName);
    const ops = { C: [], R: [], U: [], D: [] };
    for (const f of feats) {
      const v = parseCrud(f)[tName] || '';
      for (const ch of ['C', 'R', 'U', 'D']) {
        if (v.includes(ch)) ops[ch].push(`[[${f.name}]]`);
      }
    }
    const cn = tp?.data.cn_name || '';
    const st = tp?.data.status && !['active', 'draft'].includes(tp.data.status) ? `\`${tp.data.status}\`` : '正常';
    crud += `| [[${tName}]] | ${cn} | ${st} | ${ops.C.join('、')} | ${ops.R.join('、')} | ${ops.U.join('、')} | ${ops.D.join('、')} |\n`;
  }
  write('wiki/_indexes/CRUD矩阵.md', crud);

  // 3. 接口与消息总表.md
  let apiMd = `# 接口与消息总表\n\n> 自动生成：汇总各功能的 API、内部接口、MQ 消息、定时任务及跨功能调用链路。\n\n| 触发类型 | 入口契约 / 标识 | 所属服务 | 对应功能 | 下游调用（跨功能/服务） |\n|---|---|---|---|---|\n`;
  const epRows = [];
  for (const f of feats) {
    const eps = Array.isArray(f.data.entrypoints) && f.data.entrypoints.length ? f.data.entrypoints : (f.data.aliases || []);
    const calls = (f.data.calls || []).map((c) => `[[${unlink(c)}]]`).join('、');
    const svc = f.data.service ? `[[${f.data.service}]]` : '';
    if (!eps.length) {
      epRows.push({ kind: f.data.kind || '', ep: '（未声明）', svc, feat: `[[${f.name}]]`, calls });
      continue;
    }
    for (const rawEp of eps) {
      const idx = String(rawEp).indexOf(':');
      const hasKind = idx > 0 && idx <= 12 && !String(rawEp).slice(0, idx).includes('/');
      const kind = hasKind ? String(rawEp).slice(0, idx).trim() : (f.data.kind || '');
      const ep = hasKind ? String(rawEp).slice(idx + 1).trim() : String(rawEp).trim();
      epRows.push({ kind, ep, svc, feat: `[[${f.name}]]`, calls });
    }
  }
  epRows.sort((a, b) => a.kind.localeCompare(b.kind, 'zh') || a.ep.localeCompare(b.ep));
  for (const r of epRows) {
    apiMd += `| ${r.kind} | \`${r.ep}\` | ${r.svc} | ${r.feat} | ${r.calls} |\n`;
  }
  write('wiki/_indexes/接口与消息总表.md', apiMd);

  // 4. 错误码字典.md
  let errMd = `# 错误码字典\n\n> 自动生成：汇总各功能定义的业务错误码，写新详细设计前请先核对前缀与编号避免冲突。\n\n| 错误码 | 所属服务 | 定义功能 | 说明 |\n|---|---|---|---|\n`;
  const errRows = [];
  for (const f of feats) {
    for (const item of f.data.error_codes || []) {
      const s = String(item);
      const idx = s.indexOf(':');
      const code = (idx >= 0 ? s.slice(0, idx) : s).trim();
      const desc = idx >= 0 ? s.slice(idx + 1).trim() : '';
      if (code) errRows.push({ code, svc: f.data.service ? `[[${f.data.service}]]` : '', feat: `[[${f.name}]]`, desc });
    }
  }
  errRows.sort((a, b) => a.code.localeCompare(b.code));
  for (const r of errRows) {
    errMd += `| \`${r.code}\` | ${r.svc} | ${r.feat} | ${r.desc} |\n`;
  }
  if (!errRows.length) errMd += `| - | - | - | 暂无错误码记录 |\n`;
  write('wiki/_indexes/错误码字典.md', errMd);

  // 5. 文档对照表.md（由各页面的 sources 字段反向聚合，消除手写 entities 漂移）
  const revRefs = new Map();
  for (const p of pages) {
    if (p.data.type === 'source') continue;
    for (const s of p.data.sources || []) {
      const sn = unlink(s);
      if (!sn) continue;
      if (!revRefs.has(sn)) revRefs.set(sn, new Set());
      revRefs.get(sn).add(p.name);
    }
  }

  let map = `# 文档对照表\n\n> 自动生成：原文档 → wiki 文档摘要页、同步 commit、时效状态及反向关联页面数（由各页面 \`sources\` 自动聚合）。\n\n| 文档页 | 类型 | 原文路径 | 同步到的 commit | 状态 | 有效期至 | 关联页面数 |\n|---|---|---|---|---|---|---|\n`;
  for (const s of srcs) {
    const refCnt = revRefs.get(s.name)?.size || 0;
    const st = s.data.status || '';
    const validUntil = s.data.valid_until || '-';
    map += `| [[${s.name}]] | ${s.data.doc_type || ''} | \`${s.data.doc_path || ''}\` | \`${s.data.doc_commit || ''}\` | ${st} | ${validUntil} | ${refCnt} |\n`;
  }
  write('wiki/_indexes/文档对照表.md', map);
  return pages.length;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`索引已更新：${buildIndex()} 页`);
}
