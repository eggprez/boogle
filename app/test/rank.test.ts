import { describe, expect, it } from 'vitest';
import { rankResults } from '../src/rank.js';
import type { SearxResult } from '../src/searxng.js';

const r = (url: string, score?: number): SearxResult => ({ url, title: url, score });

describe('rankResults', () => {
  it('restores score order that SearXNG grouping pass shuffled', () => {
    // SearXNG's order: eight thumbnail-less results, then the score-5 one.
    const list = [r('https://a.com/', 4), r('https://b.com/', 2), r('https://c.com/', 1), r('https://d.com/', 0.6), r('https://e.com/', 5)];
    expect(rankResults(list, 'web').map((x) => x.url)).toEqual(['https://e.com/', 'https://a.com/', 'https://b.com/', 'https://c.com/', 'https://d.com/']);
  });
  it('keeps SearXNG order for results without a score', () => {
    const list = [r('https://a.com/'), r('https://b.com/'), r('https://c.com/')];
    expect(rankResults(list, 'web')).toEqual(list);
  });
  it('moves the third and later results of one host to the end on the web tab', () => {
    const list = [r('https://a.com/1', 9), r('https://a.com/2', 8), r('https://www.a.com/3', 7), r('https://b.com/', 6), r('https://a.com/4', 5), r('https://c.com/', 4)];
    expect(rankResults(list, 'web').map((x) => x.url)).toEqual([
      'https://a.com/1',
      'https://a.com/2',
      'https://b.com/',
      'https://c.com/',
      'https://www.a.com/3',
      'https://a.com/4',
    ]);
  });
  it('does not cap hosts on other tabs', () => {
    const list = [r('https://a.com/1', 3), r('https://a.com/2', 2), r('https://a.com/3', 1)];
    expect(rankResults(list, 'images')).toEqual(list);
  });
  it('does not mutate its input', () => {
    const list = [r('https://a.com/', 1), r('https://b.com/', 2)];
    rankResults(list, 'web');
    expect(list.map((x) => x.url)).toEqual(['https://a.com/', 'https://b.com/']);
  });
});
