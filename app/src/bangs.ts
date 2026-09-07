// DuckDuckGo-style bangs. `!yt cats` or `cats !yt` jumps straight to the site.
// Add your own here; keys are matched case-insensitively.
const BANGS: Record<string, { name: string; url: string; home: string }> = {
  yt: { name: 'YouTube', url: 'https://www.youtube.com/results?search_query={q}', home: 'https://www.youtube.com' },
  gh: { name: 'GitHub', url: 'https://github.com/search?q={q}', home: 'https://github.com' },
  w: { name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search={q}', home: 'https://en.wikipedia.org' },
  wiki: { name: 'Wikipedia', url: 'https://en.wikipedia.org/w/index.php?search={q}', home: 'https://en.wikipedia.org' },
  r: { name: 'Reddit', url: 'https://www.reddit.com/search/?q={q}', home: 'https://www.reddit.com' },
  a: { name: 'Amazon', url: 'https://www.amazon.com/s?k={q}', home: 'https://www.amazon.com' },
  g: { name: 'Google', url: 'https://www.google.com/search?q={q}', home: 'https://www.google.com' },
  ddg: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}', home: 'https://duckduckgo.com' },
  so: { name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q={q}', home: 'https://stackoverflow.com' },
  npm: { name: 'npm', url: 'https://www.npmjs.com/search?q={q}', home: 'https://www.npmjs.com' },
  crates: { name: 'crates.io', url: 'https://crates.io/search?q={q}', home: 'https://crates.io' },
  pypi: { name: 'PyPI', url: 'https://pypi.org/search/?q={q}', home: 'https://pypi.org' },
  mdn: { name: 'MDN', url: 'https://developer.mozilla.org/en-US/search?q={q}', home: 'https://developer.mozilla.org' },
  imdb: { name: 'IMDb', url: 'https://www.imdb.com/find/?q={q}', home: 'https://www.imdb.com' },
  maps: { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/search?query={q}', home: 'https://www.openstreetmap.org' },
  gmaps: { name: 'Google Maps', url: 'https://www.google.com/maps/search/{q}', home: 'https://www.google.com/maps' },
  ebay: { name: 'eBay', url: 'https://www.ebay.com/sch/i.html?_nkw={q}', home: 'https://www.ebay.com' },
  aur: { name: 'AUR', url: 'https://aur.archlinux.org/packages?K={q}', home: 'https://aur.archlinux.org' },
  arch: { name: 'Arch Wiki', url: 'https://wiki.archlinux.org/index.php?search={q}', home: 'https://wiki.archlinux.org' },
  hn: { name: 'Hacker News', url: 'https://hn.algolia.com/?q={q}', home: 'https://news.ycombinator.com' },
  dh: { name: 'Docker Hub', url: 'https://hub.docker.com/search?q={q}', home: 'https://hub.docker.com' },
  tw: { name: 'X / Twitter', url: 'https://x.com/search?q={q}', home: 'https://x.com' },
};

export function listBangs(): { bang: string; name: string }[] {
  return Object.entries(BANGS).map(([bang, b]) => ({ bang: '!' + bang, name: b.name }));
}

/** Returns a redirect URL if the query contains a known bang, else null. */
export function resolveBang(query: string): string | null {
  const m = query.match(/(?:^|\s)!([a-z0-9]+)(?=\s|$)/i);
  if (!m) return null;
  const bang = BANGS[m[1].toLowerCase()];
  if (!bang) return null;
  const rest = query.replace(m[0], ' ').trim();
  if (!rest) return bang.home;
  return bang.url.replace('{q}', encodeURIComponent(rest));
}
