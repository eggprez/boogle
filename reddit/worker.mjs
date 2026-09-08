// Boogle's Reddit worker.
//
// reddit.com answers plain server requests with HTTP 403, its official API
// needs per-user app credentials, and the third-party archives rate-limit.
// A real browser gets through, but a browser search takes seconds, so it
// never sits in the request path. Instead:
//
//   GET /results?q=...&t=day|week|month|year
//       answers from the on-disk cache at once. A miss (or a stale hit) puts
//       the query on a queue; the reply says so. The app merges whatever came
//       back into its results, so the first search for a query is thinner
//       and the repeats are full.
//   GET /healthz
//       queue length, cache size, whether the browser is up, back-off state.
//
// One headless Chromium with a persistent profile works the queue, one query
// every REDDIT_MIN_INTERVAL_MS (plus jitter), only for queries a person ran.
// It asks for Reddit's search JSON from inside a page on reddit.com (a fetch
// the site treats as its own front end making; the same request from outside
// the page is refused), which gives scores, comment counts and thumbnails.
// If that is refused it loads the rendered search page, reads the posts out
// of the DOM, and tries the JSON once more, since the page visit is what
// earns the cookies. HTTP 403/429 means "blocked for now": the worker backs
// off (1 min, doubling to 30 min) and keeps the query for later.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] && Number.isFinite(v) ? v : fallback;
};
const PORT = num('PORT', 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const MIN_INTERVAL_MS = num('REDDIT_MIN_INTERVAL_MS', 5000);
const TTL_MS = num('REDDIT_CACHE_TTL_HOURS', 72) * 3600_000;
const MAX_RESULTS = Math.min(num('REDDIT_MAX_RESULTS', 20), 100);
const QUEUE_MAX = num('REDDIT_QUEUE_MAX', 100);
const NAV_TIMEOUT_MS = 30_000;
const TIME_RANGES = new Set(['day', 'week', 'month', 'year']);
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const PROFILE_DIR = path.join(DATA_DIR, 'profile');

const log = (...a) => console.log(new Date().toISOString(), 'reddit:', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- queue ------------------------------------------------------------------
const queue = []; // [{ key, q, t }]
const queued = new Set();
const state = {
  browser: 'starting', // starting | ready | error
  browserError: '',
  nextAllowedAt: 0,
  blockedUntil: 0,
  backoffMs: 0,
  fetched: 0,
  failed: 0,
  last: null, // { q, results, via, ms, at }
};

function keyOf(q, t) {
  return createHash('sha256').update(`${q.toLowerCase()}\n${t}`).digest('hex');
}
function normalizeQuery(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 256);
}
function enqueue(key, q, t) {
  if (queued.has(key)) return;
  if (queue.length >= QUEUE_MAX) {
    const dropped = queue.shift();
    queued.delete(dropped.key);
  }
  queue.push({ key, q, t });
  queued.add(key);
  void drain();
}

// ---- cache ------------------------------------------------------------------
async function load(key) {
  try {
    return JSON.parse(await readFile(path.join(CACHE_DIR, key + '.json'), 'utf8'));
  } catch {
    return null;
  }
}
async function store(entry) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path.join(CACHE_DIR, entry.key + '.json'), JSON.stringify(entry));
}
async function cacheStats() {
  let entries = 0;
  try {
    for (const f of await readdir(CACHE_DIR)) if (f.endsWith('.json')) entries++;
  } catch {
    /* no cache yet */
  }
  return { entries };
}
// Stale entries are still served while a refresh is queued, so keep them for
// twice the TTL before throwing them away.
async function prune() {
  let removed = 0;
  try {
    for (const f of await readdir(CACHE_DIR)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(CACHE_DIR, f);
      if (Date.now() - (await stat(p)).mtimeMs > 2 * TTL_MS) {
        await unlink(p).catch(() => {});
        removed++;
      }
    }
  } catch {
    /* no cache yet */
  }
  if (removed) log(`pruned ${removed} expired entries`);
}

