import { config } from './config.js';

// Places: the map-and-attractions card Google shows for "things to do in
// Lisbon" or "museums in Tokyo", built from three keyless OpenStreetMap
// services. Nominatim turns the place name into coordinates and a bounding
// box, the Overpass API lists named features with the right tags around
// that point, and one Wikidata SPARQL query adds a photo, a one-line
// description and a Wikipedia link to the ones that have them. Everything is
// memoised for a day: the same query a second time costs nothing upstream.
//
// A bare place query ("lisbon") needs none of this: SearXNG's Wikidata
// infobox already carries an OpenStreetMap link with coordinates, and
// geoFromInfoboxUrls() reads it.

export type CategoryId = 'attractions' | 'museums' | 'restaurants' | 'cafes' | 'bars' | 'hotels' | 'parks' | 'beaches';

interface Category {
  id: CategoryId;
  /** heading, with the place name appended */
  label: string;
  /** what people type; matched as a whole phrase */
  words: string;
  /** Overpass tag filters, OR-ed together */
  filters: string[];
  /** search radius in km, clamped from the place's size */
  radiusKm: [number, number];
  /** prefer features linked to Wikidata (landmarks) over the merely named (shops) */
  notable: boolean;
}

const CATEGORIES: Category[] = [
  {
    id: 'attractions',
    label: 'Things to do in',
    words:
      'things to (?:do|see)|attractions?|sightseeing|what to (?:see|do|visit)|places to (?:visit|see|go)|tourist (?:spots?|sites?|places|attractions?)|landmarks?|must[- ]sees?|points? of interest|sights|monuments?',
    // Two filters only: adding amenity=place_of_worship or building=* makes
    // Overpass take ten times longer for a big city (measured on Lisbon).
    filters: [
      '["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park)$"]',
      '["historic"~"^(castle|monument|memorial|palace|fort|ruins|archaeological_site|city_gate|tower|citadel)$"]',
    ],
    radiusKm: [2, 15],
    notable: true,
  },
  { id: 'museums', label: 'Museums in', words: 'museums?|galler(?:y|ies)|exhibitions?', filters: ['["tourism"~"^(museum|gallery)$"]'], radiusKm: [2, 12], notable: true },
  {
    id: 'restaurants',
    label: 'Restaurants in',
    words: 'restaurants?|places to eat|where to eat|eateries|dinner|lunch|brunch',
    filters: ['["amenity"="restaurant"]'],
    radiusKm: [1, 4],
    notable: false,
  },
  { id: 'cafes', label: 'Cafés in', words: 'caf[eé]s?|coffee(?: shops?)?', filters: ['["amenity"="cafe"]'], radiusKm: [1, 4], notable: false },
  {
    id: 'bars',
    label: 'Bars in',
    words: 'bars?|pubs?|nightlife|brewer(?:y|ies)|cocktails?|wine bars?',
    filters: ['["amenity"~"^(bar|pub|biergarten)$"]', '["craft"="brewery"]'],
    radiusKm: [1, 4],
    notable: false,
  },
  {
    id: 'hotels',
    label: 'Hotels in',
    words: 'hotels?|hostels?|where to stay|places to stay|accommodation|lodging|resorts?',
    filters: ['["tourism"~"^(hotel|hostel|guest_house|resort)$"]'],
    radiusKm: [1, 5],
    notable: false,
  },
  {
    id: 'parks',
    label: 'Parks in',
    words: 'parks?|gardens?|hik(?:es?|ing)|trails?|nature',
    filters: ['["leisure"~"^(park|garden|nature_reserve)$"]', '["boundary"="national_park"]'],
    radiusKm: [2, 15],
    notable: true,
  },
  { id: 'beaches', label: 'Beaches in', words: 'beach(?:es)?', filters: ['["natural"="beach"]'], radiusKm: [3, 25], notable: false },
];

const ADJ = String.raw`(?:(?:the|best|top|good|great|popular|famous|cheap|free|nice|cool|fun|kid[- ]friendly|family[- ]friendly|hidden|main|major|romantic|unusual|\d+)\s+)*`;
const PLACE = String.raw`(?<place>\p{L}[\p{L}\s.'’-]{1,60}?)`;
const CAT = `(?:${CATEGORIES.map((c) => `(?<${c.id}>${c.words})`).join('|')})`;
const RE_CAT_IN = new RegExp(`^${ADJ}${CAT}\\s+(?:in|near|around|at)\\s+(?:the\\s+)?${PLACE}$`, 'iu');
const RE_PLACE_CAT = new RegExp(`^${PLACE}\\s+${ADJ}${CAT}$`, 'iu');
const RE_MAP = new RegExp(String.raw`^(?:(?:map|maps|location) of|where is|directions to|how to get to)\s+${PLACE}$|^${PLACE}\s+(?:map|maps|location)$`, 'iu');
const NOT_A_PLACE = /^(?:me|here|us|there|my area|the area|this area|town|the city|my city|city|home|general|case of fire)$/i;

