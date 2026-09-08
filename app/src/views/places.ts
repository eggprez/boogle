import { appleDirections, appleSearchUrl, googleDirections, googleSearchUrl, placeQuery, telHref } from '../address.js';
import { compactHours, hoursFromGoogle, parseHours, type Hours } from '../hours.js';
import {
  buildMap,
  distanceKm,
  osmFeatureUrl,
  osmUrl,
  wikipediaArticleUrl,
  type Attraction,
  type Geo,
  type MapModel,
  type Place,
  type PlacesData,
  type UserLocation,
} from '../places.js';
import type { GooglePlace } from '../gplaces.js';
import { e, hostOf, icons, safeUrl } from './html.js';

// The map cards. A map is a clipped box with a layer of tiles and pins
// positioned relative to its centre, so any width works: the page shows as
// much of the virtual viewport as fits (see buildMap in places.ts).

export type Units = 'km' | 'mi';

export interface CardOptions {
  target: string;
  /** the query, for the retry button */
  q?: string;
  units?: Units;
  /** the user's position, for distances and directions */
  from?: UserLocation | null;
}

const ATTRIBUTION = `<a class="map-attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>`;

function mapHtml(m: MapModel, opts: { height: number; labels?: boolean; alt: string; youIndex?: number }): string {
  const tiles = m.tiles
    .map((t) => `<img src="${safeUrl(t.url)}" style="left:${t.left}px;top:${t.top}px" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`)
    .join('');
  const pins = m.pins
    .map((p, i) => {
      if (i === opts.youIndex) return `<span class="pin pin-you" style="left:${p.left}px;top:${p.top}px" title="Your location"><i></i></span>`;
      return `<span class="pin${opts.labels ? ' pin-n' : ''}" style="left:${p.left}px;top:${p.top}px" data-pin="${i}">${opts.labels ? `<b>${i + 1}</b>` : icons.pin}</span>`;
    })
    .join('');
  return `<div class="map" style="height:${opts.height}px" role="img" aria-label="${e(opts.alt)}">
  <div class="map-layer">${tiles}${pins}</div>
  <a class="map-open" href="${osmUrl(m.lat, m.lon, m.zoom)}" target="_blank" rel="noopener" title="Open in OpenStreetMap">${icons.expand}</a>
  ${ATTRIBUTION}
</div>`;
}

/**
 * Small map for a knowledge-panel place: sits inside the infobox, one pin.
 * The zoom comes from the infobox's OpenStreetMap link (Wikidata's area).
 */
export function infoboxMap(geo: Geo & { zoom: number }, name: string): string {
  const m = buildMap({ points: [geo], center: geo, zoom: Math.min(geo.zoom, 15), width: 720, height: 200 });
  const q = placeQuery(name, '', geo.lat, geo.lon);
  return `<div class="ib-map">
  ${mapHtml(m, { height: 190, alt: `Map of ${name}` })}
  <div class="map-links">
    <a href="${googleDirections(q)}" target="_blank" rel="noopener">${icons.pin} Google Maps</a>
    <a href="${appleDirections(q)}" target="_blank" rel="noopener">${icons.pin} Apple Maps</a>
  </div>
</div>`;
}

/** Chips under a place: the kinds of place we can list around it. */
function placeChips(name: string): string {
  const chips: [string, string][] = [
    ['Things to do', `things to do in ${name}`],
    ['Museums', `museums in ${name}`],
    ['Restaurants', `restaurants in ${name}`],
    ['Hotels', `hotels in ${name}`],
    ['Parks', `parks in ${name}`],
  ];
  return `<div class="chips">${chips.map(([label, q]) => `<a class="chip" href="/search?q=${encodeURIComponent(q)}&tab=web">${icons.search}${e(label)}</a>`).join('')}</div>`;
}

const AREA_KINDS = new Set(['city', 'town', 'village', 'municipality', 'county', 'state', 'region', 'province', 'country', 'island', 'suburb', 'neighbourhood', 'borough', 'district']);

