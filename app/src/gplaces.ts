import { config } from './config.js';

// Google Places API (New), used only when GOOGLE_PLACES_API_KEY is set. It
// is the one source for Google ratings and reviews, and it also knows
// hours, phone numbers, addresses and photos better than OpenStreetMap
// does for shops and restaurants. One Text Search call answers everything
// for one place; for a list, one call brings ratings for all of them.
//
// Costs: Text Search with the atmosphere fields (rating, reviews) is in
// Google's higher SKU, a few cents a call; answers are memoised for a week,
// and one person's searches stay well inside the monthly free credit.
// Photos are served through /places/photo so the key never reaches the
// browser.

export interface GoogleReview {
  author: string;
  rating: number;
  text: string;
  /** "2 weeks ago" */
  when: string;
  url?: string;
}

export interface GooglePlace {
  id: string;
  name: string;
  rating?: number;
  ratingCount?: number;
  mapsUrl?: string;
  address?: string;
  phone?: string;
  website?: string;
  /** "Monday: 11:00 AM – 10:00 PM", one per weekday */
  weekdayHours?: string[];
  openNow?: boolean;
  priceLevel?: string;
  /** photo resource names, for /places/photo?name= */
  photos: string[];
  reviews: GoogleReview[];
  lat?: number;
  lon?: number;
}

export const gplacesEnabled = (): boolean => !!config.googlePlacesKey;

const FIELDS_ONE =
  'places.id,places.displayName,places.rating,places.userRatingCount,places.googleMapsUri,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.currentOpeningHours.openNow,places.priceLevel,places.photos,places.reviews,places.location';
const FIELDS_LIST = 'places.id,places.displayName,places.rating,places.userRatingCount,places.googleMapsUri,places.photos,places.location,places.formattedAddress';

const CACHE_MS = 7 * 24 * 3_600_000;
const cache = new Map<string, { at: number; value: Promise<GooglePlace[]> }>();

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  currentOpeningHours?: { openNow?: boolean };
  priceLevel?: string;
  photos?: { name?: string }[];
  reviews?: { authorAttribution?: { displayName?: string; uri?: string }; rating?: number; text?: { text?: string }; relativePublishTimeDescription?: string; googleMapsUri?: string }[];
  location?: { latitude?: number; longitude?: number };
}

/**
 * Text Search, biased to a point. `text` is what a person would type into
 * Google Maps: "Joe's Pizza, 990 Lincoln Street, Denver" or "pizza".
 */
export function searchPlaces(text: string, near: { lat: number; lon: number; radiusM?: number }, opts: { full?: boolean; max?: number } = {}): Promise<GooglePlace[]> {
  if (!config.googlePlacesKey) return Promise.resolve([]);
  const key = JSON.stringify([text.toLowerCase(), near.lat.toFixed(3), near.lon.toFixed(3), !!opts.full, opts.max ?? 0]);
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = (async () => {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.googlePlacesKey,
        'X-Goog-FieldMask': opts.full ? FIELDS_ONE : FIELDS_LIST,
      },
      body: JSON.stringify({
        textQuery: text,
        pageSize: Math.min(20, Math.max(1, opts.max ?? (opts.full ? 1 : 20))),
        locationBias: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius: near.radiusM ?? 5000 } },
        languageCode: 'en',
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Google Places responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { places?: RawPlace[] };
    return (json.places ?? []).map(toPlace).filter((p): p is GooglePlace => !!p);
  })();
  cache.set(key, { at: now, value });
  value.catch(() => cache.delete(key));
  if (cache.size > 500) for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  return value;
}

function toPlace(r: RawPlace): GooglePlace | null {
  if (!r.id) return null;
  return {
    id: r.id,
    name: r.displayName?.text ?? '',
    rating: r.rating,
    ratingCount: r.userRatingCount,
    mapsUrl: r.googleMapsUri,
    address: r.formattedAddress,
    phone: r.nationalPhoneNumber || r.internationalPhoneNumber,
    website: r.websiteUri,
    weekdayHours: r.regularOpeningHours?.weekdayDescriptions,
    openNow: r.currentOpeningHours?.openNow,
    priceLevel: r.priceLevel && r.priceLevel !== 'PRICE_LEVEL_UNSPECIFIED' ? '$'.repeat(Math.max(1, ['PRICE_LEVEL_FREE', 'PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'].indexOf(r.priceLevel))) : undefined,
    photos: (r.photos ?? []).map((p) => p.name).filter((n): n is string => !!n).slice(0, 6),
    reviews: (r.reviews ?? [])
      .filter((v) => v.text?.text)
      .map((v) => ({
        author: v.authorAttribution?.displayName ?? 'A Google user',
        rating: v.rating ?? 0,
        text: v.text!.text!,
        when: v.relativePublishTimeDescription ?? '',
        url: v.googleMapsUri,
      }))
      .slice(0, 5),
    lat: r.location?.latitude,
    lon: r.location?.longitude,
  };
}

/**
 * The Google record for a named place at a point: the top text-search hit,
 * kept only when its name resembles ours or it sits within 300 m, so a
 * closed shop is not decorated with its neighbour's reviews.
 */
export async function matchPlace(name: string, address: string, at: { lat: number; lon: number }): Promise<GooglePlace | null> {
  const hits = await searchPlaces([name, address].filter(Boolean).join(', '), { lat: at.lat, lon: at.lon, radiusM: 2000 }, { full: true, max: 3 });
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const want = norm(name);
  for (const h of hits) {
    const got = norm(h.name);
    const nameOk = want && got && (got.includes(want) || want.includes(got) || overlap(want, got) >= 0.6);
    const near = h.lat !== undefined && h.lon !== undefined && distM(at, { lat: h.lat, lon: h.lon }) < 300;
    if (nameOk || near) return h;
  }
  return null;
}

/** Ratings for a list: one search for the kind around the centre, matched to our items by name and proximity. */
export async function ratePlaces(kind: string, items: { name: string; lat: number; lon: number }[], center: { lat: number; lon: number }): Promise<Map<number, GooglePlace>> {
  const out = new Map<number, GooglePlace>();
  if (!items.length) return out;
  const hits = await searchPlaces(kind, { lat: center.lat, lon: center.lon, radiusM: 5000 }, { max: 20 });
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  items.forEach((it, i) => {
    const want = norm(it.name);
    const best = hits.find((h) => {
      const got = norm(h.name);
      const close = h.lat !== undefined && h.lon !== undefined && distM(it, { lat: h.lat, lon: h.lon }) < 150;
      return close && (got.includes(want) || want.includes(got) || overlap(want, got) >= 0.5);
    });
    if (best) out.set(i, best);
  });
  return out;
}

function overlap(a: string, b: string): number {
  const A = new Set(a.split(' ').filter((w) => w.length > 2));
  const B = new Set(b.split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}

/** Fetch a photo's bytes for the proxy route. */
export async function fetchPhoto(name: string, maxWidth = 480): Promise<{ body: ArrayBuffer; type: string } | null> {
  if (!config.googlePlacesKey || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name)) return null;
  const res = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidth}&key=${encodeURIComponent(config.googlePlacesKey)}`, {
    signal: AbortSignal.timeout(8_000),
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? 'image/jpeg';
  if (!type.startsWith('image/')) return null;
  return { body: await res.arrayBuffer(), type };
}
