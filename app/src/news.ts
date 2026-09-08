import { search, type SearchOptions, type SearxResult, type TimeRange } from './searxng.js';

// "Top stories": Google puts a strip of news above the web results when a
// query "deserves freshness". This is the same idea on SearXNG's news
// category: a news search runs alongside the web search and the strip is
// shown only when the coverage is both recent and actually about the query.

/** How old a story may be and still count as coverage. */
const MAX_AGE_MS = 7 * 86_400_000;
/** The newest story has to be at most this old for the topic to count as current. */
const CURRENT_MS = 2 * 86_400_000;
/** Show the strip only with this many distinct-source stories. */
const MIN_STORIES = 3;
const MAX_STORIES = 4;
/** The news search must not hold the page up: past this it is simply left out. */
const BUDGET_MS = 7_000;

const STOP = new Set(
  'a an and are as at be but by for from how in is it of on or that the this to was what when where which who why will with vs'.split(' '),
);

/** The query's meaningful terms: lowercased, punctuation stripped, stop words out. */
export function queryTerms(q: string): string[] {
  const seen = new Set<string>();
  return q
    .toLowerCase()
    .replace(/["'’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOP.has(t) && !seen.has(t) && seen.add(t));
}

/**
 * The stories worth a strip for this query, or an empty list. A story
 * qualifies when its title or snippet mentions most of the query's terms
 * and it is under a week old; the strip needs three of those from three
 * different sites, and the topic has to be current: a dated story under
 * two days old, or mostly undated stories.
 *
 * Dates are the weak part: of the news engines only Reuters (and Google
 * News, when it answers) stamp a publishedDate; Bing News and Startpage
 * News never do. The news search is already limited to the past week, so an
 * undated story from it counts as recent rather than being thrown away, or
 * "apple event" on the day of the event would show nothing.
 */
export function pickStories(q: string, results: SearxResult[], now = Date.now()): SearxResult[] {
  const terms = queryTerms(q);
  if (!terms.length) return [];
  const needed = terms.length === 1 ? 1 : Math.ceil(terms.length * 0.6);

  const fresh: { r: SearxResult; age: number | null }[] = [];
  for (const r of results) {
    if (!r.url || !r.title) continue;
    let age: number | null = null;
    if (r.publishedDate) {
      const t = new Date(r.publishedDate).getTime();
      if (!Number.isNaN(t)) {
        age = now - t;
        if (age > MAX_AGE_MS || age < -3_600_000) continue;
      }
    }
    const text = `${r.title} ${r.content ?? ''}`.toLowerCase();
    let matched = 0;
    for (const term of terms) if (text.includes(term)) matched++;
    if (matched >= needed) fresh.push({ r, age });
  }
  if (!fresh.length) return [];

  // One story per site, in SearXNG's relevance order.
  const hosts = new Set<string>();
  const picked: SearxResult[] = [];
  for (const { r } of fresh) {
    const h = hostKey(r.url);
    if (hosts.has(h)) continue;
    hosts.add(h);
    picked.push(r);
    if (picked.length === MAX_STORIES) break;
  }
  if (picked.length < MIN_STORIES) return [];
  const dated = fresh.filter((f) => f.age !== null) as { r: SearxResult; age: number }[];
  const current = dated.some((f) => f.age <= CURRENT_MS) || dated.length * 2 < fresh.length;
  return current ? picked : [];
}

function hostKey(url: string): string {
  try {
    return new URL(url).hostname.replace(/^(www|amp|m)\./, '').toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Run the news search for a web query and return the strip's stories.
 * Never throws and never takes longer than the budget: the page renders
 * without the strip rather than waiting on a slow news engine.
 */
export async function topStories(q: string, opts: SearchOptions): Promise<SearxResult[]> {
  const timeRange: TimeRange = opts.timeRange === 'day' ? 'day' : 'week';
  const news = search(q, 'news', 1, { ...opts, timeRange }).then(
    (data) => pickStories(q, data.results),
    () => [] as SearxResult[],
  );
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<SearxResult[]>((resolve) => {
    timer = setTimeout(() => resolve([]), BUDGET_MS);
  });
  try {
    return await Promise.race([news, late]);
  } finally {
    clearTimeout(timer);
  }
}
