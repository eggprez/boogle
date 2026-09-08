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
  it('maps a one-place verdict to a place intent', () => {
    expect(parseClassification('{"place":true,"mode":"one","name":"Denver, Colorado","kind":"city","what":"","area":"","category":null,"filters":[]}')).toEqual({
      kind: 'place',
      place: 'Denver, Colorado',
      placeKind: 'city',
      source: 'claude',
    });
  });
  it('maps a list verdict with custom filters, around the user when no area is given', () => {
    expect(parseClassification('{"place":true,"mode":"list","name":"","kind":"","what":"Pizza places","area":"","category":null,"filters":["[\\"amenity\\"=\\"restaurant\\"][\\"cuisine\\"~\\"pizza\\"]"]}')).toEqual({
      kind: 'list',
      place: '',
      label: 'Pizza places',
      filters: ['["amenity"="restaurant"]["cuisine"~"pizza"]'],
      category: undefined,
      source: 'claude',
    });
  });
  it('falls back to the built-in filters for a known category with bad filters', () => {
    const r = parseClassification('{"place":true,"mode":"list","name":"","kind":"","what":"Restaurants","area":"Austin, Texas","category":"restaurants","filters":["drop table"]}');
    expect(r).toMatchObject({ kind: 'list', place: 'Austin, Texas', category: 'restaurants', filters: ['["amenity"="restaurant"]'] });
  });
  it('tolerates prose around the JSON', () => {
    expect(parseClassification('Sure: {"place":true,"mode":"one","name":"Kyoto","kind":"city"} done')).toMatchObject({ kind: 'place', place: 'Kyoto' });
  });
  it('returns null for a no, an empty name, a list with no usable filter, or junk', () => {
    expect(parseClassification('{"place":false,"mode":"one","name":"","kind":"other"}')).toBeNull();
    expect(parseClassification('{"place":true,"mode":"one","name":"","kind":"city"}')).toBeNull();
    expect(parseClassification('{"place":true,"mode":"list","what":"Things","area":"","category":null,"filters":["["x"="y"]"]}')).toBeNull();
    expect(parseClassification('I cannot help with that')).toBeNull();
    expect(parseClassification('{"place": "yes"}')).toBeNull();
  });
});
