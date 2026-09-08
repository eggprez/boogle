import { config } from './config.js';
import type { SearxResult, TimeRange } from './searxng.js';

// Reddit results come from the Reddit worker (reddit/worker.mjs): a headless
// browser on the private network that searches reddit.com for queries people
// ran and keeps the answers on disk. Its /results endpoint replies from that
// cache at once and queues anything it does not have yet, so a lookup never
// waits on a browser. The results are folded into SearXNG's list here the
// way SearXNG itself would have scored an engine called "reddit".

export interface RedditResult {
  url: string;
  title: string;
  content?: string;
  publishedDate?: string | null;
  thumbnail?: string | null;
}

export type RedditStatus = 'hit' | 'stale' | 'queued' | 'off' | 'error';
export interface RedditLookup {
  status: RedditStatus;
  results: RedditResult[];
}

export interface RedditHealth {
  ok: boolean;
  browser?: string;
  queue?: number;
  cached?: number;
  blockedForSeconds?: number;
}

/** Ask the worker for cached results; never throws, never waits long. */
export async function lookupReddit(q: string, timeRange: TimeRange | undefined, timeoutMs = 1500): Promise<RedditLookup> {
  if (!config.redditWorkerUrl) return { status: 'off', results: [] };
  try {
    const params = new URLSearchParams({ q });
    if (timeRange) params.set('t', timeRange);
    const res = await fetch(`${config.redditWorkerUrl}/results?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { status: 'error', results: [] };
    const data = (await res.json()) as { status?: string; results?: unknown };
    const status: RedditStatus = data.status === 'hit' || data.status === 'stale' || data.status === 'queued' ? data.status : 'error';
    const results = Array.isArray(data.results)
      ? (data.results as RedditResult[]).filter((r) => r && typeof r.url === 'string' && typeof r.title === 'string')
      : [];
    return { status, results };
  } catch {
    return { status: 'error', results: [] };
  }
}

export async function redditHealth(): Promise<RedditHealth | null> {
  if (!config.redditWorkerUrl) return null;
  try {
    const res = await fetch(`${config.redditWorkerUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false };
    const h = (await res.json()) as RedditHealth;
    return { ok: !!h.ok, browser: h.browser, queue: h.queue, cached: h.cached, blockedForSeconds: h.blockedForSeconds };
  } catch {
    return { ok: false };
  }
}

// At most this many threads SearXNG did not already know about are added to a
// page; the per-host cap in rank.ts then keeps all but two of them at the end.
const MAX_NEW = 10;

/**
 * Identity of a Reddit thread across the hosts and slugs it is linked under
 * (www/old/new, with or without the title slug or a trailing slash).
 */
export function redditKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/comments\/([a-z0-9]+)/i);
    return m ? `t3_${m[1].toLowerCase()}` : u.pathname.replace(/\/+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Fold Reddit results into SearXNG's scored list. SearXNG scores a result as
 * Π(engine weights) × (#engines) × Σ 1/position; a thread SearXNG already
 * lists gets the same agreement bonus another engine would have given it,
 * and a new thread scores like a single-engine result at that position.
 */
export function mergeReddit(results: SearxResult[], reddit: RedditResult[], weight = config.redditWeight): SearxResult[] {
  if (!reddit.length) return results;
  const byKey = new Map<string, SearxResult>();
  for (const r of results) {
    const k = redditKey(r.url);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }
  const out = results.slice();
  let added = 0;
  reddit.forEach((rr, i) => {
    const position = i + 1;
    const own = weight / position;
    const k = redditKey(rr.url);
    const hit = k ? byKey.get(k) : undefined;
    if (hit) {
      const engines = hit.engines ?? (hit.engine ? [hit.engine] : []);
      if (engines.includes('reddit')) return;
      const n = Math.max(engines.length, 1);
      hit.engines = [...engines, 'reddit'];
      hit.score = ((hit.score ?? 0) * weight * (n + 1)) / n + own * (n + 1);
      hit.content ||= rr.content;
      hit.thumbnail ||= rr.thumbnail ?? null;
      hit.publishedDate ||= rr.publishedDate ?? null;
      return;
    }
    if (added >= MAX_NEW) return;
    added++;
    out.push({
      url: rr.url,
      title: rr.title,
      content: rr.content,
      engine: 'reddit',
      engines: ['reddit'],
      category: 'general',
      publishedDate: rr.publishedDate ?? null,
      thumbnail: rr.thumbnail ?? null,
      score: own,
    });
  });
  return out;
}
