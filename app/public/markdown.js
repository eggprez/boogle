/* Boogle minimal markdown renderer for the AI overview.
 * Deliberately small and escape-first: the overview is model output built
 * from untrusted web text, so nothing here ever emits raw HTML from input.
 * Exposed as window.BoogleMarkdown so it can be unit-tested in Node too. */
(function (root) {
  'use strict';

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * @param {string} md
   * @param {{n:number,url:string,title:string}[]} sources  citation targets; [3] links to sources[2]
   * @returns {string} HTML
   */
  function renderMarkdown(md, sources) {
    sources = sources || [];
    const inline = (s) => {
      s = esc(s);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
      s = s.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, nums) =>
        nums
          .split(',')
          .map((n) => n.trim())
          .map((n) => {
            const src = sources[Number(n) - 1];
            return src
              ? `<a class="cite" href="${esc(src.url)}" target="_blank" rel="noopener" title="${esc(src.title)}">${n}</a>`
              : `<span class="cite">${esc(n)}</span>`;
          })
          .join(''),
      );
      return s;
    };

    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const isBlockStart = (l) => /^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\|)/.test(l);
    let out = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      if (/^```/.test(line)) {
        // ```related blocks carry suggested searches, shown as chips by the
        // caller, never as text. That includes an unterminated one still streaming.
        const hidden = /^```\s*related\b/i.test(line);
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        if (!hidden) out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = Math.min(h[1].length + 2, 5);
        out += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
        i++;
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
        out += `<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`;
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out += `<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`;
        continue;
      }
      if (/^\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const bodyRows = rows.filter((r) => !/^\|\s*:?-{2,}/.test(r));
        if (bodyRows.length) {
          const [head, ...rest] = bodyRows;
          out += `<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest
            .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`;
        }
        continue;
      }
      const buf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) buf.push(lines[i++]);
      out += `<p>${inline(buf.join(' '))}</p>`;
    }
    return out;
  }

  root.BoogleMarkdown = { renderMarkdown, esc };
})(typeof window !== 'undefined' ? window : globalThis);