export function fmtDistance(km: number, units: Units = 'mi'): string {
  if (units === 'mi') {
    const mi = km * 0.621371;
    return mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(1)} mi`;
  }
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

/** "★★★★☆ 4.6 (1,234)" with a link to the Google listing. */
function ratingHtml(g: GooglePlace | undefined, target: string, compact = false): string {
  if (!g?.rating) return '';
  const stars = Math.round(g.rating);
  const count = g.ratingCount ? g.ratingCount.toLocaleString('en-US') : '';
  const inner = `<span class="stars" aria-hidden="true">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span> <b>${g.rating.toFixed(1)}</b>${count ? ` <span class="rating-n">(${count}${compact ? '' : ' Google reviews'})</span>` : ''}${g.priceLevel && !compact ? ` <span class="rating-n">· ${e(g.priceLevel)}</span>` : ''}`;
  return g.mapsUrl ? `<a class="rating" href="${safeUrl(g.mapsUrl)}"${target} title="Reviews on Google Maps">${inner}</a>` : `<span class="rating">${inner}</span>`;
}

/** The weekly hours as a table; Google's descriptions when there are any, else the OSM opening_hours string. */
function hoursHtml(google: GooglePlace | undefined, raw: string | undefined, units: Units): string {
  const h: Hours | null = (google?.weekdayHours && hoursFromGoogle(google.weekdayHours)) || (raw ? parseHours(raw, { clock: units === 'mi' ? 12 : 24 }) : null);
  const status = google?.openNow === undefined ? '' : `<span class="open-now ${google.openNow ? 'yes' : 'no'}">${google.openNow ? 'Open now' : 'Closed now'}</span>`;
  if (!h) return raw ? `<div class="ib-attr"><dt>Hours</dt><dd>${status} ${e(raw)}</dd></div>` : '';
  const rows = compactHours(h)
    .map((r) => `<tr data-days="${r.days.join(',')}"${r.closed ? ' class="closed"' : ''}><th>${e(r.label)}</th><td>${e(r.text)}</td></tr>`)
    .join('');
  return `<details class="hours"${status ? '' : ' open'}>
  <summary><span class="dt">Hours</span> ${status || (h.summary ? `<span class="hours-sum">${e(h.summary)}</span>` : '<span class="hours-sum" data-today-hours></span>')}${icons.chevronDown}</summary>
  <table>${rows}</table>
  ${h.partial && raw ? `<p class="hours-raw">As tagged: ${e(raw)}</p>` : ''}
</details>`;
}

function reviewsHtml(g: GooglePlace | undefined, target: string): string {
  if (!g?.reviews.length) return '';
  const items = g.reviews
    .slice(0, 3)
    .map((r) => {
      const text = r.text.length > 240 ? r.text.slice(0, 220).replace(/\s+\S*$/, '') + '…' : r.text;
      const stars = Math.max(0, Math.min(5, Math.round(r.rating)));
      return `<li class="review"><span class="review-head"><b>${e(r.author)}</b> <span class="stars" aria-label="${stars} of 5">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span> <span class="review-when">${e(r.when)}</span></span><p>${e(text)}</p></li>`;
    })
    .join('');
  return `<section class="reviews"><h3>${icons.google} Google reviews</h3><ul>${items}</ul>${g.mapsUrl ? `<a class="reviews-more" href="${safeUrl(g.mapsUrl)}"${target}>All reviews on Google Maps ›</a>` : ''}</section>`;
}

function copyable(text: string): string {
  return `<span class="copy"><span class="copy-text">${e(text)}</span><button type="button" class="copy-btn" data-copy="${e(text)}" title="Copy" aria-label="Copy">${icons.copy}</button></span>`;
}

const photoUrl = (g: GooglePlace | undefined, i = 0) => (g?.photos[i] ? `/places/photo?name=${encodeURIComponent(g.photos[i])}` : '');

/**
 * The knowledge panel for one place, for the right column: photo, what it
 * is, rating, a paragraph from Wikipedia, a map, address, hours, phone,
 * directions, reviews. Google shows a place this way; a list of places goes
 * in the main column instead.
 */
export function placePanel(p: Place, o: CardOptions): string {
  const units = o.units ?? 'mi';
  const parts = p.displayName.split(',').map((s) => s.trim()).filter(Boolean);
  const where = parts.slice(1).slice(-2).join(', ');
  const what = p.description || p.kindLabel || p.type.replace(/_/g, ' ');
  const sub = [cap(what), where && !what.toLowerCase().includes(where.toLowerCase()) ? `in ${where}` : ''].filter(Boolean).join(' ');
  const m = buildMap({ points: [p], center: p, bbox: p.bbox, width: 720, height: 200 });
  const article = p.article ?? (p.wikipedia ? wikipediaArticleUrl(p.wikipedia) : '');
  const address = p.address || (AREA_KINDS.has(p.type) ? '' : p.displayName);
  const dest = placeQuery(p.name, address, p.lat, p.lon);
  const image = p.image || photoUrl(p.google);
  const facts: string[] = [];
  if (address) facts.push(`<div class="ib-attr"><dt>Address</dt><dd>${copyable(address)}</dd></div>`);
  facts.push(hoursHtml(p.google, p.openingHours, units));
  if (p.phone) facts.push(`<div class="ib-attr"><dt>Phone</dt><dd><a href="${e(telHref(p.phone))}" class="tel">${icons.phone} ${e(p.phone)}</a></dd></div>`);
  if (o.from) facts.push(`<div class="ib-attr"><dt>Distance</dt><dd>${fmtDistance(distanceKm(o.from, p), units)} from ${o.from.label ? e(o.from.label) : 'you'}</dd></div>`);
  const links = [
    `<a href="${googleDirections(dest, o.from)}"${o.target}>${icons.arrowRight} Google Maps</a>`,
    `<a href="${appleDirections(dest, o.from)}"${o.target}>${icons.arrowRight} Apple Maps</a>`,
    p.website && /^https?:\/\//i.test(p.website) ? `<a href="${safeUrl(p.website)}"${o.target}>${icons.globe} Website</a>` : '',
    article ? `<a href="${safeUrl(article)}"${o.target}>${icons.book} Wikipedia</a>` : '',
  ].join('');
  return `<section class="infobox place-panel" id="places" data-loaded="1" data-place="side">
  ${image ? `<img class="ib-img" src="${safeUrl(image) === '#' ? e(image) : safeUrl(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
  <h2 class="ib-title">${e(p.name)}</h2>
  <p class="place-kind">${e(sub)}</p>
  ${ratingHtml(p.google, o.target)}
  ${p.extract ? `<p class="ib-content">${e(p.extract)}</p>` : ''}
  <div class="ib-map">${mapHtml(m, { height: 190, alt: `Map of ${p.name}` })}</div>
  <div class="map-links place-links">${links}</div>
  <dl class="ib-attrs place-facts">${facts.join('')}</dl>
  ${reviewsHtml(p.google, o.target)}
  ${AREA_KINDS.has(p.type) ? placeChips(p.name) : ''}
</section>`;
}

/** The card for a places query: a panel for one place, a map-and-list card for a kind of place. */
export function placesCard(d: PlacesData, o: CardOptions): string {
  const p = d.place;
  if (d.kind === 'place') return placePanel(p, o);

  if (d.needsLocation) {
    return `<section class="places places-one" id="places" data-loaded="1" data-place="main" data-needs-location="1">
  <div class="places-head"><h2>${e(d.heading)}</h2></div>
  <p class="places-empty">${icons.pin} To show these, the search needs to know where you are. Allow location access in your browser, or set a home location in <a href="/settings#location">Settings</a>.</p>
</section>`;
  }

  if (!d.items.length) {
    const m = buildMap({ points: [p], center: p, bbox: p.bbox, zoom: d.nearUser ? 13 : undefined, width: 900, height: 260 });
    const dest = placeQuery(p.name, p.address ?? '', p.lat, p.lon);
    return `<section class="places places-one" id="places" data-loaded="1" data-place="main">
  <div class="places-head"><h2>${e(d.heading)}</h2><span class="places-sub">${e(p.displayName)}</span></div>
  ${mapHtml(m, { height: 240, alt: `Map of ${p.name}`, youIndex: d.nearUser ? 0 : undefined })}
  <div class="map-links">
    ${d.nearUser ? '' : `<a href="${googleSearchUrl(dest)}"${o.target}>${icons.pin} Google Maps</a><a href="${appleSearchUrl(dest)}"${o.target}>${icons.pin} Apple Maps</a>`}
    ${p.wikipedia ? `<a href="${wikipediaArticleUrl(p.wikipedia)}"${o.target}>${icons.book} Wikipedia</a>` : ''}
  </div>
  ${
    d.failed
      ? `<p class="places-empty">OpenStreetMap's query service did not answer in time. <button type="button" class="places-retry" data-q="${e(o.q ?? '')}">${icons.refresh} Try again</button></p>`
      : `<p class="places-empty">OpenStreetMap has nothing tagged for this ${d.nearUser ? 'near you' : `near ${e(p.name)}`}. The web results below may do better.</p>`
  }
</section>`;
  }

  const points: { lat: number; lon: number }[] = d.items.map((a) => ({ lat: a.lat, lon: a.lon }));
  if (d.nearUser) points.push(p);
  const m = buildMap({ points, width: 900, height: 300 });
  const cards = d.items.map((a, i) => attractionCard(a, i, o, d.nearUser ? '' : p.name)).join('');
  const sub = d.nearUser ? (p.type === 'user' && p.displayName !== 'your location' ? `around ${e(p.displayName)}` : 'around your location') : e(p.displayName);
  return `<section class="places" id="places" data-loaded="1" data-place="main">
  <div class="places-head">
    <h2>${e(d.heading)}</h2>
    <span class="places-sub">${sub} · from OpenStreetMap${d.items.some((a) => a.google) ? ' and Google' : ''}</span>
    <a class="places-more" href="${osmUrl(m.lat, m.lon, m.zoom)}"${o.target}>${icons.expand} Larger map</a>
  </div>
  ${mapHtml(m, { height: 260, labels: true, alt: `Map of ${d.heading}`, youIndex: d.nearUser ? d.items.length : undefined })}
  <div class="places-row" tabindex="0" aria-label="${e(d.heading)}">${cards}</div>
</section>`;
}

function attractionCard(a: Attraction, i: number, o: CardOptions, city: string): string {
  const units = o.units ?? 'mi';
  const address = a.address || '';
  const dest = placeQuery(a.name, address ? `${address}${city && !address.includes(city) ? ', ' + city : ''}` : '', a.lat, a.lon);
  const href = a.article ?? (a.wikipedia ? wikipediaArticleUrl(a.wikipedia) : a.google?.mapsUrl ?? (a.website && /^https?:\/\//i.test(a.website) ? a.website : osmFeatureUrl(a.osmType, a.osmId)));
  const meta = [a.kind, a.cuisine].filter(Boolean).map((s) => e(s)).join(' · ');
  const dist = a.distanceKm !== undefined ? `<span class="place-dist">${icons.pin} ${fmtDistance(a.distanceKm, units)}</span>` : '';
  const image = a.image || photoUrl(a.google);
  // No photo anywhere: the place's own site icon on the tile, so the card is not blank.
  const host = a.website && /^https?:\/\//i.test(a.website) ? hostOf(a.website) : '';
  const fallback = !image && host && /^[a-z0-9.-]+$/i.test(host) ? `<img class="place-fav" src="/favicon?host=${encodeURIComponent(host)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  const hours = a.google?.weekdayHours ? hoursFromGoogle(a.google.weekdayHours) : a.openingHours ? parseHours(a.openingHours, { clock: units === 'mi' ? 12 : 24 }) : null;
  const todayAttr = hours ? ` data-hours="${e(JSON.stringify(hours.days.map((d) => d.text)))}"` : '';
  return `<div class="place-card" data-pin="${i}"${todayAttr}>
  <a class="place-img" href="${safeUrl(href)}"${o.target} tabindex="-1">${image ? `<img src="${safeUrl(image) === '#' ? e(image) : safeUrl(image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : fallback}<b class="place-n">${i + 1}</b>${dist}</a>
  <a class="place-name" href="${safeUrl(href)}"${o.target}>${e(a.name)}</a>
  ${ratingHtml(a.google, o.target, true)}
  ${a.description ? `<span class="place-desc">${e(cap(a.description))}</span>` : meta ? `<span class="place-desc">${meta}</span>` : ''}
  ${address ? `<span class="place-addr">${e(address)}</span>` : ''}
  ${hours ? `<span class="place-hours" data-today-hours>${icons.clock} <span></span></span>` : ''}
  <span class="place-actions">
    <a href="${googleDirections(dest, o.from)}"${o.target} title="Directions in Google Maps">${icons.arrowRight} Directions</a>
    ${a.phone ? `<a href="${e(telHref(a.phone))}" title="${e(a.phone)}">${icons.phone} Call</a>` : ''}
    ${a.website && /^https?:\/\//i.test(a.website) ? `<a href="${safeUrl(a.website)}"${o.target}>${icons.globe} Site</a>` : ''}
  </span>
</div>`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