// ---- browser ----------------------------------------------------------------
let context = null;
let page = null;
let warmed = false;

async function launch() {
  await mkdir(PROFILE_DIR, { recursive: true });
  const opts = {
    headless: true,
    channel: 'chromium', // the full browser in new headless mode, not the headless shell
    args: ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    serviceWorkers: 'block',
  };
  let ctx = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  let pg = ctx.pages()[0] ?? (await ctx.newPage());
  const ua = await pg.evaluate(() => navigator.userAgent);
  if (/HeadlessChrome/.test(ua)) {
    // Present the same version string a normal Chrome of this build would.
    await ctx.close();
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, userAgent: ua.replace('HeadlessChrome', 'Chrome') });
    pg = ctx.pages()[0] ?? (await ctx.newPage());
  }
  // Pictures and fonts are not needed to read a result list.
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    return t === 'image' || t === 'media' || t === 'font' ? route.abort() : route.continue();
  });
  context = ctx;
  page = pg;
  warmed = false;
  state.browser = 'ready';
  state.browserError = '';
  log(`browser up (${await ctx.browser()?.version?.() ?? 'chromium'})`);
}

// One launch at a time: the startup launch and the first job must not both
// open the profile (Chromium refuses a profile that is already in use).
let launching = null;
async function browserPage() {
  if (context && page && !page.isClosed()) return page;
  launching ??= (async () => {
    try {
      if (context) await context.close().catch(() => {});
      await launch();
    } catch (err) {
      state.browser = 'error';
      state.browserError = String(err?.message ?? err);
      context = null;
      throw err;
    } finally {
      launching = null;
    }
  })();
  await launching;
  return page;
}

// ---- fetching ---------------------------------------------------------------
class Blocked extends Error {
  constructor(msg) {
    super(msg);
    this.blocked = true;
  }
}

function clean(s, max = 300) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).replace(/\s\S*$/, '') + '…' : t;
}
function meta(sub, score, comments) {
  const parts = [];
  if (sub) parts.push(sub);
  if (Number.isFinite(score)) parts.push(`${score} points`);
  if (Number.isFinite(comments)) parts.push(`${comments} comments`);
  return parts.join(' · ');
}

