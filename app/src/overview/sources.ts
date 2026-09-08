import type { SearxResult } from '../searxng.js';

/** Sites that never yield readable article text when fetched server-side. */
const UNREADABLE_HOSTS = [
  'youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'pinterest.com', 'facebook.com',
  'instagram.com', 'tiktok.com', 'linkedin.com', 'threads.net', 'spotify.com',
];
const UNREADABLE_PATH = /\.(pdf|zip|gz|tar|exe|dmg|mp4|mp3|png|jpe?g|gif|webp|svg|pptx?|xlsx?|docx?)$/i;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function isUnreadable(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (UNREADABLE_HOSTS.some((x) => h === x || h.endsWith('.' + x))) return true;
    return UNREADABLE_PATH.test(u.pathname);
  } catch {
    return true;
  }
}

/**
 * Choose which results the overview is written from.
 *  - drop non-http URLs and duplicates
 *  - in deep mode skip hosts we cannot extract text from (videos, social)
 *  - at most `perHost` results per site so one domain cannot dominate
 *  - results that several engines agreed on float above single-engine ones,
 *    while otherwise keeping SearXNG's order
 */
export function pickSources(results: SearxResult[], max: number, opts: { deep?: boolean; perHost?: number } = {}): SearxResult[] {
  const perHost = opts.perHost ?? 2;
  const seen = new Set<string>();
  const candidates: SearxResult[] = [];
  for (const r of results) {
    if (!r.url || !/^https?:/i.test(r.url)) continue;
    if (opts.deep && isUnreadable(r.url)) continue;
    const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(r);
    if (candidates.length >= max * 3) break;
  }

  // Stable partition: multi-engine agreement first, then everything else.
  const agreed = candidates.filter((r) => (r.engines?.length ?? 0) >= 2);
  const rest = candidates.filter((r) => (r.engines?.length ?? 0) < 2);

  const out: SearxResult[] = [];
  const hostCount = new Map<string, number>();
  for (const r of [...agreed, ...rest]) {
    const h = hostOf(r.url);
    const n = hostCount.get(h) ?? 0;
    if (n >= perHost) continue;
    hostCount.set(h, n + 1);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}
