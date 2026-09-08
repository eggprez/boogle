import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/**
 * knowledge: Claude answers from what it knows; the results only supply citations.
 * snippets:  Claude summarizes the titles + snippets of the top results.
 * deep:      the top pages are fetched and Claude reads their text.
 */
export type OverviewMode = 'knowledge' | 'snippets' | 'deep';
export const OVERVIEW_MODES: OverviewMode[] = ['knowledge', 'snippets', 'deep'];
export function parseMode(v: unknown, fallback: OverviewMode): OverviewMode {
  return OVERVIEW_MODES.includes(v as OverviewMode) ? (v as OverviewMode) : fallback;
}
export type Model = 'haiku' | 'sonnet' | 'opus';
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  overviewEnabled: boolean;
  overviewMode: OverviewMode;
  model: Model;
  theme: Theme;
  safesearch: 0 | 1 | 2;
  language: string; // SearXNG language code, e.g. 'auto', 'en-US', 'all'
  openInNewTab: boolean;
  topStories: boolean; // "Top stories" strip on the web tab when the query is in the news
  places: boolean; // maps and attractions from OpenStreetMap
}

export const DEFAULT_SETTINGS: Settings = {
  overviewEnabled: true,
  overviewMode: 'knowledge',
  model: 'sonnet',
  theme: 'system',
  safesearch: 0,
  language: 'auto',
  openInNewTab: false,
  topStories: true,
  places: true,
};

export const MODELS: { id: Model; label: string; blurb: string }[] = [
  { id: 'haiku', label: 'Haiku', blurb: 'Fastest and lightest on quota. Fine for simple lookups.' },
  { id: 'sonnet', label: 'Sonnet', blurb: 'Best balance of speed and quality. Recommended.' },
  { id: 'opus', label: 'Opus', blurb: 'Highest quality, slowest, heaviest on quota.' },
];

function fileFor(user: string): string {
  const safe = user.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 120) || 'user';
  return path.join(config.dataDir, 'settings', `${safe}.json`);
}

export async function loadSettings(user: string): Promise<Settings> {
  try {
    const raw = await readFile(fileFor(user), 'utf8');
    return sanitize({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(user: string, s: Settings): Promise<void> {
  const f = fileFor(user);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(sanitize(s), null, 2));
}

export function sanitize(input: Partial<Record<keyof Settings, unknown>>): Settings {
  const s = { ...DEFAULT_SETTINGS };
  s.overviewEnabled = toBool(input.overviewEnabled, s.overviewEnabled);
  s.openInNewTab = toBool(input.openInNewTab, s.openInNewTab);
  s.topStories = toBool(input.topStories, s.topStories);
  s.places = toBool(input.places, s.places);
  s.overviewMode = parseMode(input.overviewMode, s.overviewMode);
  if (MODELS.some((m) => m.id === input.model)) s.model = input.model as Model;
  if (input.theme === 'system' || input.theme === 'light' || input.theme === 'dark') s.theme = input.theme;
  const ss = Number(input.safesearch);
  if (ss === 0 || ss === 1 || ss === 2) s.safesearch = ss;
  if (typeof input.language === 'string' && /^[a-zA-Z-]{2,10}$/.test(input.language)) s.language = input.language;
  return s;
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  return v === 'on' || v === 'true' || v === '1';
}
