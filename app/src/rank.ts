import type { SearxResult, Tab } from './searxng.js';

// SearXNG scores every merged result as
//   Π(weights of the engines that returned it) × (number of those engines) × Σ 1/position
// and sorts by that. It then runs a second pass that groups results sharing a
// (category, template, has-thumbnail) key: each later member of a group is
// inserted right behind the group's first member, up to eight of them. In the
// web tab that pass moves every result with a page thumbnail (Brave attaches
// one to most of its hits) behind up to eight thumbnail-less results, so a
// score-5 result routinely shows up tenth behind score-0.6 ones. The JSON
// response carries the score, so the app restores the score order itself.
//
// On top of that, web results get a soft per-host cap: from the third result
// of the same site onwards they move to the end of the page, the way Google
// collapses a site to two entries. Other tabs keep the pure score order
// (many images or videos from one host are fine).

const PER_HOST = 2;

export function rankResults(results: SearxResult[], tab: Tab): SearxResult[] {
  // Array.prototype.sort is stable, so results without a score keep SearXNG's order.
  const byScore = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (tab !== 'web') return byScore;

  const seen = new Map<string, number>();
  const kept: SearxResult[] = [];
  const deferred: SearxResult[] = [];
  for (const r of byScore) {
    const h = rankHost(r.url);
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    (n < PER_HOST ? kept : deferred).push(r);
  }
  return kept.concat(deferred);
}

function rankHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url;
  }
}
