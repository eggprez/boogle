import { config } from '../config.js';
import { listBangs } from '../bangs.js';
import { MODELS, type Settings } from '../settings.js';
import { TABS, type SearxAnswer, type SearxInfobox, type SearxResponse, type SearxResult, type Tab } from '../searxng.js';
import { displayUrl, e, fmtDate, hostHue, hostOf, icons, safeUrl } from './html.js';
import { layout, logo, searchForm } from './layout.js';

const TAB_LABEL: Record<Tab, string> = { web: 'All', images: 'Images', news: 'News', videos: 'Videos' };
const TAB_ICON: Record<Tab, string> = { web: icons.globe, images: icons.image, news: icons.news, videos: icons.video };

export function homePage(settings: Settings): string {
  return layout({
    title: config.siteName,
    settings,
    bodyClass: 'home',
    body: `
<div class="glow" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span><div class="glow-grid"></div></div>
<a class="iconbtn corner" href="/settings" title="Settings" aria-label="Settings">${icons.gear}</a>
<main class="home-main">
  <span class="pill">${icons.bolt} ${settings.overviewEnabled ? `AI Overview · ${e(cap(settings.model))} · ${settings.overviewMode === 'deep' ? 'reads the pages' : 'from snippets'}` : 'AI Overview off'}</span>
  ${logo('lg')}
  <p class="tagline">Search the web. Get a <b>Claude</b> overview, not Google's.</p>
  ${searchForm({ q: '', tab: 'web', size: 'lg', autofocus: true })}
  <div class="home-chips" id="home-chips" data-empty="1">
    <a class="chip c-img" href="/search?tab=images&q=" data-tab="images">${icons.image} Images</a>
    <a class="chip c-news" href="/search?tab=news&q=" data-tab="news">${icons.news} News</a>
    <a class="chip c-vid" href="/search?tab=videos&q=" data-tab="videos">${icons.video} Videos</a>
  </div>
  <p class="home-hint">Type <kbd>!yt</kbd>, <kbd>!gh</kbd> or <kbd>!w</kbd> to jump straight to a site · press <kbd>/</kbd> to search</p>
</main>
<footer class="home-foot">
  <span>Results by SearXNG · Overview by Claude</span>
  <a href="/settings">Settings</a>
</footer>`,
  });
}

