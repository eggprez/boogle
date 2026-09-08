import { describe, expect, it } from 'vitest';
import { bboxKm, buildMap, commonsThumb, fitZoom, geoFromInfoboxUrls, placeIntent, project, rankAttractions } from '../src/places.js';

describe('placeIntent', () => {
  it('recognises "category in place" queries', () => {
    expect(placeIntent('things to do in Lisbon')).toEqual({ kind: 'attractions', category: 'attractions', place: 'Lisbon' });
    expect(placeIntent('best museums in new york')).toEqual({ kind: 'attractions', category: 'museums', place: 'new york' });
    expect(placeIntent('Top 10 restaurants near Tokyo')).toEqual({ kind: 'attractions', category: 'restaurants', place: 'Tokyo' });
    expect(placeIntent('what to see in Paris?')).toEqual({ kind: 'attractions', category: 'attractions', place: 'Paris' });
    expect(placeIntent('hotels in the Algarve')).toEqual({ kind: 'attractions', category: 'hotels', place: 'Algarve' });
  });
  it('recognises "place category" queries', () => {
    expect(placeIntent('lisbon attractions')).toEqual({ kind: 'attractions', category: 'attractions', place: 'lisbon' });
    expect(placeIntent('Porto best beaches')).toEqual({ kind: 'attractions', category: 'beaches', place: 'Porto' });
  });
  it('recognises map and location queries', () => {
    expect(placeIntent('map of Berlin')).toEqual({ kind: 'place', place: 'Berlin' });
    expect(placeIntent('where is Reykjavik')).toEqual({ kind: 'place', place: 'Reykjavik' });
    expect(placeIntent('Oslo map')).toEqual({ kind: 'place', place: 'Oslo' });
  });
  it('leaves other queries alone', () => {
    for (const q of ['python list comprehension', 'things to do in case of fire', 'restaurants near me', 'how to bar a door', 'parks and recreation cast', 'bars', 'in']) {
      expect(placeIntent(q), q).toBeNull();
    }
  });
});

describe('map maths', () => {
  it('projects the origin to the centre of the world tile', () => {
    expect(project(0, 0, 0)).toEqual({ x: 128, y: 128 });
    expect(project(0, 180, 1).x).toBe(512);
  });
  it('fits a city into a card at a street-level zoom and a country at a low one', () => {
    expect(fitZoom([38.69, 38.80, -9.23, -9.09], 720, 260)).toBe(11);
    expect(fitZoom([36.96, 42.15, -9.5, -6.19], 720, 260)).toBeLessThanOrEqual(7);
  });
  it('lays tiles around the centre and keeps pins in order', () => {
    const m = buildMap({ points: [{ lat: 38.7, lon: -9.14 }, { lat: 38.71, lon: -9.13 }], width: 900, height: 300 });
    expect(m.tiles.length).toBeGreaterThan(4);
    expect(m.tiles.every((t) => /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(t.url))).toBe(true);
    expect(m.pins).toHaveLength(2);
    expect(Math.abs(m.pins[0].left)).toBeLessThan(450);
    expect(m.pins[0].top).toBeGreaterThan(m.pins[1].top); // north is up
  });
  it('wraps tile columns across the antimeridian', () => {
    const m = buildMap({ points: [{ lat: 0, lon: 179.9 }], zoom: 3, width: 900, height: 300 });
    expect(m.tiles.some((t) => t.url.endsWith('/3/0/3.png') || t.url.endsWith('/3/0/4.png'))).toBe(true);
  });
  it('measures a bounding box in km', () => {
    expect(bboxKm([38.69, 38.80, -9.23, -9.09])).toBeCloseTo(12.2, 0);
  });
});

describe('geoFromInfoboxUrls', () => {
  it('reads the OpenStreetMap link SearXNG puts in a Wikidata infobox', () => {
    expect(
      geoFromInfoboxUrls([
        { title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Lisbon' },
        { title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/?lat=38.7077&lon=-9.1366&zoom=11&layers=M' },
      ]),
    ).toEqual({ lat: 38.7077, lon: -9.1366, zoom: 11 });
  });
  it('is null without one', () => {
    expect(geoFromInfoboxUrls([{ title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Rust' }])).toBeNull();
    expect(geoFromInfoboxUrls(undefined)).toBeNull();
  });
});

describe('rankAttractions', () => {
  it('puts Wikidata-linked features first, dedupes, and uses way centres', () => {
    const els = [
      { type: 'node', id: 1, lat: 1, lon: 1, tags: { name: 'Corner shop', tourism: 'attraction' } },
      { type: 'way', id: 2, center: { lat: 2, lon: 2 }, tags: { name: 'Big Castle', historic: 'castle', wikidata: 'Q1', wikipedia: 'en:Big Castle' } },
      { type: 'node', id: 3, lat: 2, lon: 2, tags: { name: 'Big Castle', historic: 'castle', wikidata: 'Q1' } },
      { type: 'node', id: 4, lat: 3, lon: 3, tags: { name: 'Museum', tourism: 'museum', wikidata: 'Q2' } },
      { type: 'node', id: 5, lat: 3, lon: 3, tags: { tourism: 'museum' } },
    ];
    const ranked = rankAttractions(els);
    expect(ranked.map((a) => a.name)).toEqual(['Big Castle', 'Museum', 'Corner shop']);
    expect(ranked[0]).toMatchObject({ lat: 2, lon: 2, kind: 'castle', osmType: 'way', osmId: 2 });
  });
});

describe('commonsThumb', () => {
  it('upgrades to https and asks for a card-sized rendition', () => {
    expect(commonsThumb('http://commons.wikimedia.org/wiki/Special:FilePath/Torre%20de%20Bel%C3%A9m.jpg')).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/Torre%20de%20Bel%C3%A9m.jpg?width=400',
    );
  });
});

describe('boxAround', () => {
  it('spans the requested distance, wider in longitude away from the equator', async () => {
    const { boxAround } = await import('../src/places.js');
    const [s, w, n, e] = boxAround(60, 10, 11.1).split(',').map(Number);
    expect(n - s).toBeCloseTo(0.2, 3);
    expect(e - w).toBeCloseTo(0.4, 2);
  });
});