/** Reddit's search JSON (the same shape the official API returns). */
function parseJson(data) {
  const children = data?.data?.children;
  if (!Array.isArray(children)) return null;
  const out = [];
  for (const child of children) {
    const d = child?.data ?? {};
    if (!d.permalink || !d.title) continue;
    let thumb = typeof d.thumbnail === 'string' && d.thumbnail.startsWith('http') ? d.thumbnail : '';
    if (!thumb) thumb = d.preview?.images?.[0]?.resolutions?.[0]?.url ?? '';
    const body = clean(d.selftext);
    const m = meta(d.subreddit_name_prefixed, d.score, d.num_comments);
    out.push({
      url: 'https://www.reddit.com' + d.permalink,
      title: clean(d.title, 300),
      content: body ? `${m} · ${body}` : m,
      publishedDate: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      thumbnail: thumb || null,
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** Posts out of the rendered search page, for when the JSON is refused. */
async function parseDom(pg) {
  const raw = await pg.evaluate((max) => {
    const seen = new Set();
    const out = [];
    const threadOf = (href) => (href || '').match(/^(?:https?:\/\/[^/]+)?(\/r\/[^/]+\/comments\/[a-z0-9]+)/i)?.[1];
    // Reddit's search page (2026): each hit has a title link
    // <a data-testid="post-title-text" href="/r/…/comments/…">, usually
    // followed by a second link to the same thread carrying the snippet.
    // Feeds elsewhere use <shreddit-post> elements with the data in
    // attributes; any other link into a thread is the last resort.
    const push = (href, title, extra = {}) => {
      const key = threadOf(href);
      const t = (title || '').replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key) || t.length < 8) return;
      seen.add(key);
      out.push({ url: new URL(href, location.origin).href.split(/[?#]/)[0], title: t, subreddit: '', score: NaN, comments: NaN, created: '', snippet: '', ...extra });
    };
    for (const a of document.querySelectorAll('a[data-testid="post-title-text"]')) {
      const href = a.getAttribute('href');
      const key = threadOf(href);
      let snippet = '';
      for (const b of document.querySelectorAll(`a[href*="${key}"]:not([data-testid])`)) {
        snippet = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (snippet) break;
      }
      push(href, a.textContent, { snippet });
      if (out.length >= max) break;
    }
    for (const el of document.querySelectorAll('shreddit-post')) {
      if (out.length >= max) break;
      push(el.getAttribute('permalink'), el.getAttribute('post-title'), {
        subreddit: el.getAttribute('subreddit-prefixed-name') || '',
        score: Number(el.getAttribute('score')),
        comments: Number(el.getAttribute('comment-count')),
        created: el.getAttribute('created-timestamp') || '',
      });
    }
    for (const a of document.querySelectorAll('a[href*="/comments/"]')) {
      if (out.length >= max) break;
      push(a.getAttribute('href'), a.getAttribute('aria-label') || a.textContent);
    }
    return out;
  }, MAX_RESULTS);
  return raw.map((r) => {
    const m = meta(r.subreddit, r.score, r.comments);
    const body = clean(r.snippet);
    return {
      url: r.url,
      title: clean(r.title, 300),
      content: body ? (m ? `${m} · ${body}` : body) : m,
      publishedDate: r.created && !Number.isNaN(Date.parse(r.created)) ? new Date(r.created).toISOString() : null,
      thumbnail: null,
    };
  });
}

// The JSON is fetched by the page itself, so it carries everything a real
// browser sends; Playwright's separate request client is refused (403) even
// with the same cookies. Same-origin, so the page must be on reddit.com.
async function getJson(pg, url) {
  const r = await pg
    .evaluate(
      async (u) => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 20_000);
        try {
          const res = await fetch(u, { headers: { accept: 'application/json' }, credentials: 'include', redirect: 'manual', signal: ctl.signal });
          return { status: res.status, text: res.ok ? await res.text() : '' };
        } finally {
          clearTimeout(timer);
        }
      },
      url,
    )
    .catch(() => null);
  if (!r) return { status: 0, results: null };
  if (r.status !== 200) return { status: r.status, results: null };
  let data = null;
  try {
    data = JSON.parse(r.text);
  } catch {
    /* not JSON: a block page with a 200 */
  }
  return { status: r.status, results: parseJson(data) };
}

async function fetchQuery(job) {
  const pg = await browserPage();
  if (!warmed || !pg.url().startsWith('https://www.reddit.com/')) {
    // A first visit to the front page collects the cookies the search
    // endpoints expect from a browser, and puts the page on reddit.com so
    // the JSON fetch below is same-origin.
    await pg.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
    await sleep(1500);
    warmed = true;
  }
  const jsonUrl =
    'https://www.reddit.com/search.json?' +
    new URLSearchParams({ q: job.q, sort: 'relevance', t: job.t || 'all', limit: String(MAX_RESULTS), type: 'link', raw_json: '1' });

  let { status, results } = await getJson(pg, jsonUrl);
  if (results) return { via: 'json', results };

  // Refused: load the real search page (which also refreshes the cookies),
  // then try the JSON once more before reading the page itself.
  const htmlUrl = 'https://www.reddit.com/search/?' + new URLSearchParams({ q: job.q, type: 'posts', t: job.t || 'all' });
  const nav = await pg.goto(htmlUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const navStatus = nav?.status() ?? 0;
  if (navStatus === 403 || navStatus === 429) throw new Blocked(`search page answered HTTP ${navStatus}`);
  await pg.waitForSelector('shreddit-post, a[href*="/comments/"]', { timeout: 15_000 }).catch(() => {});

  ({ status, results } = await getJson(pg, jsonUrl));
  if (results) return { via: 'json', results };

  const dom = await parseDom(pg);
  if (dom.length) return { via: 'dom', results: dom };

  const title = await pg.title().catch(() => '');
  if (status === 403 || status === 429 || /blocked|too many requests|access denied/i.test(title)) {
    throw new Blocked(`json HTTP ${status}, page "${title || navStatus}"`);
  }
  return { via: 'dom', results: [] };
}

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const wait = Math.max(state.nextAllowedAt, state.blockedUntil) - Date.now();
      if (wait > 0) await sleep(wait);
      const job = queue[0];
      const t0 = Date.now();
      try {
        const { via, results } = await fetchQuery(job);
        await store({ key: job.key, q: job.q, t: job.t, fetchedAt: Date.now(), via, results });
        queue.shift();
        queued.delete(job.key);
        state.backoffMs = 0;
        state.fetched++;
        state.last = { q: job.q, results: results.length, via, ms: Date.now() - t0, at: Date.now() };
        log(`"${job.q}"${job.t ? ` (${job.t})` : ''} -> ${results.length} results via ${via} in ${Date.now() - t0} ms (queue ${queue.length - 0})`);
      } catch (err) {
        if (err?.blocked) {
          state.backoffMs = Math.min(state.backoffMs ? state.backoffMs * 2 : 60_000, 30 * 60_000);
          state.blockedUntil = Date.now() + state.backoffMs;
          log(`blocked (${err.message}); pausing ${Math.round(state.backoffMs / 1000)} s, ${queue.length} queued`);
        } else {
          queue.shift();
          queued.delete(job.key);
          state.failed++;
          log(`"${job.q}" failed: ${err?.message ?? err}`);
          if (/closed|crashed|Target|browser has been/i.test(String(err?.message))) {
            context = null;
          }
        }
      }
      state.nextAllowedAt = Date.now() + MIN_INTERVAL_MS + Math.random() * 2000;
    }
  } finally {
    draining = false;
  }
}

// ---- http -------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const json = (o, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  try {
    if (u.pathname === '/healthz') {
      return json({
        ok: state.browser !== 'error',
        browser: state.browser,
        browserError: state.browserError || undefined,
        queue: queue.length,
        cached: (await cacheStats()).entries,
        blockedForSeconds: Math.max(0, Math.round((state.blockedUntil - Date.now()) / 1000)),
        fetched: state.fetched,
        failed: state.failed,
        last: state.last,
      });
    }
    if (u.pathname === '/results') {
      const q = normalizeQuery(u.searchParams.get('q'));
      if (!q) return json({ error: 'missing q' }, 400);
      const t = TIME_RANGES.has(u.searchParams.get('t')) ? u.searchParams.get('t') : '';
      const key = keyOf(q, t);
      const hit = await load(key);
      const fresh = hit && Date.now() - hit.fetchedAt < TTL_MS;
      if (!fresh) enqueue(key, q, t);
      return json({
        status: fresh ? 'hit' : hit ? 'stale' : 'queued',
        fetchedAt: hit?.fetchedAt ?? null,
        via: hit?.via ?? null,
        results: hit?.results ?? [],
      });
    }
    json({ error: 'not found' }, 404);
  } catch (err) {
    json({ error: String(err?.message ?? err) }, 500);
  }
});

await mkdir(CACHE_DIR, { recursive: true });
await prune();
setInterval(() => void prune(), 3600_000).unref();
server.listen(PORT, '0.0.0.0', () => {
  log(`listening on :${PORT}; one query every ${MIN_INTERVAL_MS} ms, cache ${TTL_MS / 3600_000} h, data in ${DATA_DIR}`);
});
// Bring the browser up now so a broken image shows in /healthz right away.
browserPage().catch((err) => log('browser failed to start:', err?.message ?? err));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig}, shutting down`);
    server.close();
    Promise.resolve(context?.close()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
