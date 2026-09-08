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
    if (u.searchParams.get('time_range')) return json({ query: q, results: [result(1)], suggestions: [], answers: [], infoboxes: [], corrections: [], unresponsive_engines: [] });
    const results =
      cat === 'images' ? [1, 2, 3].map((i) => result(i, { img_src: `https://example${i}.com/full.jpg`, thumbnail_src: `https://example${i}.com/t.jpg`, resolution: '800x600' })) :
      cat === 'videos' ? [1, 2].map((i) => result(i, { thumbnail: `https://example${i}.com/t.jpg`, iframe_src: `https://www.youtube-nocookie.com/embed/x${i}`, length: '3:21' })) :
      [1, 2, 3, 4, 5].map((i) => result(i));
    return json({ query: q, number_of_results: results.length, results, suggestions: ['stub related'], answers: [], infoboxes: [], corrections: [], unresponsive_engines: [['slowengine', 'timeout']] });
  }
  res.writeHead(404); res.end();
}).listen(port, '0.0.0.0', () => console.log(`stub searxng on :${port}`));
