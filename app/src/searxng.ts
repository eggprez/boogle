import { config } from './config.js';

export type Tab = 'web' | 'images' | 'news' | 'videos';
export const TABS: Tab[] = ['web', 'images', 'news', 'videos'];
const CATEGORY: Record<Tab, string> = {
  web: 'general',
  images: 'images',
  news: 'news',
  videos: 'videos',
};

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
  timeRange?: '' | 'day' | 'week' | 'month' | 'year';
}

// Short-lived memo so the results page and the overview SSE stream (which
// starts a moment later) share one SearXNG request.
const memo = new Map<string, { at: number; value: Promise<SearxResponse> }>();
const MEMO_MS = 5 * 60 * 1000;

export function search(q: string, tab: Tab, page: number, opts: SearchOptions): Promise<SearxResponse> {
  const key = JSON.stringify([q, tab, page, opts]);
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < MEMO_MS) return hit.value;

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
    const res = await fetch(`${config.searxngUrl}/search?${params}`, {
      // SearXNG's bot detection logs an error when no client IP header is
      // present, even with the limiter off. We're the only client, so say so.
      headers: { Accept: 'application/json', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`SearXNG responded ${res.status} ${res.statusText}`);
    const data = (await res.json()) as SearxResponse;
    data.results ??= [];
    data.suggestions ??= [];
    data.answers ??= [];
    data.infoboxes ??= [];
    data.corrections ??= [];
    data.unresponsive_engines ??= [];
    return data;
  })();
  memo.set(key, { at: now, value });
  value.catch(() => memo.delete(key));
  if (memo.size > 200) {
    for (const [k, v] of memo) if (now - v.at > MEMO_MS) memo.delete(k);
  }
  return value;
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
