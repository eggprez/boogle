#!/usr/bin/env node
// Stand-in for the Claude Code CLI: speaks just enough of
// `claude -p --output-format stream-json --include-partial-messages` for the
// overview pipeline to be exercised without a login or quota.
// Use with CLAUDE_BIN=/path/to/test/fake-claude.mjs
import { stdin, stdout, argv } from 'node:process';

if (argv.includes('--version')) { stdout.write('9.9.9 (fake)\n'); process.exit(0); }

let input = '';
stdin.setEncoding('utf8');
stdin.on('data', (d) => (input += d));
stdin.on('end', async () => {
  // `--output-format json` is the one-shot path (overview/ask.ts): today the
  // place classifier. Well-known cities and landmarks are places, the rest not.
  if (argv[argv.indexOf('--output-format') + 1] === 'json') {
    const query = (input.match(/Query: "(.*)"/)?.[1] ?? '').trim();
    const no = { place: false, mode: 'one', name: '', kind: 'other', what: '', area: '', category: null, filters: [] };
    const kinds = { pizza: ['Pizza places', '["amenity"="restaurant"]["cuisine"~"pizza"]'], coffee: ['Coffee shops', '["amenity"="cafe"]'], 'dog parks': ['Dog parks', '["leisure"="dog_park"]'] };
    const kind = Object.keys(kinds).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(query));
    let result;
    if (/^(lisbon|paris|denver|eiffel tower|kyoto)$/i.test(query)) {
      result = { ...no, place: true, name: query.replace(/\b\w/g, (c) => c.toUpperCase()), kind: /tower/i.test(query) ? 'landmark' : 'city' };
    } else if (/opossumtown/i.test(query)) {
      result = { ...no, place: true, name: 'Opossumtown Pike Vet Hospital, Frederick, Maryland', kind: 'business' };
    } else if (kind) {
      const area = query.match(/\b(?:in|around)\s+(.+)$/i)?.[1] ?? '';
      result = { ...no, place: true, mode: 'list', kind: '', what: kinds[kind][0], area, filters: [kinds[kind][1]] };
    } else result = no;
    result = JSON.stringify(result);
    stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.0001, duration_ms: 50 }) + '\n');
    return;
  }
  const followup = input.match(/Follow-up question: (.*)/);
  const query = input.match(/Search query: "(.*)"/)?.[1] ?? 'your query';
  const nSources = (input.match(/^\[\d+\] /gm) || []).length;
  const text = followup
    ? `Regarding "${followup[1]}": the sources say this is covered in [1] and [2]. **Short answer**: yes, with caveats [${Math.max(1, nSources)}].`
    : `**${query}** is a stub answer written by the fake Claude CLI [1]. It cites a couple of sources so the citation links can be checked [2][3].\n\n- First point from the snippets [1]\n- Second point, with a *nuance* [2]\n\n\`\`\`related\n${query} explained\n${query} vs alternatives\nhow to get started with ${query}\n\`\`\`\n`;
  const emit = (o) => stdout.write(JSON.stringify(o) + '\n');
  emit({ type: 'system', subtype: 'init' });
  const words = text.split(/(?<=\s)/);
  for (const w of words) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: w } } });
    await new Promise((r) => setTimeout(r, 25));
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001, duration_ms: words.length * 25 });
});