export interface PlaceIntent {
  kind: 'attractions' | 'place';
  category?: CategoryId;
  place: string;
}

/**
 * Does this query ask for a place or for things around one? Cheap enough to
 * run on every search: no network, just two regular expressions.
 */
export function placeIntent(q: string): PlaceIntent | null {
  const s = q.trim().replace(/[?!.]+$/, '').replace(/\s+/g, ' ');
  if (s.length < 4 || s.length > 100) return null;
  const m = RE_CAT_IN.exec(s) ?? RE_PLACE_CAT.exec(s);
  if (m?.groups) {
    const place = cleanPlace(m.groups.place);
    if (!place) return null;
    const category = CATEGORIES.find((c) => m.groups?.[c.id])?.id;
    if (!category) return null;
    return { kind: 'attractions', category, place };
  }
  const mm = RE_MAP.exec(s);
  if (mm?.groups) {
    const place = cleanPlace(mm.groups.place);
    if (!place) return null;
    return { kind: 'place', place };
  }
  return null;
}

function cleanPlace(raw: string | undefined): string | null {
  const place = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!place || NOT_A_PLACE.test(place)) return null;
  if (place.split(' ').length > 5) return null;
  return place;
}

// ---------------------------------------------------------------- data ----

export interface Geo {
  lat: number;
  lon: number;
  /** south, north, west, east */
  bbox?: [number, number, number, number];
}

export interface Place extends Geo {
  name: string;
  /** "Lisboa, Portugal" */
  displayName: string;
  /** Nominatim's addresstype: city, town, country, ... */
  type: string;
  osmType?: string;
  osmId?: number;
  wikidata?: string;
  wikipedia?: string;
  website?: string;
}

export interface Attraction {
  name: string;
  lat: number;
  lon: number;
  /** "museum", "castle", "restaurant" */
  kind: string;
  osmType: string;
  osmId: number;
  wikidata?: string;
  /** "en:Belém Tower" as tagged in OSM */
  wikipedia?: string;
  website?: string;
  description?: string;
  image?: string;
  /** English Wikipedia article, from Wikidata */
  article?: string;
  cuisine?: string;
  openingHours?: string;
  address?: string;
}

export interface PlacesData {
  kind: 'attractions' | 'place';
  category?: CategoryId;
  heading: string;
  place: Place;
  items: Attraction[];
  /** the attractions list could not be fetched (Overpass down or out of time) */
  failed?: boolean;
}

const UA = `${config.siteName}/0.1 (+${config.publicUrl})`;
const MAX_ITEMS = 10;
const CACHE_MS = 24 * 3_600_000;
/** A card whose Overpass step failed is kept only briefly, so "Retry" can succeed. */
const FAILED_CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<PlacesData | null> }>();

