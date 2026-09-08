import { describe, expect, it } from 'vitest';
import type { SearxResult } from '../src/searxng.js';
import { pickSources } from '../src/overview/sources.js';

const r = (url: string, engines: string[] = ['google']): SearxResult => ({ url, title: url, engines });

describe('pickSources', () => {
  it('drops non-http URLs and duplicates', () => {
    const out = pickSources([r('ftp://x.org/a'), r('https://a.com/x'), r('https://a.com/x/'), r('https://a.com/x?utm=1')], 10);
    expect(out.map((s) => s.url)).toEqual(['https://a.com/x']);
  });
  it('caps results per host', () => {
    const out = pickSources([r('https://a.com/1'), r('https://a.com/2'), r('https://a.com/3'), r('https://b.com/1')], 10);
    expect(out.map((s) => s.url)).toEqual(['https://a.com/1', 'https://a.com/2', 'https://b.com/1']);
  });
  it('treats www and bare host as the same site', () => {
    const out = pickSources([r('https://www.a.com/1'), r('https://a.com/2'), r('https://a.com/3')], 10);
    expect(out).toHaveLength(2);
  });
  it('floats multi-engine results above single-engine ones, keeping order otherwise', () => {
    const out = pickSources([r('https://a.com/1', ['g']), r('https://b.com/1', ['g', 'bing']), r('https://c.com/1', ['g']), r('https://d.com/1', ['g', 'brave'])], 10);
    expect(out.map((s) => s.url)).toEqual(['https://b.com/1', 'https://d.com/1', 'https://a.com/1', 'https://c.com/1']);
  });
  it('skips unreadable hosts and binary files only in deep mode', () => {
    const list = [r('https://www.youtube.com/watch?v=1'), r('https://a.com/report.pdf'), r('https://a.com/page')];
    expect(pickSources(list, 10, { deep: true }).map((s) => s.url)).toEqual(['https://a.com/page']);
    expect(pickSources(list, 10)).toHaveLength(3);
  });
  it('honours max', () => {
    const list = Array.from({ length: 30 }, (_, i) => r(`https://h${i}.com/`));
    expect(pickSources(list, 5)).toHaveLength(5);
  });
});
