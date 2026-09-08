import { config } from './config.js';

// A business that OpenStreetMap has never heard of (most small ones) can
// still get a place panel: its own website is usually in the web results,
// and websites carry the facts as schema.org JSON-LD (LocalBusiness with a
// PostalAddress, telephone, openingHoursSpecification, geo) or at least a
// street address and a phone number in the text. The address is then
// geocoded with Nominatim, which is good at street addresses even when it
// knows nothing about the shop. Directory pages (MapQuest, Yelp) often put
// the address in their title, which serves as a last resort.

export interface BusinessInfo {
  name: string;
  /** "1550 Opossumtown Pike, Frederick, MD 21702" */
  address: string;
  street?: string;
  city?: string;
  region?: string;
  postcode?: string;
  country?: string;
  phone?: string;
  website?: string;
  /** Google-style lines, "Monday: 8:00 AM–6:00 PM", when the page had a schedule */
  weekdayHours?: string[];
  image?: string;
  lat?: number;
  lon?: number;
  /** schema.org type, "VeterinaryCare" → "veterinary care" */
  kind?: string;
  /** the page the facts came from */
  source: string;
}

export interface WebHit {
  url: string;
  title: string;
  content?: string;
}

const UA = `${config.siteName}/0.1 (+${config.publicUrl})`;
const STOP = new Set(['the', 'and', 'of', 'in', 'at', 'a', 'an', 'inc', 'llc', 'co', 'company', 'near', 'me']);
/** Words that name a kind of business rather than the business: weak evidence in a title. */
const GENERIC = new Set(['vet', 'veterinary', 'veterinarian', 'hospital', 'clinic', 'animal', 'pet', 'restaurant', 'pizza', 'cafe', 'coffee', 'bar', 'grill', 'shop', 'store', 'center', 'centre', 'salon', 'dental', 'dentist', 'auto', 'repair', 'hotel', 'inn', 'market', 'bakery', 'pike', 'road', 'street', 'avenue']);
/** Hosts that never are the business itself; their titles may still carry an address. */
const DIRECTORIES = /(^|\.)(yelp|mapquest|facebook|instagram|tripadvisor|yellowpages|bbb|foursquare|zocdoc|healthgrades|vitals|angi|houzz|nextdoor|linkedin|indeed|glassdoor|google|bing|apple)\.(com|org|net)$/i;

/** Same word, or one a prefix of the other ("opossumtown" ~ "opossum", "veterinary" ~ "vet"). */
function similar(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  return n >= 4 && (a.startsWith(b) || b.startsWith(a));
}

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Web results likely to be the business or a directory entry for it, best
 * first: the query's distinctive words in the title, own site before
 * directories, home and contact pages before deep pages.
 */
export function pickCandidates(name: string, hits: WebHit[], max = 4): WebHit[] {
  const want = tokens(name);
  const distinctive = want.filter((t) => !GENERIC.has(t));
  const scored = hits
    .map((h) => {
      let host = '';
      let depth = 9;
      try {
        const u = new URL(h.url);
        host = u.hostname.replace(/^www\./, '');
        depth = u.pathname.split('/').filter(Boolean).length;
      } catch {
        return null;
      }
      const title = tokens(h.title);
      const hostText = host.replace(/[.-]/g, ' ');
      const has = (t: string) => title.some((w) => similar(w, t)) || hostText.includes(t.slice(0, Math.max(5, t.length - 3)));
      const overlap = want.filter(has).length;
      const strong = distinctive.filter(has).length;
      if (!overlap || (distinctive.length && !strong)) return null;
      const directory = DIRECTORIES.test(host);
      const score = strong * 3 + overlap + (directory ? -2 : 2) + (depth === 0 ? 2 : /contact|about|location|hours/i.test(h.url) ? 1.5 : 0) - Math.min(depth, 3) * 0.3;
      return { h, score, host };
    })
    .filter((x): x is { h: WebHit; score: number; host: string } => !!x)
    .sort((a, b) => b.score - a.score);
  // At most two pages per host: home and contact, say.
  const perHost = new Map<string, number>();
  const out: WebHit[] = [];
  for (const { h, host } of scored) {
    const n = perHost.get(host) ?? 0;
    if (n >= 2) continue;
    perHost.set(host, n + 1);
    out.push(h);
    if (out.length === max) break;
  }
  return out;
}

