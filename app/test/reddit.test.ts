import { describe, expect, it } from 'vitest';
import { lookupReddit, mergeReddit, redditKey, type RedditResult } from '../src/reddit.js';
import { rankResults } from '../src/rank.js';
import type { SearxResult } from '../src/searxng.js';

const sx = (url: string, score: number, engines: string[] = ['google']): SearxResult => ({ url, title: url, score, engines });
const rd = (url: string, title = url): RedditResult => ({ url, title, content: 'r/test · 10 points · 3 comments' });

describe('redditKey', () => {
  it('identifies a thread across hosts, slugs and trailing slashes', () => {
    const k = redditKey('https://www.reddit.com/r/rust/comments/abc123/some_title/');
    expect(k).toBe('t3_abc123');
    expect(redditKey('https://old.reddit.com/r/rust/comments/ABC123')).toBe(k);
    expect(redditKey('https://reddit.com/r/rust/comments/abc123/other_slug/?utm=1')).toBe(k);
  });
  it('ignores other sites', () => {
    expect(redditKey('https://example.com/r/rust/comments/abc123/')).toBeNull();
    expect(redditKey('not a url')).toBeNull();
  });
});

describe('mergeReddit', () => {
  it('returns the list untouched when there is nothing to merge', () => {
    const list = [sx('https://a.com/', 2)];
    expect(mergeReddit(list, [], 0.8)).toBe(list);
  });
  it('appends unknown threads scored like a single engine at that position', () => {
    const out = mergeReddit([sx('https://a.com/', 2)], [rd('https://www.reddit.com/r/x/comments/one/t/'), rd('https://www.reddit.com/r/x/comments/two/t/')], 0.8);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ url: 'https://www.reddit.com/r/x/comments/one/t/', engines: ['reddit'], score: 0.8 });
    expect(out[2].score).toBeCloseTo(0.4);
  });
  it('gives a thread SearXNG already lists the agreement bonus instead of a duplicate', () => {
    const list = [sx('https://old.reddit.com/r/x/comments/one/', 1.0, ['google']), sx('https://b.com/', 0.9)];
    const out = mergeReddit(list, [rd('https://www.reddit.com/r/x/comments/one/some_title/')], 0.8);
    expect(out).toHaveLength(2);
    expect(out[0].engines).toEqual(['google', 'reddit']);
    // 1.0 × 0.8 × 2/1 + 0.8/1 × 2 = 3.2: two engines agreeing beat one at the top.
    expect(out[0].score).toBeCloseTo(3.2);
    expect(out[0].content).toBe('r/test · 10 points · 3 comments');
  });
  it('does not double-count when the merged list is merged again', () => {
    const list = [sx('https://www.reddit.com/r/x/comments/one/', 1.0, ['google'])];
    const once = mergeReddit(list, [rd('https://www.reddit.com/r/x/comments/one/')], 0.8);
    const twice = mergeReddit(once, [rd('https://www.reddit.com/r/x/comments/one/')], 0.8);
    expect(twice[0].engines).toEqual(['google', 'reddit']);
    expect(twice[0].score).toBeCloseTo(3.2);
  });
  it('adds at most ten new threads', () => {
    const many = Array.from({ length: 15 }, (_, i) => rd(`https://www.reddit.com/r/x/comments/id${i}/`));
    expect(mergeReddit([], many, 0.8)).toHaveLength(10);
  });
  it('ends up in score order with the per-host cap after ranking', () => {
    const list = [sx('https://a.com/', 2), sx('https://b.com/', 0.5)];
    const reddit = [rd('https://www.reddit.com/r/x/comments/one/'), rd('https://www.reddit.com/r/x/comments/two/'), rd('https://www.reddit.com/r/x/comments/three/')];
    const urls = rankResults(mergeReddit(list, reddit, 0.8), 'web').map((r) => r.url);
    expect(urls).toEqual([
      'https://a.com/',
      'https://www.reddit.com/r/x/comments/one/',
      'https://b.com/',
      'https://www.reddit.com/r/x/comments/two/',
      'https://www.reddit.com/r/x/comments/three/',
    ]);
  });
});

describe('lookupReddit', () => {
  it('is off when no worker is configured', async () => {
    expect(await lookupReddit('anything', '')).toEqual({ status: 'off', results: [] });
  });
});
