import { formatNominatimAddress, formatTagAddress, type NominatimAddress } from './address.js';
import { findOnWeb, type BusinessInfo, type WebHit } from './business.js';
import { config } from './config.js';
import { gplacesEnabled, matchPlace, ratePlaces, type GooglePlace } from './gplaces.js';

// Places: the map cards Google shows for a place ("denver", "golden gate
// bridge", a business), for a kind of place somewhere ("things to do in
// Lisbon", "sushi in Austin") and for a kind of place around the user
// ("pizza", "dog parks near me"). Built from three keyless OpenStreetMap
// services: Nominatim turns a name into coordinates and a bounding box, the
// Overpass API lists named features with the right tags in a box, and one
// Wikidata SPARQL query adds a photo, a one-line description and a Wikipedia
// link to the ones that have them. Everything is memoised for a day.
//
// Whether a query is about a place is decided in two stages: the patterns
// here (free) and, for everything else, Claude (places-classify.ts).

export type CategoryId = 'attractions' | 'museums' | 'restaurants' | 'cafes' | 'bars' | 'hotels' | 'parks' | 'beaches';
export const CATEGORY_IDS: CategoryId[] = ['attractions', 'museums', 'restaurants', 'cafes', 'bars', 'hotels', 'parks', 'beaches'];

