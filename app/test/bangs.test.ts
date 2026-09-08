import { describe, expect, it } from 'vitest';
import { listBangs, resolveBang } from '../src/bangs.js';

describe('resolveBang', () => {
  it('returns null for plain queries', () => {
    expect(resolveBang('cats')).toBeNull();
    expect(resolveBang('hello world')).toBeNull();
  });
  it('matches a bang at the start, end, or middle', () => {
    expect(resolveBang('!yt cats')).toBe('https://www.youtube.com/results?search_query=cats');
    expect(resolveBang('cats !yt')).toBe('https://www.youtube.com/results?search_query=cats');
    expect(resolveBang('big !gh cats')).toBe('https://github.com/search?q=big%20cats');
  });
  it('is case-insensitive and ignores unknown bangs', () => {
    expect(resolveBang('!GH hono')).toBe('https://github.com/search?q=hono');
    expect(resolveBang('!nope hono')).toBeNull();
  });
  it('goes to the home page when there is no query', () => {
    expect(resolveBang('!w')).toBe('https://en.wikipedia.org');
  });
  it('does not treat an exclamation inside a word as a bang', () => {
    expect(resolveBang('wow!yt')).toBeNull();
  });
  it('url-encodes the query', () => {
    expect(resolveBang('!so a&b=c')).toBe('https://stackoverflow.com/search?q=a%26b%3Dc');
  });
  it('lists every bang with a leading !', () => {
    const list = listBangs();
    expect(list.length).toBeGreaterThan(10);
    expect(list.every((b) => b.bang.startsWith('!'))).toBe(true);
  });
});
