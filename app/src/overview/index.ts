import { config } from '../config.js';
import { cacheKey, deleteCached, getCached, putCached, type CachedOverview } from '../cache.js';
import { search, type SearxResult, type TimeRange } from '../searxng.js';
import type { Model, OverviewMode, Settings } from '../settings.js';
import { PROMPT_VERSION, runClaudeOverview, splitRelated, type FollowupTurn, type OverviewSource } from './claude.js';
import { fetchReadable } from './pages.js';
import { hostOf, pickSources } from './sources.js';

export type OverviewEvent =
  | { type: 'status'; stage: 'searching' | 'reading' | 'writing'; detail?: string }
  | { type: 'sources'; sources: PublicSource[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; cached: boolean; model: Model; mode: OverviewMode; createdAt: number; costUsd?: number; related?: string[] }
  | { type: 'error'; message: string };

export interface PublicSource {
  n: number;
  title: string;
  url: string;
  host: string;
  deep?: boolean;
}

export { hostOf };

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

/**
 * Cache key for an overview. Includes the prompt version so a prompt change
 * never serves an overview written under the old prompt.
 */
export function overviewKey(query: string, mode: OverviewMode, model: Model, language: string, timeRange: TimeRange = ''): string {
  return cacheKey(['v2', PROMPT_VERSION, query.trim().toLowerCase(), mode, model, language, timeRange]);
}

export async function* generateOverview(opts: {
  query: string;
  settings: Settings;
  mode: OverviewMode;
  refresh: boolean;
  signal: AbortSignal;
  timeRange?: TimeRange;
}): AsyncGenerator<OverviewEvent> {
  const { query, settings, mode, signal } = opts;
  const timeRange = opts.timeRange ?? '';
  const model = settings.model;
  const key = overviewKey(query, mode, model, settings.language, timeRange);

  if (opts.refresh) await deleteCached(key);
  else {
    const hit = await getCached(key);
    if (hit) {
      yield { type: 'sources', sources: hit.sources };
      yield { type: 'delta', text: hit.text };
      yield { type: 'done', cached: true, model: hit.model as Model, mode: hit.mode as OverviewMode, createdAt: hit.createdAt, related: hit.related ?? [] };
      return;
    }
  }

  yield { type: 'status', stage: 'searching' };
  let results: SearxResult[];
  try {
    const res = await search(query, 'web', 1, { safesearch: settings.safesearch, language: settings.language, timeRange });
    results = res.results;
  } catch (err) {
    yield { type: 'error', message: `Search failed: ${(err as Error).message}` };
    return;
  }
  if (signal.aborted) return;

  const deep = mode === 'deep';
  const picked = pickSources(results, deep ? Math.max(config.deepReadPages * 2, 8) : config.snippetSources, { deep });
  // Knowledge mode answers from the model itself; the results only supply
  // citations, so an empty list just means an uncited answer.
  if (!picked.length && mode !== 'knowledge') {
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

  const publicSources: PublicSource[] = sources.map((s) => ({ n: s.n, title: s.title, url: s.url, host: s.host, ...(s.deep ? { deep: true } : {}) }));
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
    for await (const ev of runClaudeOverview({ query, sources, model, mode, signal })) {
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
    const { text, related } = splitRelated(finalText);
    const createdAt = Date.now();
    await putCached({ key, query, mode, model, text, sources: publicSources, sourceTexts: sources.map((s) => s.text), related, createdAt });
    yield { type: 'done', cached: false, model, mode, createdAt, costUsd, related };
  } finally {
    release();
  }
}

/**
 * Answer a follow-up question about an overview that is already cached,
 * reusing its sources (with the text they contributed) as context.
 */
export async function* generateFollowup(opts: {
  query: string;
  question: string;
  history: FollowupTurn[];
  settings: Settings;
  mode: OverviewMode;
  timeRange?: TimeRange;
  signal: AbortSignal;
}): AsyncGenerator<OverviewEvent> {
  const { query, question, settings, mode, signal } = opts;
  const model = settings.model;
  const key = overviewKey(query, mode, model, settings.language, opts.timeRange ?? '');
  const hit: CachedOverview | null = await getCached(key);
  if (!hit || !hit.sourceTexts) {
    yield { type: 'error', message: 'The overview this follow-up refers to is no longer cached. Regenerate it first.' };
    return;
  }
  const sources: OverviewSource[] = hit.sources.map((s, i) => ({ ...s, text: hit.sourceTexts?.[i] ?? '' }));
  yield { type: 'sources', sources: hit.sources };
  yield { type: 'status', stage: 'writing', detail: model };

  let release: (() => void) | null = null;
  try {
    release = await acquire(signal);
  } catch {
    return;
  }
  try {
    const followup = { question, overview: hit.text, history: opts.history.slice(-3) };
    for await (const ev of runClaudeOverview({ query, sources, model, mode, signal, followup })) {
      if (ev.type === 'delta') yield ev;
      else if (ev.type === 'error') {
        yield ev;
        return;
      } else if (ev.type === 'done') {
        yield { type: 'done', cached: false, model, mode, createdAt: Date.now(), costUsd: ev.costUsd };
      }
    }
  } finally {
    release();
  }
}