// ------------------------------------------------------------ extraction ----

interface Ld {
  '@type'?: string | string[];
  '@graph'?: Ld[];
  name?: string;
  telephone?: string | string[];
  url?: string;
  image?: string | string[] | { url?: string };
  logo?: string | { url?: string };
  address?: string | { streetAddress?: string; addressLocality?: string; addressRegion?: string; postalCode?: string; addressCountry?: string | { name?: string } };
  geo?: { latitude?: number | string; longitude?: number | string };
  openingHours?: string | string[];
  openingHoursSpecification?: { dayOfWeek?: string | string[]; opens?: string; closes?: string }[];
  mainEntity?: Ld;
  [k: string]: unknown;
}

const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Every JSON-LD object on a page, flattened through @graph and mainEntity. */
export function jsonLdObjects(html: string): Ld[] {
  const out: Ld[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let v: unknown;
    try {
      v = JSON.parse(m[1].trim().replace(/^\s*<!--|-->\s*$/g, ''));
    } catch {
      continue;
    }
    const walk = (x: unknown) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      const o = x as Ld;
      out.push(o);
      if (o['@graph']) walk(o['@graph']);
      if (o.mainEntity) walk(o.mainEntity);
    };
    walk(v);
  }
  return out;
}

function typeOf(o: Ld): string[] {
  const t = o['@type'];
  return (Array.isArray(t) ? t : t ? [t] : []).map(String);
}

/** The JSON-LD object that describes the business: has an address, prefers LocalBusiness types. */
function pickLd(objects: Ld[]): Ld | null {
  const withAddress = objects.filter((o) => o.address && (typeof o.address === 'string' || o.address.streetAddress));
  if (!withAddress.length) return null;
  const isOrg = (o: Ld) => typeOf(o).some((t) => /Business|Store|Restaurant|Care|Clinic|Hospital|Dentist|Physician|Organization|Service|Shop|Salon|Hotel|Bar|Cafe|Bakery|Gym|Church|School|Attraction|Place/i.test(t));
  return withAddress.find((o) => isOrg(o) && o.telephone) ?? withAddress.find(isOrg) ?? withAddress[0];
}

function str(v: unknown): string {
  if (Array.isArray(v)) return str(v[0]);
  if (v && typeof v === 'object' && 'url' in (v as object)) return str((v as { url?: unknown }).url);
  return typeof v === 'string' ? v.trim() : '';
}

