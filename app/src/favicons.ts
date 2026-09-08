import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { isPrivateHost } from './overview/pages.js';

/**
 * Favicon proxy: the browser asks us for /favicon?host=example.com and we
 * fetch the icon once, cache it on disk, and serve it. The browser never
 * talks to the result site (or a third-party icon service) directly.
 */
export interface Favicon {
  body: Buffer;
  type: string;
}

const TTL_MS = 7 * 24 * 3600 * 1000;
const NEG_TTL_MS = 24 * 3600 * 1000;
const MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 4000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 BoogleFavicon/1.0';

const dir = () => path.join(config.dataDir, 'favicons');
const inflight = new Map<string, Promise<Favicon | null>>();

/** Hostname validation: letters, digits, dots, hyphens; public hosts only. */
export function validHost(host: unknown): string | null {
  const h = String(host ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (!h || h.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return null;
  if (isPrivateHost(h)) return null;
  return h;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const TYPE: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([t, x]) => [x, t]));

export async function getFavicon(host: string): Promise<Favicon | null> {
  const cached = await readCache(host);
  if (cached !== undefined) return cached;
  let p = inflight.get(host);
  if (!p) {
    p = fetchAndStore(host).finally(() => inflight.delete(host));
    inflight.set(host, p);
  }
  return p;
}

/** undefined = not cached; null = cached miss */
async function readCache(host: string): Promise<Favicon | null | undefined> {
  for (const ext of [...Object.keys(TYPE), 'none']) {
    const f = path.join(dir(), `${host}.${ext}`);
    try {
      const s = await stat(f);
      const age = Date.now() - s.mtimeMs;
      if (ext === 'none') return age < NEG_TTL_MS ? null : undefined;
      if (age > TTL_MS) return undefined;
      return { body: await readFile(f), type: TYPE[ext] };
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function fetchAndStore(host: string): Promise<Favicon | null> {
  await mkdir(dir(), { recursive: true }).catch(() => {});
  // The site itself first (no third party involved), then DuckDuckGo's icon
  // service, which also resolves icons declared via <link rel="icon">.
  const urls = [`https://${host}/favicon.ico`, `https://icons.duckduckgo.com/ip3/${host}.ico`];
  for (const url of urls) {
    const icon = await fetchIcon(url);
    if (icon) {
      await writeFile(path.join(dir(), `${host}.${EXT[icon.type]}`), icon.body).catch(() => {});
      return icon;
    }
  }
  await writeFile(path.join(dir(), `${host}.none`), '').catch(() => {});
  return null;
}

async function fetchIcon(url: string): Promise<Favicon | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    // Following redirects could land on a private host; refuse those.
    const finalHost = new URL(res.url || url).hostname;
    if (isPrivateHost(finalHost)) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) return null;
    const sniffed = sniff(body) ?? (EXT[type] ? type : null);
    if (!sniffed) return null;
    // SVG can carry scripts; only trust it when the server said so and it parses as XML.
    if (sniffed === 'image/svg+xml' && (type !== 'image/svg+xml' || !/^\s*(<\?xml|<svg)/i.test(body.subarray(0, 200).toString()))) return null;
    return { body, type: sniffed };
  } catch {
    return null;
  }
}

function sniff(b: Buffer): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
