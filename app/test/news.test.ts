import { describe, expect, it } from 'vitest';
import { pickStories, queryTerms } from '../src/news.js';
import type { SearxResult } from '../src/searxng.js';

const NOW = Date.parse('2026-09-08T12:00:00Z');
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const story = (host: string, title: string, hours: number, content = ''): SearxResult => ({
  url: `https://${host}/a/${hours}`,
  title,
  content,
  publishedDate: ago(hours),
});

describe('queryTerms', () => {
  it('drops stop words and punctuation, keeps order, dedupes', () => {
    expect(queryTerms('What is the "Apple" event? apple')).toEqual(['apple', 'event']);
  });
  it('is empty for a query of stop words', () => {
    expect(queryTerms('what is it')).toEqual([]);
  });
});

describe('pickStories', () => {
  const fresh = [
    story('bbc.co.uk', 'Apple event: new iPhone announced', 3),
    story('theverge.com', 'Everything from the Apple event', 9),
    story('reuters.com', 'Apple event reaction on Wall Street', 30),
    story('cnn.com', 'Apple event recap', 50),
    story('example.com', 'Apple event: fifth source', 60),
  ];
  it('shows a strip for a query with fresh, on-topic coverage from several sites', () => {
    const picked = pickStories('apple event', fresh, NOW);
    expect(picked.map((s) => s.url)).toEqual(fresh.slice(0, 4).map((s) => s.url));
  });
  it('needs three distinct sources', () => {
    const sameSite = [story('bbc.co.uk', 'Apple event one', 3), story('www.bbc.co.uk', 'Apple event two', 4), story('reuters.com', 'Apple event three', 5)];
    expect(pickStories('apple event', sameSite, NOW)).toEqual([]);
  });
  it('needs the newest story to be under two days old', () => {
    const stale = [story('a.com', 'Apple event', 60), story('b.com', 'Apple event', 70), story('c.com', 'Apple event', 80)];
    expect(pickStories('apple event', stale, NOW)).toEqual([]);
  });
  it('ignores stories older than a week and undated ones', () => {
    const list = [story('a.com', 'Apple event', 3), story('b.com', 'Apple event', 5), story('c.com', 'Apple event', 24 * 9), { url: 'https://d.com/', title: 'Apple event' }];
    expect(pickStories('apple event', list, NOW)).toEqual([]);
  });
  it('rejects coverage that only shares one word with a multi-word query', () => {
    const python = [story('a.com', 'Python 3.15 released', 3), story('b.com', 'Python conference opens', 5), story('c.com', 'Python bites zoo keeper', 8)];
    expect(pickStories('python list comprehension', python, NOW)).toEqual([]);
  });
  it('matches on the snippet too', () => {
    const list = [
      story('a.com', 'Markets today', 3, 'Nvidia earnings beat estimates'),
      story('b.com', 'Chipmaker soars', 5, 'nvidia earnings call'),
      story('c.com', 'Nvidia earnings: what to know', 8),
    ];
    expect(pickStories('nvidia earnings', list, NOW)).toHaveLength(3);
  });
  it('accepts a single-word query when the word appears', () => {
    const list = [story('a.com', 'Nvidia up', 3), story('b.com', 'Nvidia down', 5), story('c.com', 'Nvidia sideways', 8)];
    expect(pickStories('nvidia', list, NOW)).toHaveLength(3);
  });
});