/** openingHoursSpecification or "Mo-Fr 08:00-18:00" strings → Google-style weekday lines. */
export function hoursFromLd(o: Ld): string[] | undefined {
  const table: string[][] = [[], [], [], [], [], [], []];
  const dayIndex = (d: string) => {
    const s = d.replace(/^.*\//, '').toLowerCase();
    return DAY_LONG.findIndex((n) => n.toLowerCase().startsWith(s.slice(0, 2)));
  };
  const to12 = (t: string) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t);
    if (!m) return t;
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h >= 12 && h < 24 ? 'PM' : 'AM'}`;
  };
  for (const s of o.openingHoursSpecification ?? []) {
    if (!s.opens || !s.closes) continue;
    const days = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : s.dayOfWeek ? [s.dayOfWeek] : [];
    for (const d of days) {
      const i = dayIndex(String(d));
      if (i >= 0) table[i].push(`${to12(s.opens)}–${to12(s.closes)}`);
    }
  }
  const strings = Array.isArray(o.openingHours) ? o.openingHours : o.openingHours ? [o.openingHours] : [];
  for (const line of strings) {
    // "Mo-Fr 08:00-18:00" or "Mo,We 09:00-12:00"
    const m = /^([A-Za-z,-]+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(String(line).trim());
    if (!m) continue;
    const range = `${to12(m[2])}–${to12(m[3])}`;
    for (const part of m[1].split(',')) {
      const [a, b] = part.split('-');
      const ia = dayIndex(a);
      const ib = b ? dayIndex(b) : ia;
      if (ia < 0 || ib < 0) continue;
      for (let d = ia; ; d = (d + 1) % 7) {
        table[d].push(range);
        if (d === ib) break;
      }
    }
  }
  if (!table.some((t) => t.length)) return undefined;
  return table.map((t, i) => `${DAY_LONG[i]}: ${t.length ? t.join(', ') : 'Closed'}`);
}

const US_ADDRESS =
  /\b(\d{1,6}[A-Za-z]?\s+(?:[A-Z0-9][\w.'-]*\s+){0,4}(?:Street|St|Avenue|Ave|Road|Rd|Pike|Drive|Dr|Boulevard|Blvd|Lane|Ln|Way|Court|Ct|Place|Pl|Highway|Hwy|Parkway|Pkwy|Circle|Cir|Terrace|Ter|Trail|Trl|Turnpike|Tpke|Route|Rte)\.?(?:\s+(?:Suite|Ste|Unit|#)\s*[\w-]+)?)\s*,?\s*([A-Z][A-Za-z.' -]{1,30}?)\s*,\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/;

/** What a page says about the business, from JSON-LD first, else from its text. */
export function extractBusiness(html: string, pageUrl: string): Omit<BusinessInfo, 'source' | 'name'> & { name?: string } | null {
  const ld = pickLd(jsonLdObjects(html));
  const og = (p: string) => {
    const m = new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)["']`, 'i').exec(html) ?? new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${p}["']`, 'i').exec(html);
    return m ? m[1] : '';
  };
  if (ld) {
    const a = typeof ld.address === 'string' ? { streetAddress: ld.address } : ld.address!;
    const street = a.streetAddress?.trim();
    const city = a.addressLocality?.trim();
    const region = a.addressRegion?.trim();
    const postcode = a.postalCode?.trim();
    const country = typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry?.name;
    const address = [street, city, [region, postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (!address) return null;
    const lat = ld.geo ? Number(ld.geo.latitude) : NaN;
    const lon = ld.geo ? Number(ld.geo.longitude) : NaN;
    const kind = typeOf(ld)
      .find((t) => !/^(Organization|LocalBusiness|Thing|Place|WebPage|WebSite)$/i.test(t))
      ?.replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase();
    return {
      name: str(ld.name) || og('site_name') || undefined,
      address,
      street,
      city,
      region,
      postcode,
      country,
      phone: str(ld.telephone) || undefined,
      website: str(ld.url) || pageUrl,
      weekdayHours: hoursFromLd(ld),
      image: str(ld.image) || str(ld.logo) || og('image') || undefined,
      lat: Number.isFinite(lat) ? lat : undefined,
      lon: Number.isFinite(lon) ? lon : undefined,
      kind,
    };
  }
  // No structured data: a US street address and a phone number in the text.
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|td|h\d)>/gi, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const am = US_ADDRESS.exec(text);
  if (!am) return null;
  const pm = PHONE.exec(text);
  return {
    name: og('site_name') || undefined,
    address: `${am[1]}, ${am[2]}, ${am[3]} ${am[4]}`,
    street: am[1],
    city: am[2],
    region: am[3],
    postcode: am[4],
    phone: pm ? `(${pm[1]}) ${pm[2]}-${pm[3]}` : undefined,
    website: pageUrl,
    image: og('image') || undefined,
  };
}

/** A directory result's title often is "Name, 1550 Opossumtown Pike, Frederick, MD 21702". */
export function addressFromTitle(title: string): Pick<BusinessInfo, 'address' | 'street' | 'city' | 'region' | 'postcode'> | null {
  const m = US_ADDRESS.exec(title);
  return m ? { address: `${m[1]}, ${m[2]}, ${m[3]} ${m[4]}`, street: m[1], city: m[2], region: m[3], postcode: m[4] } : null;
}

