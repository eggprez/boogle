import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { config } from '../config.js';

export interface PageText {
  url: string;
  title: string;
  text: string;
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 BoogleOverview/1.0';
const MAX_BYTES = 1.5 * 1024 * 1024;

/**
 * Deep mode: fetch a result page and reduce it to readable article text.
 * Returns null for anything that isn't HTML, times out, or yields nothing
 * useful. Never throws.
 */
export async function fetchReadable(url: string, maxChars = config.deepReadCharsPerPage, hops = 0): Promise<PageText | null> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (isPrivateHost(u.hostname)) return null;
    if (/\.(pdf|zip|gz|tar|exe|dmg|mp4|mp3|png|jpe?g|gif|webp|svg)$/i.test(u.pathname)) return null;

    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/.test(ct)) return null;

    const html = await readCapped(res, MAX_BYTES);

    // Tiny "Redirecting…" pages that bounce via <meta http-equiv="refresh">
    // (rust-lang.org does this). Follow once.
    if (html.length < 4096 && hops < 2) {
      const m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i);
      if (m) return fetchReadable(new URL(m[1], res.url || url).href, maxChars, hops + 1);
    }

    const { document } = parseHTML(html);

    let title = document.querySelector('title')?.textContent?.trim() ?? u.hostname;
    let text = '';
    try {
      const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
      if (article?.content) {
        // textContent glues block elements together ("TitleFirst para"), which
        // hurts the model; derive text from the HTML with block breaks instead.
        text = htmlToText(article.content);
        if (article.title) title = article.title;
      } else if (article?.textContent) {
        text = article.textContent;
        if (article.title) title = article.title;
      }
    } catch {
      /* fall through to crude extraction */
    }
    if (!text.trim()) {
      for (const sel of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'svg', 'iframe'])
        document.querySelectorAll(sel).forEach((el) => el.remove());
      text = document.body?.textContent ?? '';
    }
    text = text.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    if (text.length < 200) return null;
    if (text.length > maxChars) text = text.slice(0, maxChars) + ' […]';
    return { url, title: title.slice(0, 200), text };
  } catch {
    return null;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article|dd|dt|figcaption|table)>|<br\s*\/?>|<hr\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= cap) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

// The overview fetches URLs chosen by search engines, so refuse anything that
// could point back inside the Docker network or the LAN.
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  if (h.startsWith('[') || h.includes(':')) return true; // IPv6 literal: be conservative
  return false;
}
