#!/usr/bin/env node
// Search-quality evaluation for Boogle's SearXNG backend.
//
// SearXNG ranks by  score = Π(engine weights) × (#engines) × Σ 1/position,
// then runs a grouping pass that can shuffle that order (see src/rank.ts).
// This script measures what actually comes out, so engine and weight changes
// in searxng/settings.yml can be judged on numbers instead of impressions.
//
//   node scripts/search-eval.mjs engines [--engines a,b,c]      per-engine health, latency, overlap
//   node scripts/search-eval.mjs merged  [--save DIR]           merged results: hit rate, agreement, ordering
//   node scripts/search-eval.mjs compare DIR_A DIR_B            merged metrics of two saved runs side by side
//
// Common flags: --url http://127.0.0.1:8888  (or SEARXNG_URL)
//               --queries scripts/eval-queries.json
//               --limit N       only the first N queries
//               --tab web       web | images | news | videos
//               --lang en-US    SearXNG language (default auto, like the app)
//               --top 10        window for the @k metrics
//               --delay 1500    pause between queries (ms); upstreams rate-limit bursts
//               --verbose       per-query lines

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'merged';
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    flags[k] = v;
  } else positional.push(argv[i]);
}

const BASE = (flags.url || process.env.SEARXNG_URL || 'http://127.0.0.1:8888').replace(/\/$/, '');
const TAB = flags.tab || 'web';
const CATEGORY = { web: 'general', images: 'images', news: 'news', videos: 'videos' }[TAB] || 'general';
const TOP = Number(flags.top || 10);
const LANG = flags.lang || 'auto';
const VERBOSE = flags.verbose === 'true';
const DELAY = Number(flags.delay ?? 1500);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const HEADERS = { Accept: 'application/json', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' };

// The app's reranker if it has been built, else an equivalent local copy, so
// the "reranked" columns describe exactly what the results page will show.
let rankResults;
try {
  ({ rankResults } = await import('../dist/rank.js'));
} catch {
  rankResults = (results, tab) => {
    const byScore = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    if (tab !== 'web') return byScore;
    const seen = new Map();
    const kept = [];
    const deferred = [];
    for (const r of byScore) {
      const h = host(r.url);
      const n = seen.get(h) ?? 0;
      seen.set(h, n + 1);
      (n < 2 ? kept : deferred).push(r);
    }
    return kept.concat(deferred);
  };
}

async function loadQueries() {
  const file = flags.queries || path.join(here, 'eval-queries.json');
  let list = JSON.parse(await readFile(file, 'utf8'));
  if (flags.limit) list = list.slice(0, Number(flags.limit));
  return list.map((x) => (typeof x === 'string' ? { q: x } : x));
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}
function normUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')).toLowerCase();
  } catch {
    return url;
  }
}

async function searx(q, extra = {}) {
  // "categories" and "engines" together run the union of both, so a
  // single-engine probe must leave the category out.
  const params = new URLSearchParams({ q, format: 'json', language: LANG, safesearch: '0', ...(extra.engines ? {} : { categories: CATEGORY }), ...extra });
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/search?${params}`, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
    const ms = performance.now() - t0;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}`, data: null };
    const data = await res.json();
    data.results ??= [];
    data.unresponsive_engines ??= [];
    return { ok: true, ms, data };
  } catch (err) {
    return { ok: false, ms: performance.now() - t0, error: err.name === 'TimeoutError' ? 'client timeout' : err.message, data: null };
  }
}

// ----------------------------------------------------------------- output --
const pct = (n) => `${Math.round(n * 100)}%`;
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '-');
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '-');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
function table(rows, headers) {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const w = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  console.log(line(headers));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r.map(String)));
  console.log();
}

