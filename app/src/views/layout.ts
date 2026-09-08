import { config } from '../config.js';
import type { Settings } from '../settings.js';
import type { Tab } from '../searxng.js';
import { e, icons } from './html.js';

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
<link rel="stylesheet" href="/static/style.css">
<style>:root{--accent:${e(config.accent)};}</style>
<script src="/static/markdown.js" defer></script>
<script src="/static/app.js" defer></script>
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