interface Category {
  id: CategoryId;
  /** list heading noun */
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

export const CATEGORIES: Category[] = [
  {
    id: 'attractions',
    label: 'Things to do',
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
  { id: 'museums', label: 'Museums', words: 'museums?|galler(?:y|ies)|exhibitions?', filters: ['["tourism"~"^(museum|gallery)$"]'], radiusKm: [2, 12], notable: true },
  {
    id: 'restaurants',
    label: 'Restaurants',
    words: 'restaurants?|places to eat|where to eat|eateries|dinner|lunch|brunch',
    filters: ['["amenity"="restaurant"]'],
    radiusKm: [1, 4],
    notable: false,
  },
  { id: 'cafes', label: 'Cafés', words: 'caf[eé]s?|coffee(?: shops?)?', filters: ['["amenity"="cafe"]'], radiusKm: [1, 4], notable: false },
  {
    id: 'bars',
    label: 'Bars',
    words: 'bars?|pubs?|nightlife|brewer(?:y|ies)|cocktails?|wine bars?',
    filters: ['["amenity"~"^(bar|pub|biergarten)$"]', '["craft"="brewery"]'],
    radiusKm: [1, 4],
    notable: false,
  },
  {
    id: 'hotels',
    label: 'Hotels',
    words: 'hotels?|hostels?|where to stay|places to stay|accommodation|lodging|resorts?',
    filters: ['["tourism"~"^(hotel|hostel|guest_house|resort)$"]'],
    radiusKm: [1, 5],
    notable: false,
  },
  {
    id: 'parks',
    label: 'Parks',
    words: 'parks?|gardens?|hik(?:es?|ing)|trails?',
    filters: ['["leisure"~"^(park|garden|nature_reserve)$"]', '["boundary"="national_park"]'],
    radiusKm: [2, 15],
    notable: true,
  },
  { id: 'beaches', label: 'Beaches', words: 'beach(?:es)?', filters: ['["natural"="beach"]'], radiusKm: [3, 25], notable: false },
];

/** Radius for a list around the user or of a kind Claude described (a business type): a neighbourhood, not a whole city. */
const LOCAL_RADIUS_KM: [number, number] = [1.5, 5];

const ADJ = String.raw`(?:(?:the|best|top|good|great|popular|famous|cheap|free|nice|cool|fun|kid[- ]friendly|family[- ]friendly|hidden|main|major|romantic|unusual|local|nearby|\d+)\s+)*`;
const PLACE = String.raw`(?<place>\p{L}[\p{L}\s.'’-]{1,60}?)`;
const CAT = `(?:${CATEGORIES.map((c) => `(?<${c.id}>${c.words})`).join('|')})`;
const RE_CAT_IN = new RegExp(`^${ADJ}${CAT}\\s+(?:in|near|around|at|close to)\\s+(?:the\\s+)?${PLACE}$`, 'iu');
const RE_PLACE_CAT = new RegExp(`^${PLACE}\\s+${ADJ}${CAT}$`, 'iu');
const RE_CAT_ONLY = new RegExp(`^${ADJ}${CAT}(?:\\s+nearby)?$`, 'iu');
const RE_MAP = new RegExp(String.raw`^(?:(?:map|maps|location) of|where is|directions to|how to get to)\s+${PLACE}$|^${PLACE}\s+(?:map|maps|location)$`, 'iu');
/** "near me" and friends: the list is wanted around the user, not in a named place */
const HERE = /^(?:me|here|us|my area|the area|this area|my location|nearby|my city|town|the city|home)$/i;
const NOT_A_PLACE = /^(?:there|general|case of fire|the world|earth)$/i;

export interface PlaceIntent {
  /** place: one named place, shown as a panel. list: places of a kind, shown as a map with a row of cards */
  kind: 'place' | 'list';
  /** what to geocode: the place itself, or the area a list is wanted in; '' means around the user */
  place: string;
  /** list heading noun: "Things to do", "Pizza places", "Dog parks" */
  label?: string;
  /** list: Overpass tag filters, OR-ed; each a chain like ["amenity"="restaurant"]["cuisine"~"pizza"] */
  filters?: string[];
  /** list: the built-in category, when it is one */
  category?: CategoryId;
  /** Claude's idea of what a single place is: city, landmark, business, ... */
  placeKind?: string;
  /** pattern: matched by the regular expressions here; claude: places-classify.ts */
  source?: 'pattern' | 'claude';
}

/**
 * Does this query ask for a place, or for places of a kind? Cheap enough
 * to run on every search: no network, a few regular expressions.
 */
export function placeIntent(q: string): PlaceIntent | null {
  const s = q.trim().replace(/[?!.]+$/, '').replace(/\s+/g, ' ');
  if (s.length < 4 || s.length > 100) return null;
  const list = (m: RegExpExecArray, place: string): PlaceIntent | null => {
    const cat = CATEGORIES.find((c) => m.groups?.[c.id]);
    return cat ? { kind: 'list', place, label: cat.label, filters: cat.filters, category: cat.id, source: 'pattern' } : null;
  };
  let m = RE_CAT_IN.exec(s) ?? RE_PLACE_CAT.exec(s);
  if (m?.groups) {
    const place = cleanPlace(m.groups.place);
    return place === null ? null : list(m, place);
  }
  m = RE_CAT_ONLY.exec(s);
  if (m?.groups) return list(m, '');
  const mm = RE_MAP.exec(s);
  if (mm?.groups) {
    const place = cleanPlace(mm.groups.place);
    return place ? { kind: 'place', place, source: 'pattern' } : null;
  }
  return null;
}

/** The place name, '' for "near me" and the like, null when it is not a place at all. */
function cleanPlace(raw: string | undefined): string | null {
  const place = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!place || NOT_A_PLACE.test(place)) return null;
  if (HERE.test(place)) return '';
  if (place.split(' ').length > 5) return null;
  return place;
}

// ------------------------------------------------------- Overpass filters ----
// Claude writes tag filters for kinds of place the built-in table lacks
// ("dog parks", "sushi", "urgent care"). Only this grammar reaches Overpass:
// a chain of ["key"="value"] or ["key"~"regex"] clauses on known keys.

const FILTER_KEYS = new Set([
  'amenity', 'shop', 'tourism', 'leisure', 'cuisine', 'craft', 'healthcare', 'healthcare:speciality', 'natural', 'historic', 'sport',
  'office', 'building', 'aeroway', 'railway', 'public_transport', 'emergency', 'man_made', 'landuse', 'boundary', 'diet:vegan',
  'diet:vegetarian', 'dog', 'brand', 'name', 'club', 'religion', 'vending', 'fuel', 'social_facility', 'highway', 'attraction', 'water',
]);
const CLAUSE = /^\["([a-z_:]+)"(=|~)"([A-Za-z0-9_|^$()?:;,.'’& \-]{1,80})"\]/;

/** The filter if every clause is well-formed and on a known key, else null. */
export function validFilter(f: unknown): string | null {
  if (typeof f !== 'string') return null;
  let rest = f.trim();
  let n = 0;
  while (rest.length) {
    const m = CLAUSE.exec(rest);
    if (!m || !FILTER_KEYS.has(m[1])) return null;
    rest = rest.slice(m[0].length);
    if (++n > 3) return null;
  }
  return n ? f.trim() : null;
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
  /** postal address, "990 Lincoln Street, Denver, CO 80203"; '' for an area */
  address?: string;
  /** Google's record, when a Places API key is configured (rating, reviews, hours, photos) */
  google?: GooglePlace;
  /** hours as weekday lines, when they came from the business's website */
  weekdayHours?: string[];
  /** the web page the facts came from, when OpenStreetMap had no record */
  source?: string;
  /** Nominatim's addresstype: city, town, country, ...; "user" for the user's own position */
  type: string;
  /** Nominatim's category/type, e.g. "amenity restaurant", for the panel's subtitle */
  kindLabel?: string;
  osmType?: string;
  osmId?: number;
  wikidata?: string;
  wikipedia?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  /** from Wikidata / Wikipedia (enrichPlace) */
  image?: string;
  description?: string;
  extract?: string;
  article?: string;
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
  /** postal address from addr:* tags, when there is a street */
  address?: string;
  phone?: string;
  /** km from the user, when the list is around them */
  distanceKm?: number;
  /** Google's record, when a Places API key is configured */
  google?: GooglePlace;
}

export interface UserLocation {
  lat: number;
  lon: number;
  /** "Denver, Colorado" when it is the saved home location; '' for the browser's position */
  label?: string;
}

export interface PlacesData {
  kind: 'place' | 'list';
  category?: CategoryId;
  /** "Things to do in Lisbon", "Pizza places near you" */
  heading: string;
  /** the named place, or a stand-in for the user's position */
  place: Place;
  items: Attraction[];
  /** the list is around the user's location */
  nearUser?: boolean;
  /** a list was wanted around the user, but no location is known */
  needsLocation?: boolean;
  /** the list could not be fetched (Overpass down or out of time) */
  failed?: boolean;
}

const UA = `${config.siteName}/0.1 (+${config.publicUrl})`;
const MAX_ITEMS = 10;
const CACHE_MS = 24 * 3_600_000;
/** A card whose Overpass step failed is kept only briefly, so "Retry" can succeed. */
const FAILED_CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<PlacesData | null> }>();

