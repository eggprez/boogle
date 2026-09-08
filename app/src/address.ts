// Postal addresses from OpenStreetMap data, and the map links built on
// them. A person wants "990 Lincoln Street, Denver, CO 80203" to copy into
// a text message, and directions that open on the address rather than on a
// bare pair of coordinates.

/** Nominatim's `address` object (addressdetails=1). */
export interface NominatimAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  'ISO3166-2-lvl4'?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
  [k: string]: string | undefined;
}

/** US-style state abbreviation from Nominatim's ISO code ("US-CO" → "CO"), else the state name. */
function region(a: NominatimAddress): string {
  const iso = a['ISO3166-2-lvl4'];
  if (iso && /^(US|CA|AU)-[A-Z]{2,3}$/.test(iso)) return iso.slice(3);
  return a.state ?? '';
}

/** "990 Lincoln Street, Denver, CO 80203" from a Nominatim address; '' when there is no street. */
export function formatNominatimAddress(a: NominatimAddress | undefined, opts: { country?: boolean } = {}): string {
  if (!a) return '';
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const locality = a.city || a.town || a.village || a.municipality || a.county || '';
  const reg = region(a);
  const tail = [reg, a.postcode].filter(Boolean).join(' ');
  const parts = [street, locality, tail].filter(Boolean);
  if (opts.country && a.country && a.country_code !== 'us') parts.push(a.country);
  return parts.join(', ');
}

/** The same from OpenStreetMap addr:* tags on a feature; '' when there is no street. */
export function formatTagAddress(t: Record<string, string>, fallbackCity = ''): string {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  if (!street) return '';
  const locality = t['addr:city'] || t['addr:town'] || fallbackCity;
  const tail = [t['addr:state'], t['addr:postcode']].filter(Boolean).join(' ');
  return [street, locality, tail].filter(Boolean).join(', ');
}

/** What a maps app should search for: the name plus the address, else the name plus coordinates. */
export function placeQuery(name: string, address: string, lat: number, lon: number): string {
  if (address) return name && !address.toLowerCase().startsWith(name.toLowerCase()) ? `${name}, ${address}` : address;
  return `${name} @${lat.toFixed(5)},${lon.toFixed(5)}`.trim();
}

export function googleDirections(dest: string, from?: { lat: number; lon: number } | null): string {
  const origin = from ? `&origin=${from.lat.toFixed(5)}%2C${from.lon.toFixed(5)}` : '';
  return `https://www.google.com/maps/dir/?api=1${origin}&destination=${encodeURIComponent(dest)}`;
}
export function appleDirections(dest: string, from?: { lat: number; lon: number } | null): string {
  const origin = from ? `&saddr=${from.lat.toFixed(5)},${from.lon.toFixed(5)}` : '';
  return `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}${origin}`;
}
export function googleSearchUrl(dest: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dest)}`;
}
export function appleSearchUrl(dest: string): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(dest)}`;
}

/** A tel: link target: digits, plus, and nothing else. */
export function telHref(phone: string): string {
  const first = phone.split(/[;,]/)[0].trim();
  return 'tel:' + first.replace(/[^\d+]/g, '');
}
