import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import type { Settings } from '../settings.js';
import type { Tab } from '../searxng.js';
import { e, icons } from './html.js';

/**
 * Content hash of the static assets, appended to their URLs so a browser (or a
 * caching reverse proxy) never pairs a new page with a stylesheet or script
 * cached from an older build.
 */
export const ASSET_VERSION = (() => {
  const h = createHash('sha256');
  for (const f of ['style.css', 'app.js', 'markdown.js']) {
    try {
      h.update(readFileSync(new URL(`../../public/${f}`, import.meta.url)));
    } catch {
      h.update(f);
    }
  }
  return h.digest('hex').slice(0, 8);
})();
const asset = (f: string) => `/static/${f}?v=${ASSET_VERSION}`;

export function layout(opts: {
  title: string;
  settings: Settings;
  body: string;
  bodyClass?: string;
  description?: string;
}): string {
  const theme = opts.settings.theme === 'system' ? '' : ` data-theme="${opts.settings.theme}"`;
  return `<!doctype html>
<html lang="en"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(opts.title)}</title>
<meta name="description" content="${e(opts.description ?? `${config.siteName} search`)}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="search" type="application/opensearchdescription+xml" title="${e(config.siteName)}" href="/opensearch.xml">
<link rel="stylesheet" href="${asset('style.css')}">
<style>:root{--accent:${e(config.accent)};}</style>
<script src="${asset('markdown.js')}" defer></script>
<script src="${asset('app.js')}" defer></script>
</head>
<body class="${e(opts.bodyClass ?? '')}">
${opts.body}
</body>
</html>`;
}

export function searchForm(opts: { q: string; tab: Tab; size: 'lg' | 'sm'; autofocus?: boolean }): string {
  return `<form class="searchbox searchbox-${opts.size}" action="/search" method="get" role="search" autocomplete="off">
  <input type="hidden" name="tab" value="${e(opts.tab)}">
  <span class="sb-icon">${icons.search}</span>
  <input class="sb-input" type="text" name="q" value="${e(opts.q)}" placeholder="Search the web, or try a !bang" aria-label="Search"${opts.autofocus ? ' autofocus' : ''} spellcheck="false" autocapitalize="off" autocorrect="off" maxlength="512" required>
  <button type="button" class="sb-clear" aria-label="Clear"${opts.q ? '' : ' hidden'}>${icons.close}</button>
  <button type="submit" class="sb-go" aria-label="Search">${icons.arrowRight}</button>
  <ul class="suggest" role="listbox" hidden></ul>
</form>`;
}

export function logo(size: 'lg' | 'sm'): string {
  return `<a class="logo logo-${size}" href="/" aria-label="${e(config.siteName)} home"><span class="logo-text">${e(config.siteName)}</span><span class="logo-mark">${icons.sparkle}</span></a>`;
}