/** The card's data for a query, or null when the place cannot be found. Memoised for a day. */
export function buildPlaces(q: string, opts: { fresh?: boolean } = {}): Promise<PlacesData | null> {
  const intent = placeIntent(q);
  if (!intent) return Promise.resolve(null);
  const key = `${intent.kind}:${intent.category ?? ''}:${intent.place.toLowerCase()}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && !opts.fresh && now - hit.at < CACHE_MS) return hit.value;
  const value = resolve(intent);
  cache.set(key, { at: now, value });
  value.then(
    (d) => {
      if (d?.failed) cache.set(key, { at: now - CACHE_MS + FAILED_CACHE_MS, value });
    },
    () => cache.delete(key),
  );
  if (cache.size > 300) {
    for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  }
  return value;
}

async function resolve(intent: PlaceIntent): Promise<PlacesData | null> {
  const place = await geocode(intent.place);
  if (!place) return null;
  if (intent.kind === 'place') return { kind: 'place', heading: place.name, place, items: [] };
  const category = CATEGORIES.find((c) => c.id === intent.category)!;
  const heading = `${category.label} ${place.name}`;
  let items: Attraction[] = [];
  let failed = false;
  try {
    items = await attractions(place, category);
  } catch (err) {
    failed = true;
    console.error('[places] overpass', intent.place, (err as Error).message);
  }
  if (items.length) {
    try {
      await enrich(items);
    } catch (err) {
      console.error('[places] wikidata', intent.place, (err as Error).message);
    }
  }
  return { kind: 'attractions', category: category.id, heading, place, items, failed };
}

// Only these Nominatim address types are places one asks for things "in":
// a query like "things to do in case of fire" geocodes to nothing useful.
const PLACE_TYPES = new Set([
  'city', 'town', 'village', 'hamlet', 'municipality', 'suburb', 'neighbourhood', 'quarter', 'borough', 'city_district', 'district',
  'county', 'state', 'region', 'province', 'country', 'island', 'archipelago', 'peninsula', 'islet', 'locality',
  // landmarks: "map of the eiffel tower", "hotels near disneyland"
  'tourism', 'historic', 'leisure', 'natural', 'aeroway', 'railway', 'amenity',
]);

interface NominatimHit {
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  addresstype?: string;
  category?: string;
  importance?: number;
  osm_type?: string;
  osm_id?: number;
  boundingbox?: [string, string, string, string];
  extratags?: Record<string, string>;
}

export async function geocode(name: string): Promise<Place | null> {
  const params = new URLSearchParams({ q: name, format: 'jsonv2', limit: '1', addressdetails: '1', extratags: '1', 'accept-language': 'en' });
  const res = await fetch(`${config.nominatimUrl}/search?${params}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  const hits = (await res.json()) as NominatimHit[];
  const h = hits[0];
  if (!h) return null;
  const type = h.addresstype ?? h.category ?? '';
  if (!PLACE_TYPES.has(type)) return null;
  const bb = h.boundingbox?.map(Number) as [number, number, number, number] | undefined;
  const t = h.extratags ?? {};
  return {
    name: h.name || h.display_name?.split(',')[0] || name,
    displayName: h.display_name ?? name,
    type,
    lat: Number(h.lat),
    lon: Number(h.lon),
    bbox: bb && bb.every(Number.isFinite) ? bb : undefined,
    osmType: h.osm_type,
    osmId: h.osm_id,
    wikidata: t.wikidata,
    wikipedia: t.wikipedia,
    website: t.website,
  };
}

/** Rough size of a bounding box: the longer side in km. */
export function bboxKm(bbox: [number, number, number, number]): number {
  const [s, n, w, e] = bbox;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  return Math.max((n - s) * 111, (e - w) * 111 * Math.cos(midLat));
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** A box of ±km around a point, as Overpass wants it: south,west,north,east. */
export function boxAround(lat: number, lon: number, km: number): string {
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(4)).join(',');
}

async function attractions(place: Place, category: Category): Promise<Attraction[]> {
  // Search box from the place's size: a village gets the floor, a city the
  // ceiling; a whole country still gets the ceiling, around its centre. A
  // bounding box, not "around": Overpass answers a box in a third of the time.
  const size = place.bbox ? bboxKm(place.bbox) : 0;
  const km = Math.min(category.radiusKm[1], Math.max(category.radiusKm[0], size / 2));
  const box = `(${boxAround(place.lat, place.lon, km)})`;
  const query = (extra: string, limit: number) =>
    `[out:json][timeout:12];(${category.filters.map((f) => `nwr${f}["name"]${extra}${box};`).join('')});out center tags ${limit};`;

  // Landmarks: ask for Wikidata-linked features first (a city has hundreds
  // of named tourism nodes; the linked ones are the ones worth a visit) and
  // widen to everything named only when that is thin, as in a small town.
  let elements = await overpass(query(category.notable ? '["wikidata"]' : '', 150));
  if (category.notable && elements.length < 4) elements = elements.concat(await overpass(query('', 60)));
  return rankAttractions(elements);
}

