/* Boogle client: autocomplete, search box niceties, streaming AI overview,
 * follow-up questions, keyboard navigation, image lightbox, inline video. */
(() => {
  'use strict';

  const { renderMarkdown, esc } = window.BoogleMarkdown;

  const SEARCH_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const SPARK_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2c.4 3.9 2.1 6.6 6 7-3.9.4-5.6 3.1-6 7-.4-3.9-2.1-6.6-6-7 3.9-.4 5.6-3.1 6-7z"/></svg>';
  const CLOSE_ICON =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const CHEV = (dir) =>
    `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${dir < 0 ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}"/></svg>`;

  const inField = () => /input|textarea|select/i.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;

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

  /* ------------------------------------------------------- SSE over fetch */
  // EventSource only does GET; follow-ups POST a JSON body, so parse the
  // stream by hand. Yields {event, data} objects.
  async function* sseFetch(url, init, signal) {
    const res = await fetch(url, { ...init, signal });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* keep */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const data = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  }

  /* --------------------------------------------------------- AI overview */
  const ov = document.getElementById('overview');
  if (ov) setupOverview(ov);

  const engineInfo = document.querySelector('.engine-info');
  if (engineInfo) {
    document.addEventListener('click', (ev) => { if (!engineInfo.contains(ev.target)) engineInfo.open = false; });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') engineInfo.open = false; });
  }

  function setupOverview(root) {
    const body = document.getElementById('ov-body');
    const status = document.getElementById('ov-status');
    const badges = document.getElementById('ov-badges');
    const srcEl = document.getElementById('ov-sources');
    const actions = document.getElementById('ov-actions');
    const note = document.getElementById('ov-note');
    const relatedEl = document.getElementById('ov-related');
    const followupsEl = document.getElementById('ov-followups');
    const askForm = document.getElementById('ov-ask');
    const askInput = askForm.querySelector('.ov-ask-input');
    const q = root.dataset.q;
    const t = root.dataset.t || '';
    let mode = root.dataset.mode;
    let es = null;
    let text = '';
    let sources = [];
    let raf = 0;
    let retried = false;
    let ready = false;
    const history = []; // follow-up turns, sent back as context for the next one
    const modeLabel = (m, busy) => (m === 'deep' ? (busy ? 'Reading pages' : 'Read pages') : m === 'knowledge' ? "Claude's knowledge" : 'Snippets');

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
    // Sources render twice: a collapsed one-liner under the text (what narrow
    // screens see) and detailed cards in the right column (wide screens).
    // CSS shows one or the other, never both.
    const sideEl = document.getElementById('ov-side');
    const citesEl = document.getElementById('ov-cites');
    const citesCount = document.getElementById('ov-cites-count');
    // The panel sits beside the overview and matches its height; when the
    // list is longer than that, an arrow at the bottom unfolds it.
    const panel = sideEl?.querySelector('.ov-panel');
    const moreBtn = document.getElementById('ov-more');
    const fitPanel = () => {
      if (!panel || sideEl.hidden) return;
      const ov = root.getBoundingClientRect();
      // Where the aside would start with no margin (a place panel may sit above it).
      const naturalTop = sideEl.getBoundingClientRect().top - (parseFloat(sideEl.style.marginTop) || 0);
      sideEl.style.marginTop = `${Math.max(0, Math.round(ov.top - naturalTop))}px`;
      panel.style.setProperty('--ov-h', `${Math.round(ov.height)}px`);
      panel.classList.toggle('clipped', !panel.classList.contains('open') && panel.scrollHeight > panel.clientHeight + 1);
    };
    document.addEventListener('boogle:place-panel', () => {
      es?.close();
      root.remove();
      sideEl?.remove();
    });
    if (panel) {
      new ResizeObserver(fitPanel).observe(root);
      window.addEventListener('resize', fitPanel);
      moreBtn?.addEventListener('click', () => {
        panel.classList.toggle('open');
        moreBtn.setAttribute('aria-label', panel.classList.contains('open') ? 'Show fewer sources' : 'Show all sources');
        fitPanel();
      });
    }
    const renderSources = () => {
      if (!sources.length) {
        srcEl.hidden = true;
        if (sideEl) sideEl.hidden = true;
        return;
      }
      const chips = sources
        .map(
          (s) =>
            `<a class="src${s.deep ? ' deep' : ''}" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}"><span class="n">${s.n}</span><span class="h">${esc(s.host)}</span></a>`,
        )
        .join('');
      srcEl.innerHTML = `<details><summary>${sources.length} source${sources.length === 1 ? '' : 's'}</summary><div class="src-list">${chips}</div></details>`;
      srcEl.hidden = false;
      if (!sideEl || !citesEl) return;
      citesEl.innerHTML = sources
        .map(
          (s) =>
            `<a class="cite-card${s.deep ? ' deep' : ''}" data-n="${s.n}" href="${esc(s.url)}" target="_blank" rel="noopener">` +
            `<span class="n">${s.n}</span>` +
            `<span class="cc-body">` +
            `<span class="cc-title"></span>` +
            `<span class="cc-meta"><img class="cc-fav" src="/favicon?host=${encodeURIComponent(s.host)}" alt="" loading="lazy" onerror="this.remove()"><span class="cc-host"></span>${s.deep ? '<span class="cc-tag">Read in full</span>' : ''}<span class="cc-uses"></span></span>` +
            (s.excerpt ? `<span class="cc-excerpt"></span>` : '') +
            `</span></a>`,
        )
        .join('');
      // Text goes in via textContent so nothing from the web is parsed as HTML.
      citesEl.querySelectorAll('.cite-card').forEach((card, i) => {
        card.querySelector('.cc-title').textContent = sources[i].title || sources[i].host;
        card.querySelector('.cc-host').textContent = sources[i].host;
        const ex = card.querySelector('.cc-excerpt');
        if (ex) ex.textContent = sources[i].excerpt;
      });
      citesCount.textContent = sources.length;
      sideEl.hidden = false;
      markUses();
      requestAnimationFrame(fitPanel);
    };
    // How many times each source is cited in the overview so far.
    const markUses = () => {
      if (!citesEl) return;
      const counts = new Map();
      for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
        for (const n of m[1].split(',')) counts.set(n.trim(), (counts.get(n.trim()) || 0) + 1);
      }
      citesEl.querySelectorAll('.cite-card').forEach((card) => {
        const c = counts.get(card.dataset.n) || 0;
        card.classList.toggle('unused', c === 0);
        card.querySelector('.cc-uses').textContent = c ? `cited ×${c}` : '';
      });
    };
    // Hovering a footnote number lights up its card, and vice versa.
    const hot = (n, on) => {
      citesEl?.querySelectorAll(`.cite-card[data-n="${n}"]`).forEach((el) => el.classList.toggle('hot', on));
      root.querySelectorAll('.cite').forEach((el) => el.classList.toggle('hot', on && el.textContent.trim() === n));
    };
    root.addEventListener('mouseover', (e) => { const c = e.target.closest('.cite'); if (c) hot(c.textContent.trim(), true); });
    root.addEventListener('mouseout', (e) => { const c = e.target.closest('.cite'); if (c) hot(c.textContent.trim(), false); });
    citesEl?.addEventListener('mouseover', (e) => { const c = e.target.closest('.cite-card'); if (c) hot(c.dataset.n, true); });
    citesEl?.addEventListener('mouseout', (e) => { const c = e.target.closest('.cite-card'); if (c) hot(c.dataset.n, false); });
    const renderRelated = (list) => {
      if (!list || !list.length) return (relatedEl.hidden = true);
      relatedEl.innerHTML =
        `<span class="ov-related-label">${SPARK_ICON} Search next</span>` +
        list.map((s) => `<a class="chip" href="/search?q=${encodeURIComponent(s)}&tab=web">${SEARCH_ICON}<span></span></a>`).join('');
      relatedEl.querySelectorAll('.chip span').forEach((el, i) => (el.textContent = list[i]));
      relatedEl.hidden = false;
    };

    function start(refresh) {
      es?.close();
      text = '';
      sources = [];
      ready = false;
      root.classList.add('busy');
      root.classList.remove('error');
      body.innerHTML = '<div class="ov-skeleton"><span></span><span></span><span></span></div>';
      status.textContent = 'Searching…';
      srcEl.hidden = true;
      if (sideEl) sideEl.hidden = true;
      actions.hidden = true;
      relatedEl.hidden = true;
      askForm.hidden = true;
      followupsEl.innerHTML = '';
      history.length = 0;
      note.textContent = '';
      setBadges([{ text: modeLabel(mode, true), muted: true }]);

      const url = `/api/overview?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}${t ? `&t=${t}` : ''}${refresh ? '&refresh=1' : ''}`;
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
        markUses();
        root.classList.remove('busy');
        status.textContent = '';
        setBadges([
          { text: cap(d.model) },
          { text: modeLabel(d.mode, false), muted: true },
          ...(d.cached ? [{ text: 'Cached', muted: true }] : []),
        ]);
        note.textContent = d.cached ? `Cached ${relTime(d.createdAt)}` : 'Just now';
        actions.hidden = false;
        renderRelated(d.related);
        askForm.hidden = false;
        ready = true;
        const deepBtn = actions.querySelector('[data-action="deep"]');
        if (deepBtn) deepBtn.hidden = d.mode === 'deep';
      });
      es.addEventListener('error', (ev) => {
        // Both our explicit error events and transport failures land here.
        es.close();
        cancelAnimationFrame(raf);
        raf = 0;
        const transport = !ev.data;
        // A dropped connection (proxy hiccup, sleeping laptop) gets one
        // automatic retry; the server either has the overview cached by now
        // or regenerates it.
        if (transport && !retried) {
          retried = true;
          status.textContent = 'Reconnecting…';
          setTimeout(() => start(false), 1500);
          return;
        }
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
      retried = false;
      if (btn.dataset.action === 'refresh') start(true);
      if (btn.dataset.action === 'deep') {
        mode = 'deep';
        start(false);
      }
    });

    /* follow-up questions */
    let asking = false;
    askForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const question = askInput.value.trim();
      if (!question || asking || !ready) return;
      asking = true;
      askInput.value = '';
      askForm.classList.add('busy');

      const block = document.createElement('div');
      block.className = 'ov-fu busy';
      block.innerHTML = `<div class="ov-fu-q">${SPARK_ICON}<span></span></div><div class="ov-fu-a"><div class="ov-skeleton"><span></span><span></span></div></div>`;
      block.querySelector('.ov-fu-q span').textContent = question;
      followupsEl.appendChild(block);
      const answerEl = block.querySelector('.ov-fu-a');
      block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

      let answer = '';
      let fuRaf = 0;
      const paintFu = (streaming) => {
        fuRaf = 0;
        answerEl.innerHTML = renderMarkdown(answer, sources) + (streaming ? '<span class="cursor"></span>' : '');
      };
      const ac = new AbortController();
      const stop = () => ac.abort();
      window.addEventListener('pagehide', stop, { once: true });
      try {
        const init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, question, mode, t, history: history.slice(-3) }),
        };
        for await (const { event, data } of sseFetch('/api/followup', init, ac.signal)) {
          const d = JSON.parse(data);
          if (event === 'delta') {
            answer += d.text;
            if (!fuRaf) fuRaf = requestAnimationFrame(() => paintFu(true));
          } else if (event === 'error') {
            throw new Error(d.message || 'Follow-up failed.');
          } else if (event === 'done') {
            cancelAnimationFrame(fuRaf);
            paintFu(false);
            history.push({ question, answer });
          }
        }
        if (!answer) throw new Error('No answer was produced.');
      } catch (err) {
        cancelAnimationFrame(fuRaf);
        if (answer) paintFu(false);
        else answerEl.innerHTML = `<div class="ov-error">${esc(err.message || 'Follow-up failed.')}</div>`;
        block.classList.add('error');
      } finally {
        block.classList.remove('busy');
        askForm.classList.remove('busy');
        asking = false;
        window.removeEventListener('pagehide', stop);
        askInput.focus();
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

  /* ------------------------------------------------------ image lightbox */
  const imgGrid = document.querySelector('.img-grid');
  const lightbox = imgGrid ? setupLightbox(imgGrid) : null;

  function setupLightbox(grid) {
    const cards = () => Array.from(grid.querySelectorAll('.img-card'));
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Image preview');
    box.innerHTML = `
      <button type="button" class="lb-btn lb-close" aria-label="Close">${CLOSE_ICON}</button>
      <button type="button" class="lb-btn lb-prev" aria-label="Previous image">${CHEV(-1)}</button>
      <button type="button" class="lb-btn lb-next" aria-label="Next image">${CHEV(1)}</button>
      <figure class="lb-fig">
        <div class="lb-stage"><img class="lb-img" alt=""><span class="lb-spinner"></span></div>
        <figcaption class="lb-cap">
          <span class="lb-title"></span>
          <span class="lb-meta"></span>
          <span class="lb-links"><a class="lb-visit" target="_blank" rel="noopener">Visit page</a><a class="lb-open" target="_blank" rel="noopener">Open image</a></span>
        </figcaption>
      </figure>`;
    document.body.appendChild(box);
    const img = box.querySelector('.lb-img');
    const stage = box.querySelector('.lb-stage');
    let index = -1;
    let lastFocus = null;

    const show = (i) => {
      const list = cards();
      if (!list.length) return;
      index = (i + list.length) % list.length;
      const a = list[index];
      const thumb = a.querySelector('img')?.currentSrc || a.querySelector('img')?.src || '';
      const full = a.dataset.full && a.dataset.full !== '#' ? a.dataset.full : thumb;
      stage.classList.add('loading');
      img.onerror = () => { if (img.src !== thumb) img.src = thumb; else stage.classList.remove('loading'); };
      img.onload = () => stage.classList.remove('loading');
      img.src = full;
      img.alt = a.dataset.title || '';
      box.querySelector('.lb-title').textContent = a.dataset.title || '';
      box.querySelector('.lb-meta').textContent = [a.dataset.host, a.dataset.res].filter(Boolean).join(' · ');
      box.querySelector('.lb-visit').href = a.href;
      box.querySelector('.lb-open').href = full;
      list.forEach((c, j) => c.classList.toggle('kb-active', j === index));
      a.scrollIntoView({ block: 'nearest' });
      // Warm the neighbours so arrow keys feel instant.
      for (const j of [index + 1, index - 1]) {
        const n = list[(j + list.length) % list.length];
        if (n?.dataset.full && n.dataset.full !== '#') new Image().src = n.dataset.full;
      }
    };
    const open = (i) => {
      lastFocus = document.activeElement;
      box.hidden = false;
      document.body.classList.add('lb-open');
      show(i);
      box.querySelector('.lb-close').focus();
    };
    const close = () => {
      box.hidden = true;
      img.src = '';
      document.body.classList.remove('lb-open');
      lastFocus?.focus?.();
    };

    grid.addEventListener('click', (ev) => {
      const a = ev.target.closest('.img-card');
      if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      ev.preventDefault();
      open(cards().indexOf(a));
    });
    box.querySelector('.lb-close').addEventListener('click', close);
    box.querySelector('.lb-prev').addEventListener('click', () => show(index - 1));
    box.querySelector('.lb-next').addEventListener('click', () => show(index + 1));
    box.addEventListener('click', (ev) => { if (ev.target === box || ev.target === stage) close(); });
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'k') { ev.preventDefault(); show(index - 1); }
      else if (ev.key === 'ArrowRight' || ev.key === 'j') { ev.preventDefault(); show(index + 1); }
    });
    return { open, close, isOpen: () => !box.hidden, index: () => index };
  }

  /* ---------------------------------------------------- inline video play */
  for (const card of document.querySelectorAll('.result.video[data-embed]')) {
    const thumb = card.querySelector('.video-thumb');
    thumb?.addEventListener('click', (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
      ev.preventDefault();
      playInline(card);
    });
  }
  function playInline(card) {
    if (card.classList.contains('playing')) return;
    // Only one player at a time.
    document.querySelectorAll('.result.video.playing').forEach((c) => stopInline(c));
    const thumb = card.querySelector('.video-thumb');
    let src = card.dataset.embed;
    try {
      const u = new URL(src);
      if (!u.searchParams.has('autoplay')) u.searchParams.set('autoplay', '1');
      src = u.href;
    } catch { return; }
    const wrap = document.createElement('div');
    wrap.className = 'video-player';
    wrap.innerHTML = `<iframe src="${esc(src)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="no-referrer" title="Video player"></iframe><button type="button" class="video-stop" aria-label="Close player">${CLOSE_ICON}</button>`;
    wrap.querySelector('.video-stop').addEventListener('click', () => stopInline(card));
    thumb.hidden = true;
    thumb.insertAdjacentElement('afterend', wrap);
    card.classList.add('playing');
  }
  function stopInline(card) {
    card.querySelector('.video-player')?.remove();
    const thumb = card.querySelector('.video-thumb');
    if (thumb) thumb.hidden = false;
    card.classList.remove('playing');
  }

  /* --------------------------------------------------------------- places */
  // The results page leaves an empty #places slot for a place query; the card
  // itself comes from /api/places once the page is up, so a slow map service
  // never delays the results. Hovering a card lights its pin and vice versa.
  // Without a slot the page still asks (a Claude classifier on the server
  // decides), and a card that comes back is placed by its data-place: a list
  // of places at the top of the main column, one place as a panel in the
  // right column, where a knowledge panel would sit.
  // The browser's position is used first when it can share one (a secure
  // page, permission granted); the server falls back to the home location
  // from Settings. A fresh fix is kept for twenty minutes per device.
  const GEO_KEY = 'boogle.geo';
  const GEO_DENIED = 'boogle.geo.denied';
  const storedGeo = () => {
    try {
      const g = JSON.parse(localStorage.getItem(GEO_KEY) || 'null');
      return g && Number.isFinite(g.lat) && Number.isFinite(g.lon) ? g : null;
    } catch { return null; }
  };
  const storeGeo = (pos) => {
    try {
      localStorage.setItem(GEO_KEY, JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude, at: Date.now() }));
      localStorage.removeItem(GEO_DENIED);
    } catch { /* private mode */ }
  };
  function browserGeo({ ask = true, timeout = 4000 } = {}) {
    const g = storedGeo();
    if (g && Date.now() - g.at < 20 * 60e3) return Promise.resolve(g);
    let denied = false;
    try { denied = localStorage.getItem(GEO_DENIED) === '1'; } catch { /* */ }
    if (!ask || !navigator.geolocation || !window.isSecureContext || denied) return Promise.resolve(g);
    return new Promise((resolve) => {
      // Chrome's own timeout only starts once permission is granted, so an
      // unanswered prompt would stall the card forever: a hard timer moves on
      // with the fallback, and a fix that arrives later is kept for next time.
      let done = false;
      const settle = (v) => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => settle(g), timeout);
      navigator.geolocation.getCurrentPosition(
        (pos) => { storeGeo(pos); settle(storedGeo()); },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) { try { localStorage.setItem(GEO_DENIED, '1'); } catch { /* */ } }
          settle(g);
        },
        { timeout, maximumAge: 10 * 60e3, enableHighAccuracy: false },
      );
    });
  }
  // (after the helpers above: the calls run at once, and const bindings
  // declared later in this block would not be initialised yet)
  const placesSlot = document.getElementById('places');
  const resultsLayout = document.querySelector('.results-layout');
  if (placesSlot && placesSlot.dataset.q !== undefined && !placesSlot.dataset.loaded) loadPlaces(placesSlot);
  else if (placesSlot) wirePins(placesSlot);
  else if (resultsLayout?.dataset.places === '1') loadPlaces(null);
  async function loadPlaces(slot, retry) {
    const q = slot ? slot.dataset.q : resultsLayout.dataset.q;
    const params = new URLSearchParams({ q });
    const t = new URLSearchParams(location.search).get('t');
    if (t) params.set('t', t);
    const geo = await browserGeo();
    if (geo) { params.set('lat', geo.lat.toFixed(4)); params.set('lon', geo.lon.toFixed(4)); }
    if (retry) params.set('retry', '1');
    if (resultsLayout?.dataset.infobox === '1') params.set('infobox', '1');
    try {
      const res = await fetch('/api/places?' + params, { headers: { Accept: 'text/html' } });
      if (res.status !== 200) return slot?.remove();
      const tpl = document.createElement('template');
      tpl.innerHTML = await res.text();
      const card = tpl.content.firstElementChild;
      if (!card) return slot?.remove();
      if (card.dataset.place === 'side') {
        if (slot?.closest('.place-side')) slot.replaceWith(card);
        else {
          slot?.remove();
          mountSide(card);
        }
        // The map panel answers a place query; an overview that got started
        // because the verdict came late goes away, sources panel included.
        document.dispatchEvent(new Event('boogle:place-panel'));
      } else if (slot) slot.replaceWith(card);
      else {
        const main = resultsLayout.querySelector('.main-col');
        const before = main.querySelector('#overview, .stories, .answer.long, .result, .notice');
        main.insertBefore(card, before);
      }
      wirePins(card);
    } catch {
      slot?.remove();
    }
  }
  function mountSide(card) {
    if (!resultsLayout) return;
    const aside = document.createElement('aside');
    aside.className = 'side-col place-side';
    aside.appendChild(card);
    // The right column is one stack: above the overview's sources panel
    // when there is one (it re-fits itself).
    let stack = resultsLayout.querySelector('.side-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'side-stack';
      resultsLayout.appendChild(stack);
    }
    stack.insertBefore(aside, document.getElementById('ov-side'));
    window.dispatchEvent(new Event('resize'));
  }
  // Map tiles: the tile server refuses a burst now and then; a tile that
  // failed is asked for again, twice, with a pause, instead of staying blank.
  document.addEventListener('error', (ev) => {
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || !img.closest('.map-layer')) return;
    const n = Number(img.dataset.retry || 0);
    if (n >= 2) return;
    img.dataset.retry = String(n + 1);
    const src = img.src.replace(/[?&]r=\d+$/, '');
    setTimeout(() => { img.src = `${src}${src.includes('?') ? '&' : '?'}r=${n + 1}`; }, 1500 * (n + 1));
  }, true);
  // Copy buttons (the address) and today's line of an hours table.
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.copy-btn');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.classList.add('done');
      btn.title = 'Copied';
      setTimeout(() => { btn.classList.remove('done'); btn.title = 'Copy'; }, 1500);
    } catch { /* no clipboard (plain http): the text is selectable */ }
  });
  function markToday(root) {
    const today = (new Date().getDay() + 6) % 7; // Monday = 0
    for (const tr of root.querySelectorAll('.hours tr[data-days]')) {
      if (tr.dataset.days.split(',').map(Number).includes(today)) {
        tr.classList.add('today');
        const sum = tr.closest('.hours')?.querySelector('[data-today-hours]');
        if (sum && !sum.textContent) sum.textContent = `Today ${tr.lastElementChild.textContent}`;
      }
    }
    for (const card of root.querySelectorAll('.place-card[data-hours]')) {
      try {
        const text = JSON.parse(card.dataset.hours)[today];
        const el = card.querySelector('[data-today-hours] span');
        if (el && text) el.textContent = /^closed$/i.test(text) ? 'Closed today' : `Today ${text}`;
      } catch { /* */ }
    }
  }
  function wirePins(root) {
    markToday(root);
    // "Try again" after a map-service timeout: swap the card back to the
    // skeleton and fetch once more, bypassing the server's memo.
    root.querySelector('.places-retry')?.addEventListener('click', (ev) => {
      const slot = document.createElement('section');
      slot.className = 'places places-pending';
      slot.id = 'places';
      slot.dataset.q = ev.currentTarget.dataset.q;
      slot.innerHTML = '<div class="places-skel"></div>';
      root.replaceWith(slot);
      loadPlaces(slot, true);
    });
    const pin = (i) => root.querySelector(`.pin[data-pin="${i}"]`);
    const card = (i) => root.querySelector(`.place-card[data-pin="${i}"]`);
    for (const el of root.querySelectorAll('.place-card')) {
      const i = el.dataset.pin;
      el.addEventListener('mouseenter', () => pin(i)?.classList.add('hot'));
      el.addEventListener('mouseleave', () => pin(i)?.classList.remove('hot'));
      el.addEventListener('focus', () => pin(i)?.classList.add('hot'));
      el.addEventListener('blur', () => pin(i)?.classList.remove('hot'));
    }
    for (const el of root.querySelectorAll('.pin[data-pin]')) {
      const i = el.dataset.pin;
      el.addEventListener('mouseenter', () => card(i)?.classList.add('hot'));
      el.addEventListener('mouseleave', () => card(i)?.classList.remove('hot'));
      el.addEventListener('click', () => card(i)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }));
    }
  }

  /* ------------------------------------------------ settings: location */
  const geoBtn = document.getElementById('geo-btn');
  if (geoBtn) {
    const status = document.getElementById('geo-status');
    const forget = document.getElementById('geo-forget');
    const show = () => {
      const g = storedGeo();
      if (g) {
        status.textContent = `Using this device's location: ${g.lat.toFixed(3)}, ${g.lon.toFixed(3)} (from ${new Date(g.at).toLocaleTimeString()}). Stored only in this browser.`;
        forget.hidden = false;
      } else if (!navigator.geolocation || !window.isSecureContext) {
        status.textContent = 'Not available here: browsers share a location only on HTTPS or localhost. The home location below is used instead.';
        geoBtn.disabled = true;
      } else {
        status.textContent = 'Not shared yet. Search pages ask once; or use the button.';
        forget.hidden = true;
      }
    };
    show();
    geoBtn.addEventListener('click', () => {
      status.textContent = 'Asking the browser…';
      try { localStorage.removeItem(GEO_DENIED); } catch { /* */ }
      navigator.geolocation.getCurrentPosition(
        (pos) => { storeGeo(pos); show(); },
        (err) => { status.textContent = err.code === err.PERMISSION_DENIED ? 'Permission denied in the browser. The home location below is used instead.' : `Could not get a position (${err.message}).`; },
        { timeout: 10000, maximumAge: 0 },
      );
    });
    forget.addEventListener('click', () => { try { localStorage.removeItem(GEO_KEY); } catch { /* */ } show(); });
  }

  /* ------------------------------------------------- keyboard navigation */
  const layout = document.querySelector('.results-layout');
  if (layout) setupKeys(layout);

  function setupKeys(layout) {
    const items = () => Array.from(layout.querySelectorAll('.result, .img-card'));
    let cur = -1;
    const linkOf = (el) => (el.matches('.img-card') ? el : el.querySelector('.r-title a, .video-thumb, a[href]'));
    const highlight = (i) => {
      const list = items();
      if (!list.length) return;
      cur = Math.max(0, Math.min(i, list.length - 1));
      list.forEach((el, j) => el.classList.toggle('kb-active', j === cur));
      list[cur].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const clear = () => {
      cur = -1;
      layout.querySelectorAll('.kb-active').forEach((el) => el.classList.remove('kb-active'));
    };
    const tabs = Array.from(document.querySelectorAll('nav.tabs a.tab'));

    document.addEventListener('keydown', (ev) => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (lightbox?.isOpen()) return; // the dialog handles its own keys
      if (inField()) {
        if (ev.key === 'Escape') document.activeElement.blur();
        return;
      }
      switch (ev.key) {
        case 'j': case 'ArrowDown': ev.preventDefault(); highlight(cur + 1); break;
        case 'k': case 'ArrowUp': ev.preventDefault(); highlight(cur - 1); break;
        case 'Enter': {
          if (cur < 0) return;
          const el = items()[cur];
          if (!el) return;
          ev.preventDefault();
          if (el.matches('.img-card') && lightbox) return lightbox.open(items().filter((x) => x.matches('.img-card')).indexOf(el));
          if (el.matches('.result.video[data-embed]')) return playInline(el);
          const a = linkOf(el);
          if (a) a.click();
          break;
        }
        case 'o': {
          if (cur < 0) return;
          const a = linkOf(items()[cur]);
          if (a?.href) { ev.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
          break;
        }
        case 'Escape': {
          const playing = document.querySelector('.result.video.playing');
          if (playing) stopInline(playing);
          else clear();
          break;
        }
        case '1': case '2': case '3': case '4': {
          const tab = tabs[Number(ev.key) - 1];
          if (tab) { ev.preventDefault(); location.href = tab.href; }
          break;
        }
      }
    });
  }

  // "/" focuses the search box like on GitHub.
  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && !inField() && !lightbox?.isOpen()) {
      const input = document.querySelector('.sb-input');
      if (input) {
        ev.preventDefault();
        input.focus();
        input.select();
      }
    }
  });
})();