/** The card's data for an intent, or null when the place cannot be found. Memoised for a day. */
export function buildPlaces(intent: PlaceIntent, opts: { fresh?: boolean; user?: UserLocation | null; web?: WebHit[] } = {}): Promise<PlacesData | null> {
  const user = intent.kind === 'list' && !intent.place ? (opts.user ?? null) : null;
  // A list around the user is keyed on a ~100 m grid, so the same block gets the memo.
  const where = user ? `${user.lat.toFixed(3)},${user.lon.toFixed(3)}` : intent.place.toLowerCase();
  const key = `${intent.kind}:${intent.category ?? (intent.filters ?? []).join('|')}:${where}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && !opts.fresh && now - hit.at < CACHE_MS) return hit.value;
  const value = resolve(intent, user, opts.web ?? []);
  cache.set(key, { at: now, value });
  value.then(
    (d) => {
      if (d?.failed || d?.needsLocation) cache.set(key, { at: now - CACHE_MS + FAILED_CACHE_MS, value });
    },
    () => cache.delete(key),
  );
  if (cache.size > 300) {
    for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  }
  return value;
}

async function resolve(intent: PlaceIntent, user: UserLocation | null, web: WebHit[]): Promise<PlacesData | null> {
  if (intent.kind === 'place') {
    // The pattern path has only a regular expression's word for it that the
    // text is a place, so Nominatim's answer must be place-shaped. Claude
    // has said what kind of place it is: for a business or landmark a point
    // of interest is wanted, not the city it happens to share a name with,
    // and when Nominatim (weak at shop names) finds nothing, Overpass is
    // asked for the name near the area or the user.
    const poi = intent.source === 'claude' && POI_KINDS.has(intent.placeKind ?? '');
    const prefer = intent.source !== 'claude' ? 'area' : poi ? 'poi' : 'any';
    let place = await geocode(intent.place, { prefer });
    if (!place && poi) {
      // Two fallbacks at once, so the wait is the slower of them, not the
      // sum: OpenStreetMap by name (Overpass, a few seconds, often nothing
      // for a small business) and the business's own website from the web
      // results, its address geocoded. OpenStreetMap's record wins when
      // both answer.
      const [osm, site] = await Promise.all([
        findByName(intent.place, user).catch((err) => {
          console.error('[places] overpass name', intent.place, (err as Error).message);
          return null;
        }),
        web.length
          ? findOnWeb(intent.place.split(',')[0], web).catch((err) => {
              console.error('[places] web', intent.place, (err as Error).message);
              return null;
            })
          : Promise.resolve(null),
      ]);
      place = osm ?? (site ? fromBusiness(site) : null);
      // OpenStreetMap knows the place but not its phone or hours; the website does.
      if (osm && site) {
        osm.phone ||= site.phone;
        osm.website ||= site.website;
        osm.weekdayHours = site.weekdayHours;
        osm.image ||= site.image;
        osm.address ||= site.address;
      }
    }
    if (!place) return null;
    try {
      await enrichPlace(place);
    } catch (err) {
      console.error('[places] enrich', intent.place, (err as Error).message);
    }
    if (gplacesEnabled()) {
      try {
        place.google = (await matchPlace(place.name, place.address ?? '', place)) ?? undefined;
        if (place.google) {
          place.phone ||= place.google.phone;
          place.website ||= place.google.website;
          place.address ||= place.google.address;
        }
      } catch (err) {
        console.error('[places] google', intent.place, (err as Error).message);
      }
    }
    return { kind: 'place', heading: place.name, place, items: [] };
  }

  const label = intent.label || 'Places';
  let place: Place;
  if (intent.place) {
    const found = await geocode(intent.place, { strict: intent.source !== 'claude' });
    if (!found) return null;
    place = found;
  } else if (user) {
    place = { name: user.label || 'you', displayName: user.label || 'your location', type: 'user', lat: user.lat, lon: user.lon };
  } else {
    const stub: Place = { name: 'you', displayName: '', type: 'user', lat: 0, lon: 0 };
    return { kind: 'list', category: intent.category, heading: `${label} near you`, place: stub, items: [], nearUser: true, needsLocation: true };
  }
  const heading = intent.place ? `${label} in ${place.name}` : `${label} near ${user?.label ? place.name : 'you'}`;
  const cat = CATEGORIES.find((c) => c.id === intent.category);
  const filters = (intent.filters?.length ? intent.filters : (cat?.filters ?? [])).map(validFilter).filter((f): f is string => !!f);
  if (!filters.length) return null;
  let items: Attraction[] = [];
  let failed = false;
  try {
    items = await listPlaces(place, {
      filters,
      radiusKm: !intent.place || !cat ? LOCAL_RADIUS_KM : cat.radiusKm,
      notable: !!cat?.notable && !!intent.place,
      from: user ?? undefined,
    });
  } catch (err) {
    failed = true;
    console.error('[places] overpass', intent.place || 'near user', (err as Error).message);
  }
  if (items.length) {
    try {
      await enrich(items);
    } catch (err) {
      console.error('[places] wikidata', intent.place, (err as Error).message);
    }
    if (gplacesEnabled()) {
      try {
        const rated = await ratePlaces(label, items, place);
        for (const [i, g] of rated) items[i].google = g;
      } catch (err) {
        console.error('[places] google', label, (err as Error).message);
      }
    }
  }
  return { kind: 'list', category: intent.category, heading, place, items, nearUser: !intent.place, failed };
}

function fromBusiness(b: BusinessInfo): Place {
  return {
    name: b.name,
    displayName: b.address ? `${b.name}, ${b.address}` : b.name,
    address: b.address,
    type: b.kind || 'business',
    kindLabel: b.kind || 'business',
    lat: b.lat!,
    lon: b.lon!,
    website: b.website,
    phone: b.phone,
    weekdayHours: b.weekdayHours,
    image: b.image,
    source: b.source,
  };
}

/** Claude's kinds that name a point of interest rather than an area. */
const POI_KINDS = new Set(['landmark', 'natural', 'park', 'museum', 'venue', 'business', 'other']);
/** Nominatim classes that are areas, not points of interest. */
const AREA_CLASSES = new Set(['boundary', 'place']);

/**
 * A business Nominatim could not find, looked up by name in OpenStreetMap
 * through Overpass: "Joe's Pizza, Denver, Colorado" becomes a name search
 * within 15 km of Denver; without an area, around the user.
 */
async function findByName(full: string, user: UserLocation | null): Promise<Place | null> {
  const [name, ...rest] = full.split(',').map((s) => s.trim()).filter(Boolean);
  if (!name) return null;
  let center: { lat: number; lon: number } | null = null;
  let city = '';
  if (rest.length) {
    const area = await geocode(rest.join(', '), { prefer: 'area' }).catch(() => null);
    if (area) {
      center = area;
      city = area.name;
    }
  }
  if (!center && user) center = user;
  if (!center) return null;
  const re = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]");
  const box = `(${boxAround(center.lat, center.lon, 15)})`;
  const els = await overpass(`[out:json][timeout:6];nwr["name"~"${re}",i]${box};out center tags 10;`);
  const ranked = rankAttractions(els, center).filter((a) => a.kind && !/^(place|boundary)/.test(a.kind));
  const a = ranked[0];
  if (!a) return null;
  return {
    name: a.name,
    displayName: a.address ? `${a.name}, ${a.address}` : `${a.name}${city ? ', ' + city : ''}`,
    address: a.address,
    type: a.kind,
    kindLabel: a.kind,
    lat: a.lat,
    lon: a.lon,
    osmType: a.osmType,
    osmId: a.osmId,
    wikidata: a.wikidata,
    wikipedia: a.wikipedia,
    website: a.website,
    phone: a.phone,
    openingHours: a.openingHours,
    description: a.description,
  };
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
  type?: string;
  importance?: number;
  osm_type?: string;
  osm_id?: number;
  boundingbox?: [string, string, string, string];
  extratags?: Record<string, string>;
  address?: Record<string, string>;
  error?: string;
}

/**
 * prefer 'area': only cities, regions and the like (the pattern path).
 * prefer 'poi': a point of interest, never the area it is named after.
 * prefer 'any': an area if there is one, else the first hit.
 */
export async function geocode(name: string, opts: { prefer?: 'area' | 'poi' | 'any'; strict?: boolean } = {}): Promise<Place | null> {
  const prefer = opts.prefer ?? (opts.strict === false ? 'any' : 'area');
  const params = new URLSearchParams({ q: name, format: 'jsonv2', limit: '5', addressdetails: '1', extratags: '1', 'accept-language': 'en' });
  const res = await fetch(`${config.nominatimUrl}/search?${params}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  const hits = (await res.json()) as NominatimHit[];
  const typeOf = (x: NominatimHit) => x.addresstype ?? x.category ?? '';
  const isArea = (x: NominatimHit) => PLACE_TYPES.has(typeOf(x)) || AREA_CLASSES.has(x.category ?? '');
  const h =
    (prefer === 'area' ? hits.find((x) => PLACE_TYPES.has(typeOf(x))) : prefer === 'poi' ? hits.find((x) => !isArea(x)) : (hits.find((x) => PLACE_TYPES.has(typeOf(x))) ?? hits[0])) ?? null;
  if (!h) return null;
  return toPlace(h, name);
}