async function overpass(data: string): Promise<OverpassElement[]> {
  const urls = [config.overpassUrl, config.overpassFallbackUrl].filter(Boolean);
  let lastErr: Error | null = null;
  for (const url of urls) {
    const t = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data }),
        // Overpass keeps running a query its client abandoned, and this IP
        // has two slots: the abort is generous so a slow answer still lands
        // rather than tying a slot up for nothing.
        signal: AbortSignal.timeout(14_000),
      });
      if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
      const json = (await res.json()) as { elements?: OverpassElement[]; remark?: string };
      // A query that ran out of time comes back as HTTP 200 with a remark.
      if (json.remark && /timed out|error/i.test(json.remark) && !json.elements?.length) throw new Error(json.remark.slice(0, 120));
      console.log(`[places] overpass ${json.elements?.length ?? 0} features in ${Date.now() - t} ms${json.remark ? ` (${json.remark.slice(0, 80)})` : ''}`);
      return json.elements ?? [];
    } catch (err) {
      lastErr = err as Error;
      console.warn(`[places] overpass ${new URL(url).host} failed after ${Date.now() - t} ms: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error('Overpass unreachable');
}

/**
 * Order Overpass's arbitrary-order features the way a visitor would want
 * them: things with a Wikidata item and a Wikipedia article first, then the
 * well-described, then the rest. Duplicates (a node and the building it sits
 * in) collapse by Wikidata id or name.
 */
export function rankAttractions(elements: OverpassElement[]): Attraction[] {
  const seen = new Set<string>();
  const scored: { a: Attraction; score: number }[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    const name = t['name:en'] || t.name;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || lat === undefined || lon === undefined) continue;
    const key = t.wikidata || name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = t.tourism || t.historic || t.amenity || t.leisure || t.natural || t.craft || t.building || t.boundary || '';
    const score =
      (t.wikidata ? 4 : 0) +
      (t.wikipedia ? 2 : 0) +
      (t.heritage ? 1 : 0) +
      (t.website || t['contact:website'] ? 1 : 0) +
      (t.description ? 0.5 : 0) +
      (t.opening_hours ? 0.5 : 0) +
      (t.image || t.wikimedia_commons ? 0.5 : 0) +
      (kind === 'place_of_worship' ? -1 : 0);
    const street = t['addr:street'];
    const address = street ? `${street}${t['addr:housenumber'] ? ' ' + t['addr:housenumber'] : ''}` : undefined;
    scored.push({
      a: {
        name,
        lat,
        lon,
        kind: kind.replace(/_/g, ' '),
        osmType: el.type,
        osmId: el.id,
        wikidata: t.wikidata,
        wikipedia: t.wikipedia,
        website: t.website || t['contact:website'],
        description: t['description:en'] || t.description,
        cuisine: t.cuisine?.replace(/_/g, ' ').replace(/;/g, ', '),
        openingHours: t.opening_hours,
        address,
      },
      score,
    });
  }
  return scored
    .sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name))
    .slice(0, MAX_ITEMS)
    .map((s) => s.a);
}

interface SparqlBinding {
  item?: { value: string };
  itemDescription?: { value: string };
  image?: { value: string };
  article?: { value: string };
}

/** One SPARQL query adds a photo, description and Wikipedia link to every item with a Wikidata id. */
async function enrich(items: Attraction[]): Promise<void> {
  const ids = [...new Set(items.map((a) => a.wikidata).filter((id): id is string => !!id && /^Q\d+$/.test(id)))];
  if (!ids.length) return;
  const query = `SELECT ?item ?itemDescription ?image ?article WHERE {
  VALUES ?item { ${ids.map((id) => `wd:${id}`).join(' ')} }
  OPTIONAL { ?item wdt:P18 ?image }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`;
  const res = await fetch(`${config.wikidataSparqlUrl}?${new URLSearchParams({ query, format: 'json' })}`, {
    headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Wikidata responded ${res.status}`);
  const json = (await res.json()) as { results?: { bindings?: SparqlBinding[] } };
  const byId = new Map<string, SparqlBinding>();
  for (const b of json.results?.bindings ?? []) {
    const id = b.item?.value.split('/').pop();
    if (id && !byId.has(id)) byId.set(id, b); // first image per item is enough
  }
  for (const a of items) {
    const b = a.wikidata ? byId.get(a.wikidata) : undefined;
    if (!b) continue;
    if (b.image?.value) a.image = commonsThumb(b.image.value);
    if (b.itemDescription?.value) a.description = b.itemDescription.value;
    if (b.article?.value) a.article = b.article.value;
  }
}

/** Commons "Special:FilePath" URL → the same at a card-sized width. */
export function commonsThumb(url: string, width = 400): string {
  return url.replace(/^http:\/\//, 'https://') + (url.includes('?') ? '&' : '?') + `width=${width}`;
}

/**
 * SearXNG's Wikidata infobox links a place's coordinates as
 * https://www.openstreetmap.org/?lat=..&lon=..&zoom=..; read them back.
 */
export function geoFromInfoboxUrls(urls: { title?: string; url: string }[] | undefined): (Geo & { zoom: number }) | null {
  for (const u of urls ?? []) {
    if (!/openstreetmap\.org/i.test(u.url)) continue;
    const lat = /[?&]lat=(-?\d+(?:\.\d+)?)/.exec(u.url);
    const lon = /[?&]lon=(-?\d+(?:\.\d+)?)/.exec(u.url);
    if (!lat || !lon) continue;
    const zoom = /[?&]zoom=(\d+)/.exec(u.url);
    return { lat: Number(lat[1]), lon: Number(lon[1]), zoom: zoom ? Number(zoom[1]) : 12 };
  }
  return null;
}

// ------------------------------------------------------------ map tiles ----
// The map is a mosaic of standard 256 px slippy-map tiles laid out by the
// server around a centre point, with pins placed by the same projection.
// No map library, no client script: a few <img> tags in a clipped box.

const TILE = 256;
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 17;

/** Web Mercator: degrees → world pixels at a zoom. */
export function project(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = TILE * 2 ** zoom;
  const phi = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  };
}

/** The largest zoom at which the box (south, north, west, east) fits a viewport. */
export function fitZoom(bbox: [number, number, number, number], width: number, height: number, pad = 24): number {
  const [s, n, w, e] = bbox;
  const a = project(n, w, 0);
  const b = project(s, e, 0);
  const dx = Math.max(Math.abs(b.x - a.x), 1e-6);
  const dy = Math.max(Math.abs(b.y - a.y), 1e-6);
  const z = Math.floor(Math.min(Math.log2((width - 2 * pad) / dx), Math.log2((height - 2 * pad) / dy)));
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
}

export interface MapModel {
  zoom: number;
  lat: number;
  lon: number;
  /** tile URL plus its offset from the viewport centre, in px */
  tiles: { url: string; left: number; top: number }[];
  /** pin offsets from the viewport centre, in px, in input order */
  pins: { left: number; top: number }[];
}

/**
 * Lay tiles and pins out around a centre for a viewport of the given size.
 * The viewport is virtual: the page clips whatever it actually shows, so a
 * wider box than the real one costs a couple of extra tiles, never a gap.
 */
export function buildMap(opts: {
  points: { lat: number; lon: number }[];
  center?: { lat: number; lon: number };
  zoom?: number;
  bbox?: [number, number, number, number];
  width: number;
  height: number;
}): MapModel {
  const pts = opts.points;
  let bbox = opts.bbox;
  if (!bbox && pts.length > 1) {
    const lats = pts.map((p) => p.lat);
    const lons = pts.map((p) => p.lon);
    bbox = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  }
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, opts.zoom ?? (bbox ? fitZoom(bbox, opts.width, opts.height) : 15)));
  let lat: number;
  let lon: number;
  if (opts.center) ({ lat, lon } = opts.center);
  else if (bbox && pts.length > 1) {
    lat = (bbox[0] + bbox[1]) / 2;
    lon = (bbox[2] + bbox[3]) / 2;
  } else if (pts.length) ({ lat, lon } = pts[0]);
  else ({ lat, lon } = { lat: 0, lon: 0 });

  const c = project(lat, lon, zoom);
  const n = 2 ** zoom;
  const tiles: MapModel['tiles'] = [];
  const x0 = Math.floor((c.x - opts.width / 2) / TILE);
  const x1 = Math.floor((c.x + opts.width / 2) / TILE);
  const y0 = Math.floor((c.y - opts.height / 2) / TILE);
  const y1 = Math.floor((c.y + opts.height / 2) / TILE);
  for (let ty = Math.max(0, y0); ty <= Math.min(n - 1, y1); ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wrapped = ((tx % n) + n) % n;
      tiles.push({
        url: config.mapTileUrl.replace('{z}', String(zoom)).replace('{x}', String(wrapped)).replace('{y}', String(ty)),
        left: Math.round(tx * TILE - c.x),
        top: Math.round(ty * TILE - c.y),
      });
    }
  }
  const pins = pts.map((p) => {
    const q = project(p.lat, p.lon, zoom);
    return { left: Math.round(q.x - c.x), top: Math.round(q.y - c.y) };
  });
  return { zoom, lat, lon, tiles, pins };
}

export function osmUrl(lat: number, lon: number, zoom: number): string {
  return `https://www.openstreetmap.org/#map=${zoom}/${lat.toFixed(5)}/${lon.toFixed(5)}`;
}
export function googleMapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)}%2C${lon.toFixed(5)}`;
}
export function directionsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(5)},${lon.toFixed(5)}`;
}
export function osmFeatureUrl(type: string, id: number): string {
  return `https://www.openstreetmap.org/${type}/${id}`;
}