// ------------------------------------------------------------ engines mode --
async function enginesMode() {
  const queries = await loadQueries();
  const engines = (flags.engines || 'google,google cse,brave,bing,yahoo,yandex,startpage,mojeek,reddit,stackoverflow').split(',').map((s) => s.trim());
  console.log(`Per-engine run: ${queries.length} queries × ${engines.length} engines against ${BASE} (${CATEGORY})\n`);

  const stats = Object.fromEntries(engines.map((e) => [e, { ms: [], counts: [], fails: {}, lists: [] }]));
  for (const [qi, { q }] of queries.entries()) {
    if (qi) await sleep(DELAY);
    const rs = await Promise.all(engines.map((e) => searx(q, { engines: e })));
    engines.forEach((e, i) => {
      const r = rs[i];
      const s = stats[e];
      // An unknown engine name makes SearXNG fall back to its default set;
      // treat a result that names other engines as a failure of this one.
      const foreign = r.data?.results.some((x) => !(x.engines ?? [x.engine]).includes(e));
      const unresp = r.data?.unresponsive_engines.find((u) => u[0] === e);
      if (!r.ok || foreign || unresp || !r.data.results.length) {
        const why = !r.ok ? r.error : foreign ? 'not an engine name' : unresp ? unresp[1] : 'no results';
        s.fails[why] = (s.fails[why] ?? 0) + 1;
        s.lists.push([]);
        if (VERBOSE) console.log(`  ${e.padEnd(14)} ${q.padEnd(44)} FAIL ${why}`);
        return;
      }
      s.ms.push(r.ms);
      s.counts.push(r.data.results.length);
      s.lists.push(r.data.results.slice(0, TOP).map((x) => normUrl(x.url)));
      if (VERBOSE) console.log(`  ${e.padEnd(14)} ${q.padEnd(44)} ${String(r.data.results.length).padStart(3)} results ${f1(r.ms / 1000)}s`);
    });
  }

  table(
    engines.map((e) => {
      const s = stats[e];
      const okN = s.ms.length;
      const fails = Object.entries(s.fails)
        .map(([k, v]) => `${k}×${v}`)
        .join(', ');
      return [e, pct(okN / queries.length), f1(mean(s.counts)), f2(quantile(s.ms, 0.5) / 1000), f2(quantile(s.ms, 0.9) / 1000), fails || '-'];
    }),
    ['engine', 'answered', 'avg results', 'p50 s', 'p90 s', 'failures'],
  );

  // Pairwise overlap of the top-N URL sets, averaged over queries both
  // engines answered. High overlap = same underlying index.
  const rows = engines.map((a) => [
    a,
    ...engines.map((b) => {
      if (a === b) return '·';
      const vals = [];
      for (let i = 0; i < queries.length; i++) {
        const A = new Set(stats[a].lists[i]);
        const B = new Set(stats[b].lists[i]);
        if (!A.size || !B.size) continue;
        const inter = [...A].filter((u) => B.has(u)).length;
        vals.push(inter / Math.min(A.size, B.size));
      }
      return vals.length ? pct(mean(vals)) : '-';
    }),
  ]);
  console.log(`Top-${TOP} overlap between engines (share of the smaller list also present in the other):`);
  table(rows, ['', ...engines]);
}

// ------------------------------------------------------------- merged mode --
function analyse(rec) {
  const { q, expect, data, ms } = rec;
  const raw = data.results;
  const ranked = rankResults(raw, TAB);
  const byScore = [...raw].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = raw.slice(0, TOP);
  const re = expect ? new RegExp(expect, 'i') : null;
  const firstHit = (list) => {
    if (!re) return null;
    const i = list.findIndex((r) => re.test(r.url));
    return i < 0 ? Infinity : i + 1;
  };
  // How far SearXNG's grouping pass moved the best-scoring results from
  // where their score puts them: mean |shown position − score position|
  // over the top TOP by score (a result pushed off the page counts as TOP).
  const shownPos = new Map(raw.map((r, i) => [r.url, i]));
  const displaced = mean(byScore.slice(0, TOP).map((r, i) => Math.abs(Math.min(shownPos.get(r.url) ?? TOP, TOP) - i)));
  const hostCounts = {};
  for (const r of top) hostCounts[host(r.url)] = (hostCounts[host(r.url)] ?? 0) + 1;
  const engines = new Set();
  for (const r of raw) for (const e of r.engines ?? [r.engine]) engines.add(e);
  const slots = {};
  for (const r of ranked.slice(0, TOP)) for (const e of r.engines ?? [r.engine]) slots[e] = (slots[e] ?? 0) + 1;
  const solo = {};
  for (const r of ranked.slice(0, TOP)) {
    const es = r.engines ?? [r.engine];
    if (es.length === 1) solo[es[0]] = (solo[es[0]] ?? 0) + 1;
  }
  return {
    q,
    ms,
    n: raw.length,
    engines: [...engines].sort(),
    unresponsive: data.unresponsive_engines.map((u) => `${u[0]} (${u[1]})`),
    agreement: top.length ? top.filter((r) => (r.engines?.length ?? 1) >= 2).length / top.length : NaN,
    maxHost: Math.max(0, ...Object.values(hostCounts)),
    displaced,
    rawHit: firstHit(raw),
    rankedHit: firstHit(ranked),
    slots,
    solo,
    ranked: ranked.slice(0, TOP).map((r) => r.url),
  };
}