/** The locality at a coordinate ("Denver, Colorado"): the name of a saved home location. */
export async function reverseGeocode(lat: number, lon: number): Promise<Place | null> {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lon), format: 'jsonv2', zoom: '14', addressdetails: '1', 'accept-language': 'en' });
  const res = await fetch(`${config.nominatimUrl}/reverse?${params}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
  const h = (await res.json()) as NominatimHit;
  if (!h || h.error || !h.lat) return null;
  const a = h.address ?? {};
  const locality = a.city || a.town || a.village || a.municipality || a.county || h.name || '';
  const region = a.state || a.country || '';
  const p = toPlace(h, locality);
  p.name = locality || p.name;
  p.displayName = [locality, region].filter(Boolean).join(', ') || p.displayName;
  return p;
}

function toPlace(h: NominatimHit, fallbackName: string): Place {
  const type = h.addresstype ?? h.category ?? '';
  const bb = h.boundingbox?.map(Number) as [number, number, number, number] | undefined;
  const t = h.extratags ?? {};
  const addr = h.address as NominatimAddress | undefined;
  return {
    name: h.name || h.display_name?.split(',')[0] || fallbackName,
    displayName: h.display_name ?? fallbackName,
    address: AREA_CLASSES.has(h.category ?? '') ? '' : formatNominatimAddress(addr, { country: true }),
    type,
    kindLabel: [h.category, h.type].filter((x) => x && x !== 'yes').join(' ').replace(/_/g, ' ') || undefined,
    lat: Number(h.lat),
    lon: Number(h.lon),
    bbox: bb && bb.every(Number.isFinite) ? bb : undefined,
    osmType: h.osm_type,
    osmId: h.osm_id,
    wikidata: t.wikidata,
    wikipedia: t.wikipedia,
    website: t.website || t['contact:website'] || t.url,
    phone: t.phone || t['contact:phone'],
    openingHours: t.opening_hours,
  };
}

/**
 * A single place's panel material: photo, one-line description and English
 * article from Wikidata (one SPARQL query), then the article's first
 * paragraph from Wikipedia's summary endpoint. Each step is optional.
 */
async function enrichPlace(place: Place): Promise<void> {
  if (place.wikidata) {
    const stub: Attraction = { name: place.name, lat: place.lat, lon: place.lon, kind: '', osmType: '', osmId: 0, wikidata: place.wikidata };
    await enrich([stub]);
    place.image = stub.image;
    place.description = stub.description;
    place.article = stub.article;
  }
  const article = place.article ?? (place.wikipedia ? wikipediaArticleUrl(place.wikipedia) : undefined);
  if (!article) return;
  const m = /^https:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/i.exec(article);
  if (!m) return;
  const res = await fetch(`https://${m[1]}.wikipedia.org/api/rest_v1/page/summary/${m[2]}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return;
  const s = (await res.json()) as { extract?: string; description?: string; thumbnail?: { source?: string }; content_urls?: { desktop?: { page?: string } } };
  if (s.extract) place.extract = s.extract.length > 420 ? s.extract.slice(0, 400).replace(/\s+\S*$/, '') + '…' : s.extract;
  place.description ||= s.description;
  place.image ||= s.thumbnail?.source;
  place.article = s.content_urls?.desktop?.page ?? article;
}