// ------------------------------------------------------------- fetching ----

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ' + UA + ')', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(6_000),
      redirect: 'follow',
    });
    if (!res.ok || !/text\/html|xhtml/i.test(res.headers.get('content-type') ?? '')) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
      if (size > 1_500_000) break;
    }
    void reader.cancel().catch(() => {});
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

/** Nominatim's structured search for a street address; null when it has no idea. */
async function geocodeAddress(b: { street?: string; city?: string; region?: string; postcode?: string; country?: string; address: string }): Promise<{ lat: number; lon: number } | null> {
  const tryParams = async (params: URLSearchParams) => {
    params.set('format', 'jsonv2');
    params.set('limit', '1');
    const res = await fetch(`${config.nominatimUrl}/search?${params}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const hits = (await res.json()) as { lat: string; lon: string }[];
    return hits[0] ? { lat: Number(hits[0].lat), lon: Number(hits[0].lon) } : null;
  };
  if (b.street && (b.city || b.postcode)) {
    const p = new URLSearchParams({ street: b.street });
    if (b.city) p.set('city', b.city);
    if (b.region) p.set('state', b.region);
    if (b.postcode) p.set('postalcode', b.postcode);
    if (b.country) p.set('country', b.country);
    const r = await tryParams(p);
    if (r) return r;
  }
  return tryParams(new URLSearchParams({ q: b.address }));
}

/**
 * Find the business among the web results. Candidate pages are fetched in
 * parallel; the first with an address wins (its own site beats a
 * directory), the address is geocoded, and the panel's facts come back.
 */
export async function findOnWeb(name: string, hits: WebHit[]): Promise<BusinessInfo | null> {
  const candidates = pickCandidates(name, hits);
  if (!candidates.length) return null;
  const pages = await Promise.all(candidates.map(async (c) => ({ c, html: await fetchPage(c.url) })));
  let info: (Omit<BusinessInfo, 'source' | 'name'> & { name?: string }) | null = null;
  let source = '';
  let titleName = '';
  for (const { c, html } of pages) {
    const x = html ? extractBusiness(html, c.url) : null;
    if (x) {
      info = x;
      source = c.url;
      titleName = c.title;
      break;
    }
  }
  if (!info) {
    // Directory titles: "Opossum Pike Veterinary Clinic, 1550 Opossumtown Pike, Frederick, MD 21702 - MapQuest"
    for (const c of candidates) {
      const a = addressFromTitle(c.title);
      if (a) {
        info = { ...a, website: undefined };
        source = c.url;
        titleName = c.title.split(',')[0].trim();
        break;
      }
    }
  }
  if (!info) return null;
  if (info.lat === undefined || info.lon === undefined) {
    const g = await geocodeAddress(info).catch(() => null);
    if (!g) return null;
    info.lat = g.lat;
    info.lon = g.lon;
  }
  // The business's own name: from the structured data or og:site_name when
  // present, else the part of the page title that most resembles the
  // query ("Home - Opossum Pike Vet Clinic - medical services..." has three
  // parts; the middle one is the name). The query's words as a last resort.
  const want = tokens(name);
  const overlapWith = (s: string) => tokens(s).filter((w) => want.some((t) => similar(w, t))).length;
  const parts = titleName.split(/\s+[-|–—:]\s+/).map((s) => s.trim()).filter((s) => s && !/^(home|contact( us)?|about( us)?|welcome)$/i.test(s));
  const best = [...(info.name ? [info.name] : []), ...parts].sort((a, b) => overlapWith(b) - overlapWith(a) || a.length - b.length)[0];
  const pageName = best && overlapWith(best) ? best : name;
  const own = info.website && !DIRECTORIES.test(new URL(info.website).hostname) ? info.website : candidates.find((c) => !DIRECTORIES.test(new URL(c.url).hostname))?.url;
  return { ...info, name: pageName.slice(0, 80), website: own ? new URL(own).origin + '/' : undefined, source };
}
