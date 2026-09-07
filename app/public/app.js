/* Boogle client: autocomplete, search box niceties, streaming AI overview. */
(() => {
  'use strict';

  const SEARCH_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------ search box */
  for (const form of document.querySelectorAll('form.searchbox')) setupSearchBox(form);

  function setupSearchBox(form) {
    const input = form.querySelector('.sb-input');
    const clear = form.querySelector('.sb-clear');
    const list = form.querySelector('.suggest');
    if (!input) return;
    let items = [];
    let active = -1;
    let timer = null;
    let lastQuery = '';
    let ctrl = null;

    const close = () => {
      list.hidden = true;
      form.classList.remove('open');
      active = -1;
    };
    const render = () => {
      if (!items.length) return close();
      const q = input.value.trim().toLowerCase();
      list.innerHTML = items
        .map((s, i) => {
          const idx = s.toLowerCase().indexOf(q);
          const html =
            idx >= 0 && q
              ? esc(s.slice(0, idx)) + '<b>' + esc(s.slice(idx, idx + q.length)) + '</b>' + esc(s.slice(idx + q.length))
              : esc(s);
          return `<li role="option" data-i="${i}" aria-selected="${i === active}">${SEARCH_ICON}<span>${html}</span></li>`;
        })
        .join('');
      list.hidden = false;
      form.classList.add('open');
    };
    const fetchSuggestions = () => {
      const q = input.value.trim();
      if (q.length < 2 || q.startsWith('!') || q === lastQuery) return;
      lastQuery = q;
      ctrl?.abort();
      ctrl = new AbortController();
      fetch('/suggest?q=' + encodeURIComponent(q), { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : [q, []]))
        .then((d) => {
          if (input.value.trim() !== q) return;
          items = Array.isArray(d[1]) ? d[1] : [];
          active = -1;
          render();
        })
        .catch(() => {});
    };

    input.addEventListener('input', () => {
      clear.hidden = !input.value;
      clearTimeout(timer);
      if (input.value.trim().length < 2) {
        items = [];
        close();
        return;
      }
      timer = setTimeout(fetchSuggestions, 140);
    });
    input.addEventListener('keydown', (ev) => {
      if (list.hidden) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        active = ev.key === 'ArrowDown' ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
        input.value = items[active];
        render();
      } else if (ev.key === 'Escape') {
        close();
      } else if (ev.key === 'Enter' && active >= 0) {
        input.value = items[active];
      }
    });
    list.addEventListener('mousedown', (ev) => {
      const li = ev.target.closest('li');
      if (!li) return;
      ev.preventDefault();
      input.value = items[Number(li.dataset.i)];
      form.submit();
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('focus', () => items.length && render());
    clear.addEventListener('click', () => {
      input.value = '';
      clear.hidden = true;
      items = [];
      close();
      input.focus();
    });
    form.addEventListener('submit', (ev) => {
      if (!input.value.trim()) ev.preventDefault();
    });
  }

  // "/" focuses the search box like on GitHub.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) {
      const input = document.querySelector('.sb-input');
      if (input) {
        ev.preventDefault();
        input.focus();
        input.select();
      }
    }
  });

  /* ------------------------------------------------ home: recent searches */
  const RECENT_KEY = 'boogle.recent';
  const readRecent = () => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((s) => typeof s === 'string'); } catch { return []; }
  };
  const pushRecent = (q) => {
    try {
      const list = [q, ...readRecent().filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch { /* storage unavailable */ }
  };
  for (const form of document.querySelectorAll('form.searchbox')) {
    form.addEventListener('submit', () => {
      const q = form.querySelector('.sb-input')?.value.trim();
      if (q && !q.startsWith('!')) pushRecent(q);
    });
  }
  const homeChips = document.getElementById('home-chips');
  if (homeChips) {
    const input = document.querySelector('.sb-input');
    // Category chips search whatever is typed; with an empty box they just focus it.
    homeChips.querySelectorAll('a[data-tab]').forEach((a) => {
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const q = input?.value.trim();
        if (!q) return input?.focus();
        location.href = `/search?tab=${a.dataset.tab}&q=${encodeURIComponent(q)}`;
      });
    });
    const recent = readRecent();
    if (recent.length) {
      const CLOCK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
      const frag = document.createDocumentFragment();
      const sep = document.createElement('span');
      sep.className = 'chip-label';
      sep.textContent = 'Recent';
      frag.appendChild(sep);
      for (const q of recent) {
        const a = document.createElement('a');
        a.className = 'chip recent';
        a.href = '/search?q=' + encodeURIComponent(q);
        a.innerHTML = CLOCK + '<span></span>';
        a.querySelector('span').textContent = q;
        frag.appendChild(a);
      }
      homeChips.appendChild(frag);
    }
  }

  /* --------------------------------------------------------- AI overview */
  const ov = document.getElementById('overview');
  if (ov) setupOverview(ov);

  function setupOverview(root) {
    const body = document.getElementById('ov-body');
    const status = document.getElementById('ov-status');
    const badges = document.getElementById('ov-badges');
    const srcEl = document.getElementById('ov-sources');
    const actions = document.getElementById('ov-actions');
    const note = document.getElementById('ov-note');
    const q = root.dataset.q;
    let mode = root.dataset.mode;
    let es = null;
    let text = '';
    let sources = [];
    let raf = 0;

    const paint = (streaming) => {
      raf = 0;
      body.innerHTML = renderMarkdown(text, sources) + (streaming ? '<span class="cursor"></span>' : '');
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => paint(true));
    };
    const setBadges = (list) => {
      badges.innerHTML = list.map((b) => `<span class="badge${b.muted ? ' muted' : ''}">${esc(b.text)}</span>`).join('');
    };
    const renderSources = () => {
      if (!sources.length) return (srcEl.hidden = true);
      srcEl.innerHTML = sources
        .map(
          (s) =>
            `<a class="src${s.deep ? ' deep' : ''}" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}"><span class="n">${s.n}</span><span class="h">${esc(s.host)}</span></a>`,
        )
        .join('');
      srcEl.hidden = false;
    };

    function start(refresh) {
      es?.close();
      text = '';
      sources = [];
      root.classList.add('busy');
      root.classList.remove('error');
      body.innerHTML = '<div class="ov-skeleton"><span></span><span></span><span></span></div>';
      status.textContent = 'Searching…';
      srcEl.hidden = true;
      actions.hidden = true;
      note.textContent = '';
      setBadges([{ text: mode === 'deep' ? 'Reading pages' : 'Snippets', muted: true }]);

      const url = `/api/overview?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}${refresh ? '&refresh=1' : ''}`;
      es = new EventSource(url);

      es.addEventListener('status', (ev) => {
        const d = JSON.parse(ev.data);
        status.textContent =
          d.stage === 'searching' ? 'Searching…' :
          d.stage === 'reading' ? (d.detail || 'Reading pages…') :
          d.stage === 'writing' ? `Writing with ${cap(d.detail || 'Claude')}…` : '';
      });
      es.addEventListener('sources', (ev) => {
        sources = JSON.parse(ev.data).sources || [];
        renderSources();
      });
      es.addEventListener('delta', (ev) => {
        const d = JSON.parse(ev.data);
        if (!text) body.innerHTML = '';
        text += d.text;
        schedule();
      });
      es.addEventListener('done', (ev) => {
        const d = JSON.parse(ev.data);
        es.close();
        cancelAnimationFrame(raf);
        raf = 0;
        paint(false);
        root.classList.remove('busy');
        status.textContent = '';
        setBadges([
          { text: cap(d.model) },
          { text: d.mode === 'deep' ? 'Read pages' : 'Snippets', muted: true },
          ...(d.cached ? [{ text: 'Cached', muted: true }] : []),
        ]);
        note.textContent = d.cached ? `Cached ${relTime(d.createdAt)}` : 'Just now';
        actions.hidden = false;
        const deepBtn = actions.querySelector('[data-action="deep"]');
        if (deepBtn) deepBtn.hidden = d.mode === 'deep';
      });
      es.addEventListener('error', (ev) => {
        // Both our explicit error events and transport failures land here.
        es.close();
        cancelAnimationFrame(raf);
        raf = 0;
        root.classList.remove('busy');
        root.classList.add('error');
        let message = 'Connection to the overview stream was lost.';
        if (ev.data) {
          try { message = JSON.parse(ev.data).message || message; } catch { /* keep default */ }
        }
        if (text) {
          paint(false);
          note.textContent = 'Stopped early: ' + message;
        } else {
          body.innerHTML = `<div class="ov-error">${esc(message)}</div>`;
        }
        status.textContent = '';
        actions.hidden = false;
      });
    }

    actions.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'refresh') start(true);
      if (btn.dataset.action === 'deep') {
        mode = 'deep';
        start(false);
      }
    });

    window.addEventListener('pagehide', () => es?.close());
    start(false);
  }

  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }
  function relTime(ts) {
    const d = Date.now() - ts;
    const m = Math.round(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  /* ------------------------------------------------ minimal markdown */
  // Deliberately small and escape-first: the overview is model output built
  // from untrusted web text, so nothing here ever emits raw HTML from input.
  function renderMarkdown(md, sources) {
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

    const lines = md.replace(/\r/g, '').split('\n');
    const isBlockStart = (l) => /^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\|)/.test(l);
    let out = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
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
})();