export function resultsPage(opts: {
  q: string;
  tab: Tab;
  page: number;
  data: SearxResponse | null;
  error?: string;
  settings: Settings;
  overviewMode: 'snippets' | 'deep';
}): string {
  const { q, tab, page, data, settings } = opts;
  const target = settings.openInNewTab ? ' target="_blank" rel="noopener"' : ' rel="noopener"';
  const showOverview = settings.overviewEnabled && tab === 'web' && page === 1 && !opts.error;
  const results = data?.results ?? [];

  const tabs = TABS.map(
    (t) =>
      `<a class="tab tab-${t}${t === tab ? ' active' : ''}" href="/search?q=${encodeURIComponent(q)}&tab=${t}">${TAB_ICON[t]}${TAB_LABEL[t]}</a>`,
  ).join('');

  let list = '';
  if (opts.error) {
    list = `<div class="notice error"><strong>Search failed.</strong> ${e(opts.error)}</div>`;
  } else if (!results.length) {
    list = `<div class="notice"><strong>No results for “${e(q)}”.</strong> Try different words, or check that SearXNG's engines are responding.</div>`;
  } else if (tab === 'images') {
    list = `<div class="img-grid">${results.map((r) => imageCard(r)).join('')}</div>`;
  } else if (tab === 'videos') {
    list = results.map((r) => videoCard(r, target)).join('');
  } else if (tab === 'news') {
    list = results.map((r) => newsCard(r, target)).join('');
  } else {
    list = results.map((r) => webResult(r, target)).join('');
  }

  const corrections = (data?.corrections ?? []).filter(Boolean);
  const didYouMean = corrections.length
    ? `<p class="dym">Did you mean: ${corrections
        .slice(0, 3)
        .map((c) => `<a href="/search?q=${encodeURIComponent(c)}&tab=${tab}">${e(c)}</a>`)
        .join(', ')}</p>`
    : '';

  // Short answers (calculator, unit conversion) go above the overview like a
  // Google instant answer; long ones (Wikipedia abstracts) go below it.
  const allAnswers = (data?.answers ?? [])
    .map((a) => (typeof a === 'string' ? { answer: a } : a) as SearxAnswer)
    .filter((a) => a.answer);
  const answerHtml = (a: SearxAnswer, cls: string) =>
    `<div class="answer ${cls}"><div class="answer-text">${e(a.answer)}</div>${a.url ? `<a class="answer-src" href="${safeUrl(a.url)}"${target}>${e(hostOf(a.url))}</a>` : ''}</div>`;
  const shortAnswers = allAnswers.filter((a) => a.answer.length <= 120).map((a) => answerHtml(a, 'short')).join('');
  const longAnswers = allAnswers.filter((a) => a.answer.length > 120).map((a) => answerHtml(a, 'long')).join('');

  const related = (data?.suggestions ?? []).slice(0, 8);
  const relatedHtml =
    related.length && tab === 'web'
      ? `<section class="related"><h2>Related searches</h2><div class="chips">${related
          .map((s) => `<a class="chip" href="/search?q=${encodeURIComponent(s)}&tab=web">${icons.search}${e(s)}</a>`)
          .join('')}</div></section>`
      : '';

  const pager = results.length
    ? `<nav class="pager" aria-label="Pagination">
      ${page > 1 ? `<a class="pg" href="/search?q=${encodeURIComponent(q)}&tab=${tab}&page=${page - 1}">‹ Previous</a>` : '<span></span>'}
      <span class="pg-num">Page ${page}</span>
      <a class="pg" href="/search?q=${encodeURIComponent(q)}&tab=${tab}&page=${page + 1}">Next ›</a>
    </nav>`
    : '';

  // SearXNG's Wikidata engine sometimes fails to resolve labels and returns
  // bare Q-ids ("Q575650"); such a box is useless, so skip it.
  const isQid = (s: unknown) => /^Q\d+$/.test(String(s ?? '').trim());
  // Several engines can each supply an infobox (Wikipedia: text only; Wikidata:
  // image + facts). Show the richest one, and borrow Wikipedia's abstract if
  // the winner lacks a description.
  const candidates = (data?.infoboxes ?? []).filter((ib) => ib.infobox && !isQid(ib.infobox));
  const richness = (ib: SearxInfobox) => (ib.attributes?.length ?? 0) * 2 + (ib.img_src ? 3 : 0) + (ib.urls?.length ?? 0);
  const infobox = candidates.sort((a, b) => richness(b) - richness(a))[0];
  if (infobox) {
    if (infobox.attributes) infobox.attributes = infobox.attributes.filter((a) => !a.value.split(',').every((v) => isQid(v)));
    if (!infobox.content) infobox.content = candidates.find((c) => c.content)?.content;
    const seen = new Set<string>();
    infobox.urls = candidates
      .flatMap((c) => c.urls ?? [])
      .filter((u) => u.url && u.title && !/^P\d+$/.test(u.title) && !seen.has(u.url) && seen.add(u.url));
  }
  const aside = infobox && tab === 'web' ? infoboxCard(infobox, target) : '';

  const overview = showOverview
    ? `<section class="overview" id="overview" data-q="${e(q)}" data-mode="${opts.overviewMode}" data-model="${e(settings.model)}">
  <div class="ov-head">
    <span class="ov-spark">${icons.sparkle}</span>
    <span class="ov-title">AI Overview</span>
    <span class="ov-badges" id="ov-badges"></span>
    <span class="ov-status" id="ov-status" aria-live="polite">Starting…</span>
  </div>
  <div class="ov-progress" id="ov-progress"></div>
  <div class="ov-body" id="ov-body"><div class="ov-skeleton"><span></span><span></span><span></span></div></div>
  <div class="ov-sources" id="ov-sources" hidden></div>
  <div class="ov-actions" id="ov-actions" hidden>
    <button type="button" class="ov-btn" data-action="refresh">${icons.refresh} Regenerate</button>
    <button type="button" class="ov-btn" data-action="deep"${opts.overviewMode === 'deep' ? ' hidden' : ''}>${icons.book} Read the pages</button>
    <span class="ov-note" id="ov-note"></span>
  </div>
</section>`
    : '';

  const unresponsive = (data?.unresponsive_engines ?? []).map((x) => x[0]);
  const engineNote = unresponsive.length
    ? `<p class="engine-note" title="${e(unresponsive.join(', '))}">${unresponsive.length} engine${unresponsive.length > 1 ? 's' : ''} didn't respond</p>`
    : '';

  return layout({
    title: `${q} – ${config.siteName}`,
    settings,
    bodyClass: `results tab-${tab}`,
    body: `
<header class="topbar">
  ${logo('sm')}
  ${searchForm({ q, tab, size: 'sm' })}
  <a class="iconbtn" href="/settings" title="Settings" aria-label="Settings">${icons.gear}</a>
</header>
<nav class="tabs" aria-label="Result types">${tabs}</nav>
<main class="results-layout">
  <div class="main-col">
    ${didYouMean}
    ${shortAnswers}
    ${overview}
    ${longAnswers}
    ${list}
    ${relatedHtml}
    ${pager}
    ${engineNote}
  </div>
  ${aside ? `<aside class="side-col">${aside}</aside>` : ''}
</main>
<footer class="foot"><span>${e(config.siteName)}</span> · Results by SearXNG · Overview by Claude · <a href="/settings">Settings</a></footer>`,
  });
}