/** OSM's "lang:Title" wikipedia tag as an article URL. */
export function wikipediaArticleUrl(tag: string): string {
  const m = /^([a-z-]{2,10}):(.+)$/i.exec(tag);
  const lang = m ? m[1] : 'en';
  const title = m ? m[2] : tag;
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/** Rough size of a bounding box: the longer side in km. */
export function bboxKm(bbox: [number, number, number, number]): number {
  const [s, n, w, e] = bbox;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  return Math.max((n - s) * 111, (e - w) * 111 * Math.cos(midLat));
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** A box of ±km around a point, as Overpass wants it: south,west,north,east. */
export function boxAround(lat: number, lon: number, km: number): string {
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(4)).join(',');
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

async function listPlaces(
  place: Place,
  opts: { filters: string[]; radiusKm: [number, number]; notable: boolean; from?: { lat: number; lon: number } },
): Promise<Attraction[]> {
  // Search box from the place's size: a village gets the floor, a city the
  // ceiling; a whole country still gets the ceiling, around its centre. A
  // bounding box, not "around": Overpass answers a box in a third of the time.
  const size = place.bbox ? bboxKm(place.bbox) : 0;
  const km = Math.min(opts.radiusKm[1], Math.max(opts.radiusKm[0], size / 2));
  const box = `(${boxAround(place.lat, place.lon, km)})`;
  const query = (extra: string, limit: number) =>
    `[out:json][timeout:12];(${opts.filters.map((f) => `nwr${f}["name"]${extra}${box};`).join('')});out center tags ${limit};`;

  // Landmarks: ask for Wikidata-linked features first (a city has hundreds
  // of named tourism nodes; the linked ones are the ones worth a visit) and
  // widen to everything named only when that is thin, as in a small town.
  let elements = await overpass(query(opts.notable ? '["wikidata"]' : '', 150));
  if (opts.notable && elements.length < 4) elements = elements.concat(await overpass(query('', 60)));
  return rankAttractions(elements, opts.from);
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
 * well-described, then the rest. Around the user, nearer is better: each km
 * costs a point, so a complete record two blocks away beats a bare name
 * across town. Duplicates (a node and the building it sits in) collapse by
 * Wikidata id or name.
 */
export function rankAttractions(elements: OverpassElement[], from?: { lat: number; lon: number }): Attraction[] {
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
    const kind = t.tourism || t.historic || t.amenity || t.leisure || t.natural || t.craft || t.shop || t.healthcare || t.building || t.boundary || t.office || '';
    const dist = from ? distanceKm(from, { lat, lon }) : undefined;
    const score =
      (t.wikidata ? 4 : 0) +
      (t.wikipedia ? 2 : 0) +
      (t.heritage ? 1 : 0) +
      (t.website || t['contact:website'] ? 1 : 0) +
      (t.description ? 0.5 : 0) +
      (t.opening_hours ? 0.5 : 0) +
      (t.phone || t['contact:phone'] ? 0.5 : 0) +
      (t.image || t.wikimedia_commons ? 0.5 : 0) +
      (kind === 'place_of_worship' ? -1 : 0) -
      (dist ?? 0);
    const address = formatTagAddress(t) || undefined;
    // A photo without Wikidata: OSM's own image tag, or a Commons file.
    const commons = t.wikimedia_commons && /^File:/i.test(t.wikimedia_commons) ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(t.wikimedia_commons.slice(5))}?width=400` : undefined;
    const image = t.image && /^https:\/\/\S+\.(jpe?g|png|webp)(\?\S*)?$/i.test(t.image) ? t.image : commons;
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
        phone: t.phone || t['contact:phone'],
        distanceKm: dist,
        image,
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
    if (b.image?.value) a.image ||= commonsThumb(b.image.value);
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
export function directionsUrl(lat: number, lon: number, from?: { lat: number; lon: number } | null): string {
  const origin = from ? `&origin=${from.lat.toFixed(5)}%2C${from.lon.toFixed(5)}` : '';
  return `https://www.google.com/maps/dir/?api=1${origin}&destination=${lat.toFixed(5)}%2C${lon.toFixed(5)}`;
}
export function osmFeatureUrl(type: string, id: number): string {
  return `https://www.openstreetmap.org/${type}/${id}`;
}
