import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/markdown.js is a browser script; load it into a bare context.
const src = readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8');
const ctx: { window: { BoogleMarkdown?: { renderMarkdown: (md: string, s?: unknown[]) => string } } } = { window: {} };
createContext(ctx);
runInContext(src, ctx);
const render = ctx.window.BoogleMarkdown!.renderMarkdown;
const sources = [{ n: 1, url: 'https://a.com/', title: 'A <site>' }];

describe('renderMarkdown', () => {
  it('escapes HTML in the input', () => {
    expect(render('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });
  it('turns citations into links to the source and escapes the title', () => {
    const html = render('Fact [1]. Unknown [9].', sources);
    expect(html).toContain('<a class="cite" href="https://a.com/" target="_blank" rel="noopener" title="A &lt;site&gt;">1</a>');
    expect(html).toContain('<span class="cite">9</span>');
  });
  it('handles multi-citations', () => {
    expect(render('x [1, 1]', sources).match(/class="cite"/g)).toHaveLength(2);
  });
  it('renders lists, headings, bold, code', () => {
    const html = render('### Head\n- **a**\n- `b`\n1. c');
    expect(html).toBe('<h5>Head</h5><ul><li><strong>a</strong></li><li><code>b</code></li></ul><ol><li>c</li></ol>');
  });
  it('only links http(s) markdown links', () => {
    expect(render('[x](javascript:alert(1))')).not.toContain('<a');
    expect(render('[x](https://b.com)')).toContain('href="https://b.com"');
  });
  it('renders tables and skips the separator row', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toBe('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  });
  it('hides a related block, even one still streaming', () => {
    expect(render('Text.\n\n```related\nfoo\nbar\n```')).toBe('<p>Text.</p>');
    expect(render('Text.\n\n```related\nfo')).toBe('<p>Text.</p>');
    expect(render('```js\nx\n```')).toBe('<pre><code>x</code></pre>');
  });
});
