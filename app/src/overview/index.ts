import { config } from '../config.js';
import { cacheKey, deleteCached, getCached, putCached } from '../cache.js';
import { search, type SearxResult } from '../searxng.js';
import type { Model, OverviewMode, Settings } from '../settings.js';
import { runClaudeOverview, type OverviewSource } from './claude.js';
import { fetchReadable } from './pages.js';

export type OverviewEvent =
  | { type: 'status'; stage: 'searching' | 'reading' | 'writing'; detail?: string }
  | { type: 'sources'; sources: PublicSource[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; cached: boolean; model: Model; mode: OverviewMode; createdAt: number; costUsd?: number }
  | { type: 'error'; message: string };

export interface PublicSource {
  n: number;
  title: string;
  url: string;
  host: string;
}

// A subscription has a usage budget; never let a burst of tabs fan out into
// many simultaneous Claude processes.
let running = 0;
const waiters: (() => void)[] = [];
async function acquire(signal: AbortSignal): Promise<() => void> {
  while (running >= config.maxConcurrentOverviews) {
    if (signal.aborted) throw new Error('aborted');
    await new Promise<void>((r) => waiters.push(r));
  }
  running++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running--;
    waiters.shift()?.();
  };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function pickSources(results: SearxResult[], max: number): SearxResult[] {
  const seen = new Set<string>();
  const out: SearxResult[] = [];
  for (const r of results) {
    if (!r.url || !/^https?:/i.test(r.url)) continue;
    const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

export async function* generateOverview(opts: {
  query: string;
  settings: Settings;
  mode: OverviewMode;
  refresh: boolean;
  signal: AbortSignal;
}): AsyncGenerator<OverviewEvent> {
  const { query, settings, mode, signal } = opts;
  const model = settings.model;
  const key = cacheKey(['v1', query.trim().toLowerCase(), mode, model, settings.language]);

  if (opts.refresh) await deleteCached(key);
  else {
    const hit = await getCached(key);
    if (hit) {
      yield { type: 'sources', sources: hit.sources };
      yield { type: 'delta', text: hit.text };
      yield { type: 'done', cached: true, model: hit.model as Model, mode: hit.mode as OverviewMode, createdAt: hit.createdAt };
      return;
    }
  }

  yield { type: 'status', stage: 'searching' };
  let results: SearxResult[];
  try {
    const res = await search(query, 'web', 1, { safesearch: settings.safesearch, language: settings.language });
    results = res.results;
  } catch (err) {
    yield { type: 'error', message: `Search failed: ${(err as Error).message}` };
    return;
  }
  if (signal.aborted) return;

  const deep = mode === 'deep';
  const picked = pickSources(results, deep ? Math.max(config.deepReadPages * 2, 8) : config.snippetSources);
  if (!picked.length) {
    yield { type: 'error', message: 'No results to summarize.' };
    return;
  }

  let sources: OverviewSource[];
  if (deep) {
    yield { type: 'status', stage: 'reading', detail: `Reading up to ${config.deepReadPages} pages` };
    const pages = await Promise.all(picked.map((r) => fetchReadable(r.url)));
    if (signal.aborted) return;
    sources = [];
    // Pages that yielded text come first (full text); the rest fall back to
    // snippets so the model still knows they exist.
    for (let i = 0; i < picked.length && sources.filter((s) => s.deep).length < config.deepReadPages; i++) {
      const p = pages[i];
      if (p) sources.push({ n: 0, title: p.title || picked[i].title, url: picked[i].url, host: hostOf(picked[i].url), text: p.text, deep: true });
    }
    for (let i = 0; i < picked.length && sources.length < config.deepReadPages + 3; i++) {
      if (sources.some((s) => s.url === picked[i].url)) continue;
      sources.push({ n: 0, title: picked[i].title, url: picked[i].url, host: hostOf(picked[i].url), text: picked[i].content ?? '' });
    }
    if (!sources.some((s) => s.deep)) {
      yield { type: 'status', stage: 'reading', detail: 'No pages were readable; falling back to snippets' };
    }
  } else {
    sources = picked.map((r) => ({ n: 0, title: r.title, url: r.url, host: hostOf(r.url), text: r.content ?? '' }));
  }
  sources.forEach((s, i) => (s.n = i + 1));

  const publicSources: PublicSource[] = sources.map((s) => ({ n: s.n, title: s.title, url: s.url, host: s.host }));
  yield { type: 'sources', sources: publicSources };
  yield { type: 'status', stage: 'writing', detail: model };

  let release: (() => void) | null = null;
  try {
    release = await acquire(signal);
  } catch {
    return;
  }

  try {
    let finalText = '';
    let costUsd: number | undefined;
    for await (const ev of runClaudeOverview({ query, sources, model, deep, signal })) {
      if (ev.type === 'delta') yield ev;
      else if (ev.type === 'error') {
        yield ev;
        return;
      } else if (ev.type === 'done') {
        finalText = ev.text;
        costUsd = ev.costUsd;
      }
    }
    if (signal.aborted) return;
    const createdAt = Date.now();
    await putCached({ key, query, mode, model, text: finalText, sources: publicSources, createdAt });
    yield { type: 'done', cached: false, model, mode, createdAt, costUsd };
  } finally {
    release();
  }
}
