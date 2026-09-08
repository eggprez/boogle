import { config } from './config.js';

export type Tab = 'web' | 'images' | 'news' | 'videos';
export const TABS: Tab[] = ['web', 'images', 'news', 'videos'];
const CATEGORY: Record<Tab, string> = {
  web: 'general',
  images: 'images',
  news: 'news',
  videos: 'videos',
};

export type TimeRange = '' | 'day' | 'week' | 'month' | 'year';
export const TIME_RANGES: { id: TimeRange; label: string }[] = [
  { id: '', label: 'Any time' },
  { id: 'day', label: 'Past day' },
  { id: 'week', label: 'Past week' },
  { id: 'month', label: 'Past month' },
  { id: 'year', label: 'Past year' },
];
export function parseTimeRange(v: unknown): TimeRange {
  return v === 'day' || v === 'week' || v === 'month' || v === 'year' ? v : '';
}

export interface SearxResult {
  url: string;
  title: string;
  content?: string;
  engine?: string;
  engines?: string[];
  category?: string;
  publishedDate?: string | null;
  thumbnail?: string | null;
  thumbnail_src?: string | null;
  img_src?: string | null;
  iframe_src?: string | null;
  author?: string | null;
  length?: string | null;
  score?: number;
  resolution?: string | null;
  source?: string | null;
}

export interface SearxInfobox {
  infobox: string;
  id?: string;
  content?: string;
  img_src?: string | null;
  urls?: { title: string; url: string }[];
  attributes?: { label: string; value: string }[];
}

export interface SearxAnswer {
  answer: string;
  url?: string;
  engine?: string;
}

export interface SearxResponse {
  query: string;
  number_of_results: number;
  results: SearxResult[];
  suggestions: string[];
  answers: (string | SearxAnswer)[];
  infoboxes: SearxInfobox[];
  corrections: string[];
  unresponsive_engines: [string, string][];
}

export interface SearchOptions {
  safesearch: 0 | 1 | 2;
  language: string;
  timeRange?: TimeRange;
  /** bypass the short-lived memo (the user clicked "Retry") */
  fresh?: boolean;
}

// Short-lived memo so the results page and the overview SSE stream (which
// starts a moment later) share one SearXNG request.
const memo = new Map<string, { at: number; value: Promise<SearxResponse> }>();
const MEMO_MS = 5 * 60 * 1000;

// Two attempts: a quick one, then a more patient one. SearXNG occasionally
// stalls on a slow upstream engine; a retry usually comes back in a second.
const ATTEMPT_TIMEOUTS_MS = [12_000, 18_000];

export function search(q: string, tab: Tab, page: number, opts: SearchOptions): Promise<SearxResponse> {
  const { fresh, ...rest } = opts;
  const key = JSON.stringify([q, tab, page, rest]);
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && !fresh && now - hit.at < MEMO_MS) return hit.value;

  const params = new URLSearchParams({
    q,
    format: 'json',
    categories: CATEGORY[tab],
    pageno: String(page),
    safesearch: String(opts.safesearch),
    language: opts.language || 'auto',
  });
  if (opts.timeRange) params.set('time_range', opts.timeRange);

  const value = (async () => {
    let lastErr: Error | null = null;
    for (const timeout of ATTEMPT_TIMEOUTS_MS) {
      try {
        return await fetchSearch(params, timeout);
      } catch (err) {
        lastErr = err as Error;
        if (!isRetryable(lastErr)) break;
      }
    }
    throw lastErr ?? new Error('SearXNG request failed');
  })();
  memo.set(key, { at: now, value });
  value.catch(() => memo.delete(key));
  if (memo.size > 200) {
    for (const [k, v] of memo) if (now - v.at > MEMO_MS) memo.delete(k);
  }
  return value;
}

async function fetchSearch(params: URLSearchParams, timeoutMs: number): Promise<SearxResponse> {
  const res = await fetch(`${config.searxngUrl}/search?${params}`, {
    // SearXNG's bot detection logs an error when no client IP header is
    // present, even with the limiter off. We're the only client, so say so.
    headers: { Accept: 'application/json', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`SearXNG responded ${res.status} ${res.statusText}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const data = (await res.json()) as SearxResponse;
  data.results ??= [];
  data.suggestions ??= [];
  data.answers ??= [];
  data.infoboxes ??= [];
  data.corrections ??= [];
  data.unresponsive_engines ??= [];
  return data;
}

function isRetryable(err: Error & { status?: number; name?: string }): boolean {
  if (err.status !== undefined) return err.status >= 500 || err.status === 429;
  // timeouts, connection resets, DNS hiccups
  return true;
}

export async function autocomplete(q: string): Promise<string[]> {
  const res = await fetch(`${config.searxngUrl}/autocompleter?q=${encodeURIComponent(q)}`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as unknown;
  // SearXNG returns OpenSearch format: [query, [suggestions...]]
  if (Array.isArray(data) && Array.isArray(data[1])) return data[1].map(String);
  if (Array.isArray(data)) return data.map(String);
  return [];
}

export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${config.searxngUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
