// All runtime configuration comes from environment variables so the same
// image works on TrueNAS, a plain Docker host, or a laptop.
function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
}
function list(name: string): string[] {
  return str(name, '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  siteName: str('SITE_NAME', 'Boogle'),
  publicUrl: str('PUBLIC_URL', 'http://localhost:8080').replace(/\/+$/, ''),
  accent: str('ACCENT_COLOR', '#6d28d9'),
  port: num('PORT', 8080),

  searxngUrl: str('SEARXNG_URL', 'http://searxng:8080').replace(/\/+$/, ''),
  // Reddit worker (reddit/worker.mjs); empty = no Reddit backfill.
  redditWorkerUrl: str('REDDIT_WORKER_URL', '').replace(/\/+$/, ''),
  // Engine weight Reddit threads get when merged into SearXNG's scores.
  redditWeight: num('REDDIT_WEIGHT', 0.8),

  // 'proxy' trusts the user header set by TinyAuth/Authelia/etc.
  // 'none' treats every request as the same local user (LAN-only use / dev).
  authMode: str('AUTH_MODE', 'proxy') as 'proxy' | 'none',
  authUserHeader: str('AUTH_USER_HEADER', 'Remote-User'),
  // Optional defense in depth: NGINX adds X-Proxy-Secret so requests that
  // somehow reach the app port directly (with a forged Remote-User) are refused.
  authProxySecret: str('AUTH_PROXY_SECRET', ''),
  allowedUsers: list('ALLOWED_USERS'),

  dataDir: str('DATA_DIR', '/data'),

  claudeBin: str('CLAUDE_BIN', 'claude'),
  claudeTimeoutMs: num('OVERVIEW_TIMEOUT_SECONDS', 120) * 1000,
  maxConcurrentOverviews: num('MAX_CONCURRENT_OVERVIEWS', 2),
  cacheTtlMs: num('OVERVIEW_CACHE_TTL_HOURS', 24 * 7) * 3600 * 1000,
  deepReadPages: num('DEEP_READ_PAGES', 5),
  deepReadCharsPerPage: num('DEEP_READ_CHARS_PER_PAGE', 6000),
  snippetSources: num('SNIPPET_SOURCES', 10),
};

export type Config = typeof config;
