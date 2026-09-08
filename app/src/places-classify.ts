import { createHash } from 'node:crypto';
import { cacheKey, getCached, putCached } from './cache.js';
import { config } from './config.js';
import { askClaude } from './overview/ask.js';
import { CATEGORY_IDS, placeIntent, type CategoryId, type PlaceIntent } from './places.js';

// Is this query about a place? The regular expressions in places.ts catch
// the obvious shapes ("things to do in Lisbon", "map of Berlin") for free.
// Everything else that could plausibly be a place goes to Claude (Haiku, one
// short completion, no tools), which knows that "denver" and "golden gate
// bridge" are places and "paris hilton" and "boston dynamics" are not. The
// verdict is cached on disk with the overviews, so a query costs at most one
// small Claude call ever.

export const CLASSIFY_SYSTEM = `You decide whether a web search query is about a place, for a personal search engine that can show a map card next to the results. Reply with one line of JSON and nothing else.

Schema: {"place": boolean, "name": string, "kind": string, "category": string|null, "area": string}

- "place" is true only when the query is mainly about somewhere a person could go: a country, region, state, city, town, neighbourhood, street, landmark, natural feature, park, museum, venue, stadium, airport, university campus, shop, restaurant, hotel or other business or building. It is also true when the query asks for a kind of venue in or around a place (things to do, museums, restaurants, cafes, bars, hotels, parks, beaches).
- "place" is false for people, companies as organisations, products, software, films, books, sports teams, events, recipes, definitions, how-tos, history or facts questions, travel logistics (flights, visas, weather, time zones) and anything else, even when a place is mentioned in passing. "history of rome", "flights to paris", "weather in denver", "paris hilton", "boston dynamics", "amazon", "chicago bulls" are all false.
- A single ambiguous word is a place only when a place is its most common meaning: "paris", "phoenix", "denver", "lisbon" are true; "mercury", "apple", "orange", "python" are false.
- "name": the place to look up, written the way a geocoder wants it: the proper name plus the city, state or country when the query gives or implies one ("Eiffel Tower, Paris", "Joe's Pizza, Denver", "Denver, Colorado"). Fix obvious misspellings. Empty when "place" is false.
- "kind": one of city, town, region, country, neighbourhood, landmark, natural, park, museum, venue, business, other.
- "category": when the query asks for a kind of venue around a place, one of attractions, museums, restaurants, cafes, bars, hotels, parks, beaches; otherwise null. "area" is then the place they should be around, else "".

Examples:
"things to see in kyoto" -> {"place":true,"name":"Kyoto, Japan","kind":"city","category":"attractions","area":"Kyoto, Japan"}
"where should we eat tonight in austin" -> {"place":true,"name":"Austin, Texas","kind":"city","category":"restaurants","area":"Austin, Texas"}
"fun stuff for kids around denver" -> {"place":true,"name":"Denver, Colorado","kind":"city","category":"attractions","area":"Denver, Colorado"}
"golden gate bridge" -> {"place":true,"name":"Golden Gate Bridge, San Francisco","kind":"landmark","category":null,"area":""}
"denver" -> {"place":true,"name":"Denver, Colorado","kind":"city","category":null,"area":""}
"yosemite" -> {"place":true,"name":"Yosemite National Park, California","kind":"park","category":null,"area":""}
"python list comprehension" -> {"place":false,"name":"","kind":"other","category":null,"area":""}
"history of rome" -> {"place":false,"name":"","kind":"other","category":null,"area":""}`;

/** Changes with the prompt, so cached verdicts from an older prompt are not reused. */
export const CLASSIFY_VERSION = createHash('sha256').update(CLASSIFY_SYSTEM).digest('hex').slice(0, 10);

const MAX_WORDS = 8;
const MAX_CHARS = 80;

/**
 * Queries that cannot be a place, decided without Claude: too long, code or
 * URL fragments, or nothing but numbers. Returns the reason, or null when
 * the query deserves a look.
 */
export function cheapReject(q: string): string | null {
  const s = q.trim();
  if (s.length < 2) return 'empty';
  if (s.length > MAX_CHARS) return 'too long';
  if (s.split(/\s+/).length > MAX_WORDS) return 'too many words';
  if (/https?:|www\.|[{}<>=;|\\/_()]|\.(com|org|net|io|js|py|ts|json)\b/i.test(s)) return 'code or URL';
  if (/^[\d\s.,+-]+$/.test(s)) return 'numbers';
  if (/^(how|why|what|when|which|who|can|does|do|is|are|should)\s+(to|do|does|is|are|can|i|you|we|the|a|an|it|my)\b/i.test(s) && !/\b(in|near|around)\b/i.test(s)) return 'question';
  return null;
}

/** Turn Claude's JSON line into an intent, or null when it says no (or talks nonsense). */
export function parseClassification(text: string): PlaceIntent | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let v: { place?: unknown; name?: unknown; kind?: unknown; category?: unknown; area?: unknown };
  try {
    v = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (v.place !== true) return null;
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 100) : '';
  const area = typeof v.area === 'string' ? v.area.trim().slice(0, 100) : '';
  const category = typeof v.category === 'string' && (CATEGORY_IDS as string[]).includes(v.category) ? (v.category as CategoryId) : undefined;
  const kind = typeof v.kind === 'string' ? v.kind.trim().toLowerCase().slice(0, 20) : undefined;
  if (category) {
    const place = area || name;
    return place ? { kind: 'attractions', category, place, source: 'claude' } : null;
  }
  return name ? { kind: 'place', place: name, placeKind: kind, source: 'claude' } : null;
}

const inflight = new Map<string, Promise<PlaceIntent | null>>();

/**
 * The place intent of a query: the pattern match when there is one,
 * otherwise Claude's verdict (cached). Never throws; a Claude failure is
 * logged and counts as "not a place".
 */
export async function classifyPlace(q: string): Promise<PlaceIntent | null> {
  const fast = placeIntent(q);
  if (fast) return fast;
  const s = q.trim().replace(/\s+/g, ' ');
  if (cheapReject(s)) return null;

  const key = cacheKey(['place-intent', CLASSIFY_VERSION, config.placesModel, s.toLowerCase()]);
  const cached = await getCached(key);
  if (cached) return parseStored(cached.text);
  const running = inflight.get(key);
  if (running) return running;

  const p = (async () => {
    let intent: PlaceIntent | null = null;
    try {
      const t = Date.now();
      const text = await askClaude({ system: CLASSIFY_SYSTEM, prompt: `Query: "${s}"`, model: config.placesModel, timeoutMs: 30_000 });
      intent = parseClassification(text);
      console.log(`[places] classify "${s}" -> ${intent ? `${intent.kind} ${intent.category ?? ''} ${intent.place}` : 'not a place'} (${Date.now() - t} ms)`);
      await putCached({ key, query: s, mode: 'place-intent', model: config.placesModel, text: JSON.stringify(intent), sources: [], createdAt: Date.now() });
    } catch (err) {
      console.error('[places] classify', s, (err as Error).message);
    } finally {
      inflight.delete(key);
    }
    return intent;
  })();
  inflight.set(key, p);
  return p;
}

function parseStored(text: string): PlaceIntent | null {
  try {
    const v = JSON.parse(text) as PlaceIntent | null;
    return v && typeof v === 'object' && typeof v.place === 'string' ? v : null;
  } catch {
    return null;
  }
}
