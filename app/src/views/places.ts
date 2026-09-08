import {
  buildMap,
  directionsUrl,
  googleMapsUrl,
  osmFeatureUrl,
  osmUrl,
  type Attraction,
  type Geo,
  type MapModel,
  wikipediaArticleUrl,
  type Place,
  type PlacesData,
} from '../places.js';
import { e, icons, safeUrl } from './html.js';

// The map cards. A map is a clipped box with a layer of tiles and pins
// positioned relative to its centre, so any width works: the page shows as
// much of the virtual viewport as fits (see buildMap in places.ts).

const ATTRIBUTION = `<a class="map-attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>`;

function mapHtml(m: MapModel, opts: { height: number; labels?: boolean; alt: string }): string {
  const tiles = m.tiles
    .map((t) => `<img src="${safeUrl(t.url)}" style="left:${t.left}px;top:${t.top}px" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`)
    .join('');
  const pins = m.pins
    .map(
      (p, i) =>
        `<span class="pin${opts.labels ? ' pin-n' : ''}" style="left:${p.left}px;top:${p.top}px" data-pin="${i}">${opts.labels ? `<b>${i + 1}</b>` : icons.pin}</span>`,
    )
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
  return `<div class="ib-map">
  ${mapHtml(m, { height: 190, alt: `Map of ${name}` })}
  <div class="map-links">
    <a href="${googleMapsUrl(geo.lat, geo.lon)}" target="_blank" rel="noopener">${icons.pin} Google Maps</a>
    <a href="${directionsUrl(geo.lat, geo.lon)}" target="_blank" rel="noopener">${icons.arrowRight} Directions</a>
  </div>
</div>`;
}

/** Chips under a place: the categories we can list around it. */
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

/**
 * The knowledge panel for one place, for the right column: photo, what it
 * is, a paragraph from Wikipedia, a map, address, hours and links. Google
 * shows a place this way; a list of places goes in the main column instead.
 */
export function placePanel(p: Place, target: string): string {
  const parts = p.displayName.split(',').map((s) => s.trim()).filter(Boolean);
  const where = parts.slice(1).slice(-2).join(', ');
  const what = p.description || p.kindLabel || p.type.replace(/_/g, ' ');
  const sub = [cap(what), where && !new RegExp(where.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(what) ? `in ${where}` : ''].filter(Boolean).join(' ');
  const m = buildMap({ points: [p], center: p, bbox: p.bbox, width: 720, height: 200 });
  const article = p.article ?? (p.wikipedia ? wikipediaArticleUrl(p.wikipedia) : '');
  const facts: [string, string][] = [];
  if (p.displayName) facts.push(['Address', p.displayName]);
  if (p.openingHours) facts.push(['Hours', p.openingHours]);
  if (p.phone) facts.push(['Phone', p.phone]);
  const links = [
    `<a href="${googleMapsUrl(p.lat, p.lon)}"${target}>${icons.pin} Google Maps</a>`,
    `<a href="${directionsUrl(p.lat, p.lon)}"${target}>${icons.arrowRight} Directions</a>`,
    article ? `<a href="${safeUrl(article)}"${target}>${icons.book} Wikipedia</a>` : '',
    p.website && /^https?:\/\//i.test(p.website) ? `<a href="${safeUrl(p.website)}"${target}>${icons.globe} Website</a>` : '',
  ].join('');
  return `<section class="infobox place-panel" id="places" data-loaded="1" data-place="side">
  ${p.image ? `<img class="ib-img" src="${safeUrl(p.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
  <h2 class="ib-title">${e(p.name)}</h2>
  <p class="place-kind">${e(sub)}</p>
  ${p.extract ? `<p class="ib-content">${e(p.extract)}</p>` : ''}
  <div class="ib-map">${mapHtml(m, { height: 190, alt: `Map of ${p.name}` })}</div>
  ${facts.length ? `<dl class="ib-attrs">${facts.map(([k, v]) => `<div class="ib-attr"><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('')}</dl>` : ''}
  <div class="map-links place-links">${links}</div>
  ${AREA_KINDS.has(p.type) ? placeChips(p.name) : ''}
</section>`;
}

/** The card for a places query: a panel for one place, a map-and-list card for a category. */
export function placesCard(d: PlacesData, target: string, q = ''): string {
  const p = d.place;
  if (d.kind === 'place') return placePanel(p, target);
  if (!d.items.length) {
    const m = buildMap({ points: [p], center: p, bbox: p.bbox, width: 900, height: 260 });
    return `<section class="places places-one" id="places" data-loaded="1" data-place="main">
  <div class="places-head"><h2>${e(p.name)}</h2><span class="places-sub">${e(p.displayName)}</span></div>
  ${mapHtml(m, { height: 240, alt: `Map of ${p.name}` })}
  <div class="map-links">
    <a href="${googleMapsUrl(p.lat, p.lon)}"${target}>${icons.pin} Google Maps</a>
    <a href="${directionsUrl(p.lat, p.lon)}"${target}>${icons.arrowRight} Directions</a>
    ${p.wikipedia ? `<a href="${wikipediaUrl(p.wikipedia)}"${target}>${icons.book} Wikipedia</a>` : ''}
    ${p.website ? `<a href="${safeUrl(p.website)}"${target}>${icons.globe} Website</a>` : ''}
  </div>
  ${
    d.failed
      ? `<p class="places-empty">OpenStreetMap's query service did not answer in time. <button type="button" class="places-retry" data-q="${e(q)}">${icons.refresh} Try again</button></p>`
      : `<p class="places-empty">OpenStreetMap has nothing tagged for this near ${e(p.name)}. The web results below may do better.</p>`
  }
</section>`;
  }

  const m = buildMap({ points: d.items, width: 900, height: 300 });
  const cards = d.items.map((a, i) => attractionCard(a, i, target)).join('');
  return `<section class="places" id="places" data-loaded="1" data-place="main">
  <div class="places-head">
    <h2>${e(d.heading)}</h2>
    <span class="places-sub">${e(p.displayName)} · from OpenStreetMap</span>
    <a class="places-more" href="${osmUrl(m.lat, m.lon, m.zoom)}"${target}>${icons.expand} Larger map</a>
  </div>
  ${mapHtml(m, { height: 260, labels: true, alt: `Map of ${d.heading}` })}
  <div class="places-row" tabindex="0" aria-label="${e(d.heading)}">${cards}</div>
</section>`;
}

function attractionCard(a: Attraction, i: number, target: string): string {
  const href = a.article ?? (a.wikipedia ? wikipediaUrl(a.wikipedia) : a.website && /^https?:\/\//i.test(a.website) ? a.website : osmFeatureUrl(a.osmType, a.osmId));
  const meta = [a.kind, a.cuisine, a.address].filter(Boolean).map((s) => e(s)).join(' · ');
  return `<a class="place-card" href="${safeUrl(href)}"${target} data-pin="${i}">
  <span class="place-img">${a.image ? `<img src="${safeUrl(a.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<b class="place-n">${i + 1}</b></span>
  <span class="place-name">${e(a.name)}</span>
  ${a.description ? `<span class="place-desc">${e(cap(a.description))}</span>` : meta ? `<span class="place-desc">${meta}</span>` : ''}
  ${a.openingHours ? `<span class="place-hours">${icons.clock} ${e(a.openingHours)}</span>` : ''}
</a>`;
}

const wikipediaUrl = wikipediaArticleUrl;

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
