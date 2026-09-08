// Minimal stand-in for SearXNG so the app can be smoke-tested without the
// real thing (CI, or `node test/stub-searxng.mjs` locally on port 9999).
import { createServer } from 'node:http';

const port = Number(process.env.PORT || 9999);
const result = (i, extra = {}) => ({
  url: `https://example${i}.com/page-${i}`,
  title: `Example result ${i}`,
  content: `Snippet for result ${i} about the query.`,
  engines: i % 2 ? ['google', 'brave'] : ['bing'],
  ...extra,
});

createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/healthz') return res.end('OK');
  if (u.pathname === '/autocompleter') return json([u.searchParams.get('q'), ['stub one', 'stub two']]);
  if (u.pathname === '/search') {
    const cat = u.searchParams.get('categories');
    const q = u.searchParams.get('q');
    // News: a query mentioning "news" has fresh, on-topic coverage (so the
    // "Top stories" strip appears on the web tab); anything else gets one
    // stale story, which the strip's freshness gate must reject.
    if (cat === 'news') {
      const hours = (h) => new Date(Date.now() - h * 3600e3).toISOString();
      const stories = /news/i.test(q)
        ? [3, 9, 30, 50].map((h, i) => result(i + 1, { title: `Story ${i + 1}: ${q} today`, publishedDate: hours(h), thumbnail: `https://example${i + 1}.com/t.jpg` }))
        : [result(1, { title: `Old story about ${q}`, publishedDate: hours(24 * 30) })];
      return json({ query: q, results: stories, suggestions: [], answers: [], infoboxes: [], corrections: [], unresponsive_engines: [] });
    }
    if (u.searchParams.get('time_range')) return json({ query: q, results: [result(1)], suggestions: [], answers: [], infoboxes: [], corrections: [], unresponsive_engines: [] });
    const results =
      cat === 'images' ? [1, 2, 3].map((i) => result(i, { img_src: `https://example${i}.com/full.jpg`, thumbnail_src: `https://example${i}.com/t.jpg`, resolution: '800x600' })) :
      cat === 'videos' ? [1, 2].map((i) => result(i, { thumbnail: `https://example${i}.com/t.jpg`, iframe_src: `https://www.youtube-nocookie.com/embed/x${i}`, length: '3:21' })) :
      [1, 2, 3, 4, 5].map((i) => result(i, i === 2 ? { thumbnail: `https://example${i}.com/thumb.jpg` } : {}));
    // A query mentioning "infobox" gets a knowledge panel, to check the
    // sidebar layout and that the AI overview steps aside for it.
    // With "place" in the query the infobox also carries the OpenStreetMap
    // link Wikidata supplies for a place, which puts a map in the panel.
    const infoboxes = /infobox/i.test(q)
      ? [{ infobox: 'Stub Topic', id: 'https://en.wikipedia.org/wiki/Stub', content: 'A stub topic that exists so the infobox layout can be checked without SearXNG.', img_src: null, urls: [{ title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Stub' }, ...(/place/i.test(q) ? [{ title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/?lat=38.7077&lon=-9.1366&zoom=11&layers=M' }] : [])], attributes: [{ label: 'Type', value: 'Test fixture' }, { label: 'Since', value: '2026' }] }]
      : [];
    return json({ query: q, number_of_results: results.length, results, suggestions: ['stub related'], answers: [], infoboxes, corrections: [], unresponsive_engines: [['slowengine', 'timeout']] });
  }
  res.writeHead(404); res.end();
}).listen(port, '0.0.0.0', () => console.log(`stub searxng on :${port}`));
