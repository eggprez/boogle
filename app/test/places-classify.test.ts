import { describe, expect, it } from 'vitest';
import { cheapReject, parseClassification } from '../src/places-classify.js';

describe('cheapReject', () => {
  it('lets short plausible queries through to Claude', () => {
    for (const q of ['denver', 'golden gate bridge', 'yosemite', "joe's pizza denver", 'fun stuff for kids around denver', 'where should we eat in austin']) {
      expect(cheapReject(q), q).toBeNull();
    }
  });
  it('rejects code, URLs, numbers, long queries and plain questions without a call', () => {
    expect(cheapReject('python list comprehension example with a dict inside a loop')).toBe('too many words');
    expect(cheapReject('dict.items() python')).toBe('code or URL');
    expect(cheapReject('https://example.com/page')).toBe('code or URL');
    expect(cheapReject('foo_bar baz')).toBe('code or URL');
    expect(cheapReject('12 3.5')).toBe('numbers');
    expect(cheapReject('how to bake bread')).toBe('question');
    expect(cheapReject('how to get around lisbon')).toBeNull();
    expect(cheapReject('a'.repeat(81))).toBe('too long');
  });
});

describe('parseClassification', () => {
  it('maps a place verdict to a single-place intent', () => {
    expect(parseClassification('{"place":true,"name":"Denver, Colorado","kind":"city","category":null,"area":""}')).toEqual({
      kind: 'place',
      place: 'Denver, Colorado',
      placeKind: 'city',
      source: 'claude',
    });
  });
  it('maps a category verdict to an attractions intent around the area', () => {
    expect(parseClassification('{"place":true,"name":"Austin, Texas","kind":"city","category":"restaurants","area":"Austin, Texas"}')).toEqual({
      kind: 'attractions',
      category: 'restaurants',
      place: 'Austin, Texas',
      source: 'claude',
    });
  });
  it('tolerates prose around the JSON and unknown categories', () => {
    expect(parseClassification('Sure: {"place":true,"name":"Kyoto","kind":"city","category":"temples","area":"Kyoto"} done')).toEqual({
      kind: 'place',
      place: 'Kyoto',
      placeKind: 'city',
      source: 'claude',
    });
  });
  it('returns null for a no, an empty name, or junk', () => {
    expect(parseClassification('{"place":false,"name":"","kind":"other","category":null,"area":""}')).toBeNull();
    expect(parseClassification('{"place":true,"name":"","kind":"city","category":null,"area":""}')).toBeNull();
    expect(parseClassification('I cannot help with that')).toBeNull();
    expect(parseClassification('{"place": "yes"}')).toBeNull();
  });
});
