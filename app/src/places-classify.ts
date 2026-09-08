import { createHash } from 'node:crypto';
import { cacheKey, getCached, putCached } from './cache.js';
import { config } from './config.js';
import { askClaude } from './overview/ask.js';
import { CATEGORIES, CATEGORY_IDS, placeIntent, validFilter, type CategoryId, type PlaceIntent } from './places.js';

// Is this query about a place, or about places of a kind? The regular
// expressions in places.ts catch the obvious shapes ("things to do in
// Lisbon", "restaurants near me") for free. Everything else that could
// plausibly be a place goes to Claude (Haiku, one short completion, no
// tools), which knows that "denver" and "golden gate bridge" are places,
// "paris hilton" and "boston dynamics" are not, and that "pizza" or "urgent
// care" mean places of a kind around the user, and can write the
// OpenStreetMap tag filters for that kind. The verdict is cached on disk
// with the overviews, so a query costs at most one small Claude call ever.

const CANON = CATEGORIES.map((c) => `  ${c.id}: ${c.filters.join(' ')}`).join('\n');

export const CLASSIFY_SYSTEM = `You decide whether a web search query is about a place, for a personal search engine that can show a map card next to the results. Reply with one line of JSON and nothing else.

Schema: {"place": boolean, "mode": "one"|"list", "name": string, "kind": string, "what": string, "area": string, "category": string|null, "filters": string[]}

"place" is true in two cases:
- mode "one": the query is mainly about one specific place a person could go to: a country, region, state, city, town, neighbourhood, street, landmark, natural feature, park, museum, venue, stadium, airport, campus, or a particular shop, restaurant, hotel or other business or building ("denver", "golden gate bridge", "joe's pizza denver", "the met").
- mode "list": the query asks for places of a kind, either in a named area ("sushi in austin", "things to do in kyoto", "dog parks denver") or, with no area or with "near me", around the user ("pizza", "coffee", "urgent care", "gas station", "hardware store", "dog parks near me").

"place" is false for people, companies as organisations, chains discussed as companies, products, software, films, books, sports teams, events, recipes, definitions, how-tos, history or facts questions, travel logistics (flights, visas, weather, time zones) and anything else, even when a place is mentioned in passing: "history of rome", "flights to paris", "weather in denver", "paris hilton", "boston dynamics", "amazon", "chicago bulls", "pizza dough recipe", "how to make coffee" are all false. A single ambiguous word is a place only when a place is its most common meaning: "paris", "phoenix", "denver" are places; "mercury", "apple", "orange", "python" are not. A single word naming a kind of venue people go out for ("pizza", "sushi", "coffee", "pharmacy", "dentist", "gym", "brunch") is a list around the user.

Fields:
- "name" (mode one): the place to look up, written the way a geocoder wants it: the proper name plus the city, state or country when the query gives or implies one ("Eiffel Tower, Paris", "Joe's Pizza, Denver", "Denver, Colorado"). Fix obvious misspellings.
- "kind" (mode one): one of city, town, region, country, neighbourhood, landmark, natural, park, museum, venue, business, other.
- "what" (mode list): a short plural heading for the kind of place, capitalised: "Pizza places", "Coffee shops", "Dog parks", "Urgent care", "Hardware stores", "Things to do".
- "area" (mode list): the named place the list is wanted in, as for "name"; "" when the query gives none or says near me.
- "category" (mode list): one of ${CATEGORY_IDS.join(', ')} when the kind is one of those, else null.
- "filters" (mode list): one to three OpenStreetMap Overpass tag filters for the kind, OR-ed together, each a chain of ["key"="value"] or ["key"~"regex"] clauses using only these keys: amenity, shop, tourism, leisure, cuisine, craft, healthcare, natural, historic, sport, office, building, aeroway, railway, public_transport, emergency, man_made, brand, name. Prefer specific tags: pizza -> ["amenity"="restaurant"]["cuisine"~"pizza"]; coffee -> ["amenity"="cafe"]; dog parks -> ["leisure"="dog_park"]; urgent care -> ["amenity"="clinic"]["healthcare"~"clinic|urgent"] and ["healthcare"="urgent_care"]; gas station -> ["amenity"="fuel"]; hardware store -> ["shop"~"^(hardware|doityourself)$"]; pharmacy -> ["amenity"="pharmacy"]; grocery -> ["shop"~"^(supermarket|grocery|convenience)$"]; gym -> ["leisure"="fitness_centre"]; a chain by name -> ["brand"~"Home Depot"] or ["name"~"Trader Joe"]. For the built-in categories use exactly these:
${CANON}
For mode one and for place=false, "what", "area" and "filters" are "" / [] and "category" is null.

Examples:
"denver" -> {"place":true,"mode":"one","name":"Denver, Colorado","kind":"city","what":"","area":"","category":null,"filters":[]}
"golden gate bridge" -> {"place":true,"mode":"one","name":"Golden Gate Bridge, San Francisco","kind":"landmark","what":"","area":"","category":null,"filters":[]}
"joe's pizza denver" -> {"place":true,"mode":"one","name":"Joe's Pizza, Denver, Colorado","kind":"business","what":"","area":"","category":null,"filters":[]}
"opossumtown pike vet hospital frederick md" -> {"place":true,"mode":"one","name":"Opossumtown Pike Vet Hospital, Frederick, Maryland","kind":"business","what":"","area":"","category":null,"filters":[]}
"things to see in kyoto" -> {"place":true,"mode":"list","name":"","kind":"","what":"Things to do","area":"Kyoto, Japan","category":"attractions","filters":["[\\"tourism\\"~\\"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park)$\\"]","[\\"historic\\"~\\"^(castle|monument|memorial|palace|fort|ruins|archaeological_site|city_gate|tower|citadel)$\\"]"]}
"pizza" -> {"place":true,"mode":"list","name":"","kind":"","what":"Pizza places","area":"","category":null,"filters":["[\\"amenity\\"=\\"restaurant\\"][\\"cuisine\\"~\\"pizza\\"]"]}
"dog parks near me" -> {"place":true,"mode":"list","name":"","kind":"","what":"Dog parks","area":"","category":null,"filters":["[\\"leisure\\"=\\"dog_park\\"]"]}
"where should we eat tonight in austin" -> {"place":true,"mode":"list","name":"","kind":"","what":"Restaurants","area":"Austin, Texas","category":"restaurants","filters":["[\\"amenity\\"=\\"restaurant\\"]"]}
"python list comprehension" -> {"place":false,"mode":"one","name":"","kind":"other","what":"","area":"","category":null,"filters":[]}
"history of rome" -> {"place":false,"mode":"one","name":"","kind":"other","what":"","area":"","category":null,"filters":[]}`;

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
  let v: { place?: unknown; mode?: unknown; name?: unknown; kind?: unknown; what?: unknown; area?: unknown; category?: unknown; filters?: unknown };
  try {
    v = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (v.place !== true) return null;
  const str = (x: unknown, max = 100) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  const category = CATEGORY_IDS.includes(v.category as CategoryId) ? (v.category as CategoryId) : undefined;
  if (v.mode === 'list' || category || v.what) {
    const cat = CATEGORIES.find((c) => c.id === category);
    const given = Array.isArray(v.filters) ? v.filters.map(validFilter).filter((f): f is string => !!f).slice(0, 3) : [];
    const filters = given.length ? given : (cat?.filters ?? []);
    if (!filters.length) return null;
    const label = str(v.what, 40) || cat?.label || 'Places';
    return { kind: 'list', place: str(v.area), label, filters, category, source: 'claude' };
  }
  const name = str(v.name);
  return name ? { kind: 'place', place: name, placeKind: str(v.kind, 20).toLowerCase() || undefined, source: 'claude' } : null;
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
      console.log(`[places] classify "${s}" -> ${intent ? `${intent.kind} ${intent.label ?? ''} ${intent.place || (intent.kind === 'list' ? '(near user)' : '')}` : 'not a place'} (${Date.now() - t} ms)`);
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
    return v && typeof v === 'object' && typeof v.place === 'string' && (v.kind === 'place' || v.kind === 'list') ? v : null;
  } catch {
    return null;
  }
}