function summarise(records, label) {
  const rows = records.map(analyse);
  const graded = rows.filter((r) => r.rawHit !== null);
  const hitAt = (key, k) => graded.filter((r) => r[key] <= k).length / graded.length;
  const mrr = (key) => mean(graded.map((r) => (Number.isFinite(r[key]) ? 1 / r[key] : 0)));
  console.log(`== ${label}: ${rows.length} queries, ${graded.length} with an expected site\n`);
  table(
    [
      ['hit@1', pct(hitAt('rawHit', 1)), pct(hitAt('rankedHit', 1))],
      ['hit@3', pct(hitAt('rawHit', 3)), pct(hitAt('rankedHit', 3))],
      ['hit@5', pct(hitAt('rawHit', 5)), pct(hitAt('rankedHit', 5))],
      ['MRR', f2(mrr('rawHit')), f2(mrr('rankedHit'))],
    ],
    ['expected site', 'SearXNG order', 'app reranked'],
  );
  table(
    [
      ['results per query', f1(mean(rows.map((r) => r.n)))],
      [`multi-engine share of top ${TOP}`, pct(mean(rows.map((r) => r.agreement)))],
      [`grouping-pass displacement of top ${TOP} (positions)`, f1(mean(rows.map((r) => r.displaced)))],
      [`max results from one host in top ${TOP}`, f1(mean(rows.map((r) => r.maxHost)))],
      ['queries with an unresponsive engine', pct(rows.filter((r) => r.unresponsive.length).length / rows.length)],
      ['p50 / p90 latency (s)', `${f2(quantile(rows.map((r) => r.ms), 0.5) / 1000)} / ${f2(quantile(rows.map((r) => r.ms), 0.9) / 1000)}`],
    ],
    ['metric', 'value'],
  );
  const engineNames = [...new Set(rows.flatMap((r) => r.engines))].sort();
  table(
    engineNames.map((e) => [
      e,
      pct(rows.filter((r) => r.engines.includes(e)).length / rows.length),
      f1(mean(rows.map((r) => r.slots[e] ?? 0))),
      f1(mean(rows.map((r) => r.solo[e] ?? 0))),
      String(rows.reduce((n, r) => n + r.unresponsive.filter((u) => u.startsWith(e + ' (')).length, 0)),
    ]),
    ['engine', 'contributed', `top-${TOP} slots`, 'solo slots', 'unresponsive'],
  );
  if (VERBOSE) {
    for (const r of rows) {
      const hit = r.rawHit === null ? '' : ` expected@${Number.isFinite(r.rawHit) ? r.rawHit : '-'}→${Number.isFinite(r.rankedHit) ? r.rankedHit : '-'}`;
      console.log(`${r.q}${hit}  [${r.n} results, ${f1(r.ms / 1000)}s${r.unresponsive.length ? `, unresponsive: ${r.unresponsive.join(', ')}` : ''}]`);
      r.ranked.slice(0, 5).forEach((u, i) => console.log(`   ${i + 1}. ${u}`));
    }
    console.log();
  }
  return rows;
}

async function mergedMode() {
  const queries = await loadQueries();
  console.log(`Merged run: ${queries.length} queries against ${BASE} (${CATEGORY}, language ${LANG})\n`);
  const records = [];
  for (const [qi, { q, expect }] of queries.entries()) {
    if (qi) await sleep(DELAY);
    const r = await searx(q);
    if (!r.ok) {
      console.log(`  ${q}: request failed (${r.error})`);
      continue;
    }
    records.push({ q, expect, ms: r.ms, data: r.data });
  }
  if (flags.save) {
    await mkdir(flags.save, { recursive: true });
    for (const rec of records) {
      const name = rec.q.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) + '.json';
      await writeFile(path.join(flags.save, name), JSON.stringify(rec));
    }
    console.log(`saved ${records.length} responses to ${flags.save}\n`);
  }
  summarise(records, BASE);
}

async function loadDir(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
}

async function compareMode() {
  const [a, b] = positional;
  if (!a || !b) throw new Error('compare needs two saved directories');
  summarise(await loadDir(a), a);
  summarise(await loadDir(b), b);
}

const modes = { engines: enginesMode, merged: mergedMode, compare: compareMode };
if (!modes[mode]) {
  console.error(`unknown mode "${mode}"; use engines | merged | compare`);
  process.exit(2);
}
await modes[mode]();
