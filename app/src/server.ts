import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { mkdir } from 'node:fs/promises';
import { auth, type AppEnv } from './auth.js';
import { resolveBang } from './bangs.js';
import { cacheStats, clearCache } from './cache.js';
import { config } from './config.js';
import { getFavicon, validHost } from './favicons.js';
import { fetchPhoto } from './gplaces.js';
import { generateFollowup, generateOverview, type OverviewEvent } from './overview/index.js';
import { claudeVersion, type FollowupTurn } from './overview/claude.js';
import { topStories } from './news.js';
import { buildPlaces, geocode, placeIntent, reverseGeocode, type UserLocation } from './places.js';
import { classifyPlace } from './places-classify.js';
import { redditHealth } from './reddit.js';
import { autocomplete, parseTimeRange, ping, search, TABS, type SearxResponse, type SearxResult, type Tab } from './searxng.js';
import { loadSettings, parseMode, sanitize, saveSettings } from './settings.js';
import { e } from './views/html.js';
import { homePage, resultsPage, settingsPage } from './views/pages.js';
import { placesCard } from './views/places.js';

const app = new Hono<AppEnv>();

// ---- unauthenticated: static assets, health, OpenSearch descriptor ---------
// Asset URLs carry ?v=<content hash> (see views/layout.ts): a versioned URL can
// be cached forever, an unversioned one must be revalidated so a proxy cache
// never keeps an old build's CSS alive after a deploy.
app.use('/static/*', async (c, next) => {
  await next();
  if (c.res.ok) c.res.headers.set('Cache-Control', c.req.query('v') ? 'public, max-age=31536000, immutable' : 'no-cache');
});
app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));
app.get('/favicon.ico', (c) => c.redirect('/static/favicon.svg'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

app.get('/api/health', async (c) => {
  const [searxng, claude, cache, reddit] = await Promise.all([ping(), claudeVersion(), cacheStats(), redditHealth()]);
  const ok = searxng;
  return c.json({ ok, searxng, claude, cache, reddit, site: config.siteName }, ok ? 200 : 503);
});

app.get('/opensearch.xml', (c) => {
  const u = config.publicUrl;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/" xmlns:moz="http://www.mozilla.org/2006/browser/search/">
  <ShortName>${e(config.siteName)}</ShortName>
  <Description>${e(config.siteName)} search with Claude AI overview</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image width="16" height="16" type="image/svg+xml">${e(u)}/static/favicon.svg</Image>
  <Url type="text/html" method="get" template="${e(u)}/search?q={searchTerms}&amp;tab=web"/>
  <Url type="application/x-suggestions+json" template="${e(u)}/suggest?q={searchTerms}"/>
  <moz:SearchForm>${e(u)}/</moz:SearchForm>
</OpenSearchDescription>`;
  return c.body(xml, 200, { 'Content-Type': 'application/opensearchdescription+xml; charset=utf-8' });
});

// ---- everything below requires the auth proxy's user header ---------------
app.use('*', auth);

app.get('/', async (c) => {
  const settings = await loadSettings(c.get('user'));
  return c.html(homePage(settings));
});

app.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 512);
  if (!q) return c.redirect('/');

  const bang = resolveBang(q);
  if (bang) return c.redirect(bang);

  const tabParam = c.req.query('tab') as Tab | undefined;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'web';
  const page = Math.min(Math.max(parseInt(c.req.query('page') ?? '1', 10) || 1, 1), 50);
  const timeRange = parseTimeRange(c.req.query('t'));
  const fresh = c.req.query('retry') === '1';
  const settings = await loadSettings(c.get('user'));
  const overviewMode = parseMode(c.req.query('mode'), settings.overviewMode);

  const first = tab === 'web' && page === 1;
  const searchOpts = { safesearch: settings.safesearch, language: settings.language, timeRange, fresh };
  // Is this query about a place? The classifier (patterns, else Claude,
  // cached) runs alongside the SearXNG request; its answer decides whether
  // the page gets a map panel instead of an AI overview. It gets a little
  // grace after the search returns; past that the page renders as usual and
  // the client's places request still shows the card when it comes.
  const placesOn = first && config.places && settings.places;
  const classify = placesOn ? classifyPlace(q) : Promise.resolve(null);
  let data: SearxResponse | null = null;
  let error: string | undefined;
  let stories: SearxResult[] = [];
  try {
    // The news search for "Top stories" runs alongside the web search and
    // gives up quietly (news.ts) rather than slow the page down.
    [data, stories] = await Promise.all([search(q, tab, page, searchOpts), first && config.topStories && settings.topStories ? topStories(q, searchOpts) : []]);
  } catch (err) {
    error = (err as Error).message;
    console.error('[search]', q, error);
  }
  // A first-time verdict is a Claude CLI round trip, a few seconds; the
  // grace is long enough for that so a place does not first render with an
  // overview that is then torn down.
  const intent = placesOn ? await Promise.race([classify, new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))]) : null;
  // A knowledge panel from SearXNG (Wikipedia/Wikidata) already answers a
  // place query; the map goes into that panel and no second one is made.
  const hasInfobox = (data?.infoboxes ?? []).some((ib) => ib.infobox && !/^Q\d+$/.test(ib.infobox.trim()));
  // One place, or a kind of place around the user: the map answers that,
  // an overview would only restate it.
  const noOverview = !!intent && (intent.kind === 'place' || !intent.place);
  const placesPending = !placesOn || error || !intent ? false : intent.kind === 'place' ? (hasInfobox ? false : 'side') : 'main';
  return c.html(resultsPage({ q, tab, page, timeRange, data, error, settings, overviewMode, stories, placesOn: placesOn && !error, placesPending, noOverview }));
});

// The places card for a query, as an HTML fragment the results page puts
// in its main column (a list of places) or right column (one place). 204
// when the query is not about a place or the place cannot be found. With
// infobox=1 the page already has a knowledge panel, so a one-place panel
// would be a duplicate and only a list is returned.
app.get('/api/places', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 512);
  if (!q || !config.places) return c.body(null, 204);
  const settings = await loadSettings(c.get('user'));
  if (!settings.places) return c.body(null, 204);
  // Where the user is: the browser's position when the page could get one,
  // else the home location from Settings, else nothing (a list "near me"
  // then asks for one).
  const lat = Number(c.req.query('lat'));
  const lon = Number(c.req.query('lon'));
  const user: UserLocation | null =
    c.req.query('lat') && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
      ? { lat, lon, label: '' }
      : settings.homeLat !== null && settings.homeLon !== null
        ? { lat: settings.homeLat, lon: settings.homeLon, label: settings.homeLabel || settings.home }
        : null;
  let data;
  try {
    const intent = await classifyPlace(q);
    if (!intent) return c.body(null, 204);
    if (intent.kind === 'place' && c.req.query('infobox') === '1') return c.body(null, 204);
    // The web results let a business OpenStreetMap lacks be found on its
    // own website. Same options as the page's search (the time range too),
    // so this is the memoised response, not a second SearXNG round trip.
    const web =
      intent.kind === 'place'
        ? await search(q, 'web', 1, { safesearch: settings.safesearch, language: settings.language, timeRange: parseTimeRange(c.req.query('t')) }).then((d) => d.results, () => [])
        : [];
    data = await buildPlaces(intent, { fresh: c.req.query('retry') === '1', user, web });
  } catch (err) {
    console.error('[places]', q, (err as Error).message);
    return c.body(null, 204);
  }
  if (!data) return c.body(null, 204);
  const target = settings.openInNewTab ? ' target="_blank" rel="noopener"' : ' rel="noopener"';
  // The server memoises the data for a day; the browser must not also keep
  // a copy, or an Overpass hiccup's empty card would stick for the cache's life.
  return c.html(placesCard(data, { target, q, units: settings.units, from: user }), 200, { 'Cache-Control': 'no-store' });
});

// Google Places photos, through the server so the API key stays here.
app.get('/places/photo', async (c) => {
  const name = c.req.query('name') ?? '';
  const photo = await fetchPhoto(name).catch(() => null);
  if (!photo) return c.body(null, 404, { 'Cache-Control': 'private, max-age=3600' });
  return c.body(new Uint8Array(photo.body), 200, {
    'Content-Type': photo.type,
    'Cache-Control': 'private, max-age=604800, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
  });
});

app.get('/suggest', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  let suggestions: string[] = [];
  if (q && !q.startsWith('!')) {
    try {
      suggestions = (await autocomplete(q)).slice(0, 8);
    } catch {
      suggestions = [];
    }
  }
  return c.body(JSON.stringify([q, suggestions]), 200, {
    'Content-Type': 'application/x-suggestions+json; charset=utf-8',
    'Cache-Control': 'private, max-age=60',
  });
});

// Favicon proxy for result cards. Cached on disk; a miss is a 404 so the
// client falls back to the lettered avatar.
app.get('/favicon', async (c) => {
  const host = validHost(c.req.query('host'));
  if (!host) return c.body(null, 404);
  const icon = await getFavicon(host);
  if (!icon) return c.body(null, 404, { 'Cache-Control': 'private, max-age=86400' });
  return c.body(new Uint8Array(icon.body), 200, {
    'Content-Type': icon.type,
    'Cache-Control': 'private, max-age=604800, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
});

/**
 * Stream overview events as SSE. A comment line every 15 s keeps proxies and
 * browsers from dropping a deep-mode stream that is quiet while pages load.
 */
function streamOverview(c: Parameters<typeof streamSSE>[0], run: (signal: AbortSignal) => AsyncGenerator<OverviewEvent>) {
  c.header('X-Accel-Buffering', 'no'); // tell NGINX not to buffer the stream
  c.header('Cache-Control', 'no-cache, no-transform');
  return streamSSE(c, async (stream: SSEStreamingApi) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    const ping = setInterval(() => {
      if (!ac.signal.aborted) void stream.write(': ping\n\n').catch(() => ac.abort());
    }, 15_000);
    try {
      for await (const ev of run(ac.signal)) {
        if (ac.signal.aborted) break;
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
    } catch (err) {
      console.error('[overview]', err);
      if (!ac.signal.aborted) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: (err as Error).message }) });
      }
    } finally {
      clearInterval(ping);
    }
  });
}

app.get('/api/overview', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 512);
  if (!q) return c.json({ error: 'missing q' }, 400);
  const settings = await loadSettings(c.get('user'));
  if (!settings.overviewEnabled) return c.json({ error: 'overview disabled' }, 403);
  const mode = parseMode(c.req.query('mode'), settings.overviewMode);
  const refresh = c.req.query('refresh') === '1';
  const timeRange = parseTimeRange(c.req.query('t'));
  return streamOverview(c, (signal) => generateOverview({ query: q, settings, mode, refresh, timeRange, signal }));
});

app.post('/api/followup', async (c) => {
  let body: { q?: unknown; question?: unknown; mode?: unknown; t?: unknown; history?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'expected JSON' }, 400);
  }
  const q = String(body.q ?? '').trim().slice(0, 512);
  const question = String(body.question ?? '').trim().slice(0, 500);
  if (!q || !question) return c.json({ error: 'missing q or question' }, 400);
  const settings = await loadSettings(c.get('user'));
  if (!settings.overviewEnabled) return c.json({ error: 'overview disabled' }, 403);
  const mode = parseMode(body.mode, settings.overviewMode);
  const timeRange = parseTimeRange(body.t);
  const history: FollowupTurn[] = Array.isArray(body.history)
    ? body.history
        .filter((h): h is FollowupTurn => !!h && typeof h === 'object' && typeof (h as FollowupTurn).question === 'string' && typeof (h as FollowupTurn).answer === 'string')
        .map((h) => ({ question: h.question.slice(0, 500), answer: h.answer.slice(0, 4000) }))
        .slice(-3)
    : [];
  return streamOverview(c, (signal) => generateFollowup({ query: q, question, history, settings, mode, timeRange, signal }));
});

app.get('/settings', async (c) => {
  const user = c.get('user');
  const settings = await loadSettings(user);
  const [searxng, claude, cache, reddit] = await Promise.all([ping(), claudeVersion(), cacheStats(), redditHealth()]);
  const cleared = c.req.query('cleared');
  return c.html(
    settingsPage({
      settings,
      user,
      saved: c.req.query('saved') === '1',
      homeNotFound: c.req.query('home') === 'notfound',
      cleared: cleared === undefined ? undefined : Number(cleared),
      health: { searxng, claude, cacheEntries: cache.entries, cacheBytes: cache.bytes, reddit },
    }),
  );
});

app.post('/settings', async (c) => {
  const form = await c.req.parseBody();
  const before = await loadSettings(c.get('user'));
  const s = sanitize({
    home: form.home,
    homeLat: before.homeLat,
    homeLon: before.homeLon,
    homeLabel: before.homeLabel,
    units: form.units,
    overviewEnabled: form.overviewEnabled ?? 'off',
    openInNewTab: form.openInNewTab ?? 'off',
    topStories: form.topStories ?? 'off',
    places: form.places ?? 'off',
    overviewMode: form.overviewMode,
    model: form.model,
    theme: form.theme,
    safesearch: form.safesearch,
    language: form.language,
  });
  // The home location is geocoded once, when it changes: a "lat, lon" pair
  // is taken as is and named by reverse geocoding; anything else goes to
  // Nominatim. A location that cannot be found is kept as text and flagged.
  let homeNote = '';
  if (s.home !== before.home || (s.home && s.homeLat === null)) {
    s.homeLat = s.homeLon = null;
    s.homeLabel = '';
    if (s.home) {
      try {
        const pair = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s.home);
        if (pair && Math.abs(Number(pair[1])) <= 90 && Math.abs(Number(pair[2])) <= 180) {
          s.homeLat = Number(pair[1]);
          s.homeLon = Number(pair[2]);
          s.homeLabel = (await reverseGeocode(s.homeLat, s.homeLon).catch(() => null))?.displayName ?? '';
        } else {
          const p = await geocode(s.home, { strict: false });
          if (p) {
            s.homeLat = p.lat;
            s.homeLon = p.lon;
            // "Denver, Colorado": the locality and its region, not the whole address line
            const parts = p.displayName.split(',').map((x) => x.trim()).filter(Boolean);
            s.homeLabel = [parts[0], parts.length > 2 ? parts[parts.length - 2] : parts[1]].filter(Boolean).join(', ');
          }
        }
      } catch (err) {
        console.error('[settings] home location', (err as Error).message);
      }
      if (s.homeLat === null) homeNote = '&home=notfound';
    }
  }
  await saveSettings(c.get('user'), s);
  return c.redirect('/settings?saved=1' + homeNote);
});

app.post('/settings/clear-cache', async (c) => {
  const n = await clearCache();
  return c.redirect(`/settings?cleared=${n}`);
});

app.notFound((c) => c.text('Not found', 404));
app.onError((err, c) => {
  console.error('[error]', c.req.path, err);
  return c.text('Something went wrong: ' + err.message, 500);
});

export { app };

if (process.env.BOOGLE_NO_LISTEN !== '1') {
  await mkdir(config.dataDir, { recursive: true }).catch(() => {});
  serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`${config.siteName} listening on http://0.0.0.0:${info.port}`);
    console.log(`  SearXNG:   ${config.searxngUrl}`);
    console.log(`  Public:    ${config.publicUrl}`);
    console.log(`  Auth mode: ${config.authMode}${config.authMode === 'proxy' ? ` (header ${config.authUserHeader})` : ''}`);
    console.log(`  Data dir:  ${config.dataDir}`);
  });
}
