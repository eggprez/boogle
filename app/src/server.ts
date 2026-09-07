import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { mkdir } from 'node:fs/promises';
import { auth, type AppEnv } from './auth.js';
import { resolveBang } from './bangs.js';
import { cacheStats, clearCache } from './cache.js';
import { config } from './config.js';
import { generateOverview } from './overview/index.js';
import { claudeVersion } from './overview/claude.js';
import { autocomplete, ping, search, TABS, type SearxResponse, type Tab } from './searxng.js';
import { loadSettings, sanitize, saveSettings, type OverviewMode } from './settings.js';
import { e } from './views/html.js';
import { homePage, resultsPage, settingsPage } from './views/pages.js';

const app = new Hono<AppEnv>();

// ---- unauthenticated: static assets, health, OpenSearch descriptor ---------
app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));
app.get('/favicon.ico', (c) => c.redirect('/static/favicon.svg'));
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

app.get('/api/health', async (c) => {
  const [searxng, claude, cache] = await Promise.all([ping(), claudeVersion(), cacheStats()]);
  const ok = searxng;
  return c.json({ ok, searxng, claude, cache, site: config.siteName }, ok ? 200 : 503);
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
  const settings = await loadSettings(c.get('user'));
  const modeParam = c.req.query('mode');
  const overviewMode: OverviewMode = modeParam === 'deep' || modeParam === 'snippets' ? modeParam : settings.overviewMode;

  let data: SearxResponse | null = null;
  let error: string | undefined;
  try {
    data = await search(q, tab, page, { safesearch: settings.safesearch, language: settings.language });
  } catch (err) {
    error = (err as Error).message;
    console.error('[search]', q, error);
  }
  return c.html(resultsPage({ q, tab, page, data, error, settings, overviewMode }));
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

app.get('/api/overview', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 512);
  if (!q) return c.json({ error: 'missing q' }, 400);
  const settings = await loadSettings(c.get('user'));
  if (!settings.overviewEnabled) return c.json({ error: 'overview disabled' }, 403);
  const modeParam = c.req.query('mode');
  const mode: OverviewMode = modeParam === 'deep' || modeParam === 'snippets' ? modeParam : settings.overviewMode;
  const refresh = c.req.query('refresh') === '1';

  c.header('X-Accel-Buffering', 'no'); // tell NGINX not to buffer the stream
  c.header('Cache-Control', 'no-cache, no-transform');

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    stream.onAbort(() => ac.abort());
    try {
      for await (const ev of generateOverview({ query: q, settings, mode, refresh, signal: ac.signal })) {
        if (ac.signal.aborted) break;
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
    } catch (err) {
      console.error('[overview]', q, err);
      if (!ac.signal.aborted) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: (err as Error).message }) });
      }
    }
  });
});

app.get('/settings', async (c) => {
  const user = c.get('user');
  const settings = await loadSettings(user);
  const [searxng, claude, cache] = await Promise.all([ping(), claudeVersion(), cacheStats()]);
  const cleared = c.req.query('cleared');
  return c.html(
    settingsPage({
      settings,
      user,
      saved: c.req.query('saved') === '1',
      cleared: cleared === undefined ? undefined : Number(cleared),
      health: { searxng, claude, cacheEntries: cache.entries, cacheBytes: cache.bytes },
    }),
  );
});

app.post('/settings', async (c) => {
  const form = await c.req.parseBody();
  const s = sanitize({
    overviewEnabled: form.overviewEnabled ?? 'off',
    openInNewTab: form.openInNewTab ?? 'off',
    overviewMode: form.overviewMode,
    model: form.model,
    theme: form.theme,
    safesearch: form.safesearch,
    language: form.language,
  });
  await saveSettings(c.get('user'), s);
  return c.redirect('/settings?saved=1');
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

await mkdir(config.dataDir, { recursive: true }).catch(() => {});
serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`${config.siteName} listening on http://0.0.0.0:${info.port}`);
  console.log(`  SearXNG:   ${config.searxngUrl}`);
  console.log(`  Public:    ${config.publicUrl}`);
  console.log(`  Auth mode: ${config.authMode}${config.authMode === 'proxy' ? ` (header ${config.authUserHeader})` : ''}`);
  console.log(`  Data dir:  ${config.dataDir}`);
});