function avatar(url: string): string {
  const h = hostOf(url);
  return `<span class="r-avatar" style="--h:${hostHue(h)}" aria-hidden="true">${e(h.charAt(0).toUpperCase() || '•')}</span>`;
}

function webResult(r: SearxResult, target: string): string {
  const date = fmtDate(r.publishedDate);
  return `<article class="result">
  <a class="r-head" href="${safeUrl(r.url)}"${target}>
    ${avatar(r.url)}
    <span class="r-site"><span class="r-host">${e(hostOf(r.url))}</span><span class="r-url">${e(displayUrl(r.url))}</span></span>
  </a>
  <h3 class="r-title"><a href="${safeUrl(r.url)}"${target}>${e(r.title || r.url)}</a></h3>
  ${r.content || date ? `<p class="r-snippet">${date ? `<span class="r-date">${e(date)} — </span>` : ''}${e(r.content ?? '')}</p>` : ''}
</article>`;
}

function newsCard(r: SearxResult, target: string): string {
  const thumb = r.thumbnail || r.img_src;
  const date = fmtDate(r.publishedDate);
  return `<article class="result news">
  <div class="news-text">
    <a class="r-head" href="${safeUrl(r.url)}"${target}>${avatar(r.url)}<span class="r-site"><span class="r-host">${e(hostOf(r.url))}</span>${date ? `<span class="r-url">${e(date)}</span>` : ''}</span></a>
    <h3 class="r-title"><a href="${safeUrl(r.url)}"${target}>${e(r.title || r.url)}</a></h3>
    ${r.content ? `<p class="r-snippet">${e(r.content)}</p>` : ''}
  </div>
  ${thumb ? `<a class="news-thumb" href="${safeUrl(r.url)}"${target}><img src="${safeUrl(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>` : ''}
</article>`;
}

function videoCard(r: SearxResult, target: string): string {
  const thumb = r.thumbnail || r.img_src;
  const meta = [hostOf(r.url), r.author, r.length, fmtDate(r.publishedDate)].filter(Boolean).map(e).join(' · ');
  return `<article class="result video">
  <a class="video-thumb" href="${safeUrl(r.url)}"${target}>
    ${thumb ? `<img src="${safeUrl(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="video-empty"></span>`}
    <span class="video-play">${icons.play}</span>
  </a>
  <div class="video-text">
    <h3 class="r-title"><a href="${safeUrl(r.url)}"${target}>${e(r.title || r.url)}</a></h3>
    <p class="r-meta">${meta}</p>
    ${r.content ? `<p class="r-snippet">${e(r.content)}</p>` : ''}
  </div>
</article>`;
}

function imageCard(r: SearxResult): string {
  const thumb = r.thumbnail_src || r.thumbnail || r.img_src;
  if (!thumb) return '';
  return `<a class="img-card" href="${safeUrl(r.url)}" target="_blank" rel="noopener" title="${e(r.title ?? '')}">
  <img src="${safeUrl(thumb)}" alt="${e(r.title ?? '')}" loading="lazy" referrerpolicy="no-referrer" data-full="${safeUrl(r.img_src ?? '')}">
  <span class="img-cap"><span class="img-title">${e(r.title ?? '')}</span><span class="img-host">${e(hostOf(r.url))}${r.resolution ? ` · ${e(r.resolution)}` : ''}</span></span>
</a>`;
}

function infoboxCard(ib: SearxInfobox, target: string): string {
  const attrs = (ib.attributes ?? [])
    .slice(0, 10)
    .map((a) => `<div class="ib-attr"><dt>${e(a.label)}</dt><dd>${e(a.value)}</dd></div>`)
    .join('');
  const urls = (ib.urls ?? [])
    .slice(0, 6)
    .map((u) => `<a class="ib-link" href="${safeUrl(u.url)}"${target}>${e(u.title)}</a>`)
    .join('');
  return `<section class="infobox">
  ${ib.img_src ? `<img class="ib-img" src="${safeUrl(ib.img_src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
  <h2 class="ib-title">${e(ib.infobox)}</h2>
  ${ib.content ? `<p class="ib-content">${e(ib.content)}</p>` : ''}
  ${attrs ? `<dl class="ib-attrs">${attrs}</dl>` : ''}
  ${urls ? `<div class="ib-links">${urls}</div>` : ''}
</section>`;
}

export function settingsPage(opts: {
  settings: Settings;
  saved?: boolean;
  cleared?: number;
  health: { searxng: boolean; claude: string | null; cacheEntries: number; cacheBytes: number };
  user: string;
}): string {
  const s = opts.settings;
  const sel = (a: string | number, b: string | number) => (String(a) === String(b) ? ' selected' : '');
  const chk = (v: boolean) => (v ? ' checked' : '');
  const bangs = listBangs()
    .map((b) => `<span class="bang"><code>${e(b.bang)}</code> ${e(b.name)}</span>`)
    .join('');
  return layout({
    title: `Settings – ${config.siteName}`,
    settings: s,
    bodyClass: 'settings',
    body: `
<header class="topbar">
  ${logo('sm')}
  <h1 class="page-title">Settings</h1>
  <span class="spacer"></span>
  <span class="who" title="From the auth proxy">${e(opts.user)}</span>
</header>
<main class="settings-main">
  ${opts.saved ? `<div class="notice ok">Settings saved.</div>` : ''}
  ${opts.cleared !== undefined ? `<div class="notice ok">Cleared ${opts.cleared} cached overview${opts.cleared === 1 ? '' : 's'}.</div>` : ''}
  <form method="post" action="/settings" class="settings-form">
    <section>
      <h2>${icons.sparkle} AI Overview</h2>
      <label class="row switch">
        <input type="checkbox" name="overviewEnabled"${chk(s.overviewEnabled)}>
        <span><strong>Show the AI Overview</strong><small>Streams in above web results on every search.</small></span>
      </label>
      <div class="row">
        <span class="row-label"><strong>Depth</strong><small>What Claude gets to read before writing.</small></span>
        <div class="radios">
          <label><input type="radio" name="overviewMode" value="snippets"${s.overviewMode === 'snippets' ? ' checked' : ''}> <strong>Snippets</strong> <small>Fast (a few seconds). Titles and snippets of the top ${config.snippetSources} results.</small></label>
          <label><input type="radio" name="overviewMode" value="deep"${s.overviewMode === 'deep' ? ' checked' : ''}> <strong>Read the pages</strong> <small>Slower (10–30 s). Fetches and reads the top ${config.deepReadPages} pages, then answers with real detail.</small></label>
        </div>
      </div>
      <div class="row">
        <span class="row-label"><strong>Model</strong><small>Claude model used through your Claude Code subscription.</small></span>
        <select name="model">${MODELS.map((m) => `<option value="${m.id}"${sel(s.model, m.id)}>${m.label} — ${e(m.blurb)}</option>`).join('')}</select>
      </div>
    </section>

    <section>
      <h2>Search</h2>
      <div class="row">
        <span class="row-label"><strong>Safe search</strong></span>
        <select name="safesearch">
          <option value="0"${sel(s.safesearch, 0)}>Off</option>
          <option value="1"${sel(s.safesearch, 1)}>Moderate</option>
          <option value="2"${sel(s.safesearch, 2)}>Strict</option>
        </select>
      </div>
      <div class="row">
        <span class="row-label"><strong>Language</strong><small>Passed to SearXNG. "auto" detects from the query.</small></span>
        <select name="language">
          ${['auto', 'all', 'en', 'en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'ja', 'zh'].map((l) => `<option value="${l}"${sel(s.language, l)}>${l}</option>`).join('')}
        </select>
      </div>
      <label class="row switch">
        <input type="checkbox" name="openInNewTab"${chk(s.openInNewTab)}>
        <span><strong>Open results in a new tab</strong></span>
      </label>
    </section>

    <section>
      <h2>Appearance</h2>
      <div class="row">
        <span class="row-label"><strong>Theme</strong></span>
        <select name="theme">
          <option value="system"${sel(s.theme, 'system')}>Follow system</option>
          <option value="light"${sel(s.theme, 'light')}>Light</option>
          <option value="dark"${sel(s.theme, 'dark')}>Dark</option>
        </select>
      </div>
    </section>

    <div class="form-actions">
      <button type="submit" class="btn primary">Save</button>
      <a class="btn" href="/">Back to search</a>
    </div>
  </form>

  <section class="settings-form">
    <h2>Status</h2>
    <dl class="status">
      <dt>SearXNG</dt><dd>${opts.health.searxng ? '<span class="ok-dot"></span> reachable' : '<span class="bad-dot"></span> not reachable at ' + e(config.searxngUrl)}</dd>
      <dt>Claude CLI</dt><dd>${opts.health.claude ? `<span class="ok-dot"></span> ${e(opts.health.claude)}` : '<span class="bad-dot"></span> not found (is it installed in the image?)'}</dd>
      <dt>Overview cache</dt><dd>${opts.health.cacheEntries} entries, ${(opts.health.cacheBytes / 1024).toFixed(0)} KB, kept ${Math.round(config.cacheTtlMs / 3_600_000 / 24)} days</dd>
      <dt>Public URL</dt><dd>${e(config.publicUrl)}</dd>
    </dl>
    <form method="post" action="/settings/clear-cache" class="inline-form">
      <button type="submit" class="btn">Clear overview cache</button>
    </form>
  </section>

  <section class="settings-form">
    <h2>Add to your browser</h2>
    <p>Chrome and Firefox pick up the OpenSearch descriptor automatically. In <strong>Firefox</strong>, click the search icon in the address bar and choose “Add ${e(config.siteName)}”. In <strong>Chrome</strong>, open <code>chrome://settings/searchEngines</code> after visiting this site once and set it as default, or add it manually with:</p>
    <pre><code>${e(config.publicUrl)}/search?q=%s</code></pre>
  </section>

  <section class="settings-form">
    <h2>Bangs</h2>
    <p>Put one anywhere in a query to jump straight to that site.</p>
    <div class="bangs">${bangs}</div>
  </section>
</main>`,
  });
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
