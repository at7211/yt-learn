/* yt-learn overlay: content script on https://www.youtube.com/* (isolated world, document_idle).
   On a watch page, the toolbar icon (background.js → ytlearn:toggle) lays the lesson over #movie_player:
   English subtitle with the current vocab hit in orange, 繁中 subtitle, the vocab panel, and the 前情提要 card.
   youtube.com enforces Trusted Types: no innerHTML / outerHTML / insertAdjacentHTML anywhere here —
   DOM is built with createElement / textContent / append only (style.textContent is not a sink).
   Pure helpers come from the extension package via dynamic import (web_accessible_resources). */
(() => {
  if (globalThis.__ytlearnOverlay) return;
  globalThis.__ytlearnOverlay = true;

  const PANEL_LEAD = 1.0; // seconds before the first vocab word that the panel fades in (web/app.js)
  const INTRO_SECONDS = 10; // the 前情提要 card stays this long after the first play
  const HINT_SECONDS = 8; // the shortcut strip at the top stays this long after the first play
  const HINT_TEXT = 'Z 中文 · E 英文 · V 單字 · R 重播本句 · [ ] 上一句／下一句';
  const POLL_MS = 2000; // job polling while a lesson is being built
  const ROUTE_POLL_MS = 1000; // fallback for yt-navigate-finish
  const ERROR_PILL_MS = 6000;
  const WAIT_PLAYER_MS = 10000;
  const MAIN_STYLE_ID = 'ytlearn-main-style';
  const ON_CLASS = 'ytlearn-on';

  const log = (...a) => console.log('[yt-learn]', ...a);
  const url = (p) => chrome.runtime.getURL(p);

  let T = null; // timing.js
  let I = null; // intro.js
  let O = null; // overlay-state.js
  let D = null; // dict.js
  const ready = Promise.all([import(url('timing.js')), import(url('intro.js')), import(url('overlay-state.js')), import(url('dict.js'))])
    .then(([t, i, o, d]) => { T = t; I = i; O = o; D = d; S = O.initialState(); });
  let cssText = null;
  let S = null; // overlay-state machine
  let M = null; // the mounted overlay (see mount())
  let P = null; // the progress pill: { host, box, timer }
  let pollTimer = null;
  let cancelWait = null; // cancels a pending waitForPlayer (teardown / toggle-off)
  let lastHref = '';

  /* ---------- messaging ---------- */

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          if (chrome.runtime.lastError) resolve({ error: '擴充功能未回應，請重新整理此頁' });
          else resolve(reply || { error: '擴充功能沒有回應' });
        });
      } catch (e) {
        resolve({ error: '擴充功能已重新載入，請重新整理此頁' });
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'ytlearn:toggle') return false;
    // Answer at once: the worker only needs to know we took over. A page whose route we cannot
    // read (URL and ytd-watch-flexy disagree mid-navigation) is left to the worker's old flow.
    const id = currentVideoId();
    sendResponse({ handled: !!id });
    if (id) onToggle().catch((e) => log('toggle:error', String(e && e.message || e)));
    return false;
  });

  /* ---------- route ---------- */

  function currentVideoId() {
    const flexy = document.querySelector('ytd-watch-flexy');
    const attr = flexy ? flexy.getAttribute('video-id') : null;
    // Before overlay-state.js has loaded, fall back to a plain URL check (same rule, minus the flexy check).
    if (O) return O.watchVideoId(location.href, attr);
    try {
      const u = new URL(location.href);
      return u.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v') || '') ? u.searchParams.get('v') : null;
    } catch (e) { return null; }
  }

  function syncRoute() {
    if (!S) return;
    const r = O.navigate(S, currentVideoId());
    if (r.state === S) return;
    S = r.state;
    if (r.teardown) teardownAll();
    if (r.autoload) load(O.tokenOf(S), { build: false });
  }

  async function onToggle() {
    await ready;
    syncRoute();
    const r = O.toggle(S);
    S = r.state;
    log('toggle', S.videoId, r.action);
    if (r.action === 'teardown') teardownAll();
    else if (r.action === 'load') { teardownAll(); load(O.tokenOf(S), { build: true }); }
  }

  /* ---------- lesson / build ---------- */

  async function load(tok, { build }) {
    S = O.markBuilding(S, tok); // in flight: a second click turns the overlay off instead of loading again
    const res = await send({ type: 'ytlearn:lesson', videoId: tok.videoId });
    if (O.isStale(S, tok)) return;
    if (res && res.lesson) { await mount(tok, res.lesson); return; }
    if (res && res.missing) {
      if (build) startBuild(tok);
      else S = O.markIdle(S, tok);
      return;
    }
    S = O.markIdle(S, tok);
    if (build) showPill(tok, O.PILL_PREFIX + ((res && res.error) || '無法取得課程'), true);
  }

  function startBuild(tok) {
    S = O.markBuilding(S, tok);
    showPill(tok, O.pillText(null));
    let buildFailed = false;
    let pollErrors = 0; // consecutive {error} replies (server gone after ingest); 3 in a row ends the wait
    send({ type: 'ytlearn:build', videoId: tok.videoId }).then((r) => {
      if (O.isStale(S, tok)) return;
      log('build:result', JSON.stringify(r));
      if (!r || r.ok === false || r.error) {
        buildFailed = true;
        failBuild(tok, (r && r.error) || '無法開始擷取');
      }
    });
    const tick = async () => {
      pollTimer = null;
      if (O.isStale(S, tok) || buildFailed) return;
      const res = await send({ type: 'ytlearn:job', videoId: tok.videoId });
      if (O.isStale(S, tok) || buildFailed) return;
      if (res && res.error) {
        if (++pollErrors >= 3) { failBuild(tok, res.error); return; }
        pollTimer = setTimeout(tick, POLL_MS);
        return;
      }
      pollErrors = 0;
      const job = res && res.job;
      if (job) {
        const phase = O.jobPhase(job);
        if (phase === 'error') { failBuild(tok, O.pillText(job).slice(O.PILL_PREFIX.length)); return; }
        showPill(tok, O.pillText(job));
        if (phase === 'done') {
          const got = await send({ type: 'ytlearn:lesson', videoId: tok.videoId });
          if (O.isStale(S, tok)) return;
          if (got && got.lesson) { removePill(); await mount(tok, got.lesson); }
          else failBuild(tok, (got && got.error) || '課程檔讀取失敗');
          return;
        }
      }
      // job missing (the build request has not reached /add yet) or still running: keep polling
      pollTimer = setTimeout(tick, POLL_MS);
    };
    pollTimer = setTimeout(tick, POLL_MS);
  }

  function failBuild(tok, message) {
    clearTimeout(pollTimer);
    pollTimer = null;
    S = O.markIdle(S, tok);
    showPill(tok, O.PILL_PREFIX + message, true);
  }

  /* ---------- pill (bottom-left of the player) ---------- */

  function showPill(tok, text, isError = false) {
    const player = document.getElementById('movie_player');
    if (!player || O.isStale(S, tok)) return;
    if (!P || !P.host.isConnected || P.host.parentNode !== player) {
      removePill();
      const host = document.createElement('div');
      host.id = 'ytlearn-pill';
      host.style.cssText = 'position:absolute;inset:0;z-index:31;pointer-events:none;';
      // closed: page scripts on youtube.com cannot reach into the pill (we keep our own refs in P)
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = cssText || '.pill{position:absolute;left:12px;bottom:64px;padding:6px 14px;border-radius:999px;background:rgba(17,17,17,.88);color:#fff;font:500 13px/1.4 system-ui,sans-serif}';
      const box = document.createElement('div');
      box.className = 'pill';
      root.append(style, box);
      player.append(host);
      P = { host, box, timer: null };
    }
    clearTimeout(P.timer);
    P.box.textContent = text;
    P.box.classList.toggle('error', isError);
    if (isError) P.timer = setTimeout(removePill, ERROR_PILL_MS);
  }

  function removePill() {
    if (!P) return;
    clearTimeout(P.timer);
    P.host.remove();
    P = null;
  }

  /* ---------- mount / teardown ---------- */

  function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  function ensureMainStyle() {
    if (document.getElementById(MAIN_STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = MAIN_STYLE_ID;
    s.textContent = '#movie_player.' + ON_CLASS + ' .ytp-caption-window-container{opacity:0 !important;pointer-events:none !important}';
    (document.head || document.documentElement).append(s);
  }

  function waitForPlayer(tok) {
    return new Promise((resolve) => {
      const find = () => {
        const player = document.getElementById('movie_player');
        const video = player && (player.querySelector('video.html5-main-video') || player.querySelector('video'));
        return player && video ? { player, video } : null;
      };
      const now = find();
      if (now) { resolve(now); return; }
      const finish = (v) => { mo.disconnect(); clearTimeout(timer); if (cancelWait === cancel) cancelWait = null; resolve(v); };
      const cancel = () => finish(null);
      const mo = new MutationObserver(() => {
        const got = find();
        if (got || O.isStale(S, tok)) finish(got);
      });
      const timer = setTimeout(() => finish(find()), WAIT_PLAYER_MS);
      if (cancelWait) cancelWait();
      cancelWait = cancel;
      mo.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function buildUi() {
    const frame = el('div', null, 'frame');
    const shade = el('div', null, 'shade');

    const intro = el('div', null, 'layer intro');
    intro.hidden = true;
    const introTitle = el('div', null, 'intro-title');
    const introLines = el('div', null, 'intro-lines');
    intro.append(el('div', '前情提要', 'intro-eyebrow'), introTitle, el('div', null, 'intro-rule'), introLines);

    const panel = el('div', null, 'layer panel');
    const head = el('div', null, 'panel-head');
    const total = el('span', '0');
    const title = el('span', null, 'panel-title');
    title.append('本集精選 ', total, ' 個字');
    const count = el('span', '0 / 0', 'panel-count');
    head.append(el('span', null, 'rule'), title, count);
    const rows = el('div', null, 'panel-rows');
    panel.append(head, rows);

    const subs = el('div', null, 'layer subs');
    const en = el('div', null, 'sub-en');
    const zh = el('div', null, 'sub-zh');
    subs.append(en, zh);

    const hint = el('div', HINT_TEXT, 'layer hint'); // top strip on the first play: which keys do what

    frame.append(shade, intro, panel, subs, hint);
    return { frame, intro, introTitle, introLines, panel, total, count, rows, track: null, en, zh, hint };
  }

  async function mount(tok, lesson) {
    if (!lesson || !Array.isArray(lesson.cues) || !Array.isArray(lesson.words)) {
      S = O.markIdle(S, tok);
      showPill(tok, O.PILL_PREFIX + '課程檔格式錯誤', true);
      return;
    }
    if (cssText === null) {
      try { cssText = await fetch(url('overlay.css')).then((r) => r.text()); } catch (e) { cssText = ''; }
    }
    const found = await waitForPlayer(tok);
    if (O.isStale(S, tok)) return;
    if (!found) { S = O.markIdle(S, tok); showPill(tok, O.PILL_PREFIX + '找不到播放器', true); return; }
    teardownOverlay();
    const { player, video } = found;
    ensureMainStyle();

    lesson.vocab = lesson.vocab || [];
    const host = document.createElement('div');
    host.id = 'ytlearn-overlay';
    host.style.cssText = 'position:absolute;inset:0;z-index:30;pointer-events:none;';
    // closed: page scripts on youtube.com cannot read or drive the overlay (refs live in M / ui)
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = cssText;
    const ui = buildUi();
    root.append(style, ui.frame);

    const m = {
      tok, player, video, host, ui, lesson,
      flat: T.flattenHits(lesson.vocab, lesson.words),
      vocabById: new Map(lesson.vocab.map((v) => [v.id, v])),
      keys: { sub: null, panel: null, count: null },
      rowH: 0, t: 0, raf: 0, started: false, introShown: false, introTimer: null,
      showZh: true, showEn: true, showVocab: true, ad: false,
      abort: new AbortController(), ro: null, mo: null,
    };
    M = m;
    renderIntro(m, lesson.intro);
    buildPanel(m);
    player.append(host);
    bindPlayer(m);
    S = O.markMounted(S, tok);
    log('mounted', tok.videoId, lesson.cues.length, 'cues', lesson.vocab.length, 'vocab');
  }

  function bindPlayer(m) {
    const { video, player } = m;
    const sig = { signal: m.abort.signal };
    const onPlay = () => { start(m); loop(m); };
    video.addEventListener('play', onPlay, sig);
    video.addEventListener('playing', onPlay, sig);
    for (const ev of ['pause', 'ended', 'seeked', 'seeking', 'timeupdate']) video.addEventListener(ev, () => draw(m), sig);
    m.ui.en.addEventListener('click', (e) => onWordClick(m, e), sig);
    // a double click on a word must not reach the player (fullscreen)
    m.ui.en.addEventListener('dblclick', (e) => { if (D.clickWord(e.target)) e.stopPropagation(); }, sig);
    m.ro = new ResizeObserver(() => { m.rowH = 0; m.keys.panel = null; fitSubtitle(m); renderPanel(m, m.t); });
    m.ro.observe(player);
    m.mo = new MutationObserver(() => checkAd(m));
    m.mo.observe(player, { attributes: true, attributeFilter: ['class'] });
    checkAd(m);
    if (!video.paused && !video.ended) onPlay();
    else {
      if (video.currentTime > 0.5) m.ui.frame.classList.add('started'); // mounted mid-video while paused
      draw(m);
    }
  }

  function start(m) {
    if (m.ad) return; // the frame is hidden during an ad: start (and the intro timer) when it ends
    if (!m.started) { m.started = true; m.ui.frame.classList.add('started'); }
    if (!m.introShown) { m.introShown = true; showIntro(m); }
  }

  function loop(m) {
    if (m.raf || M !== m) return;
    const step = () => {
      m.raf = 0;
      if (M !== m) return;
      draw(m);
      if (!m.video.paused && !m.video.ended) m.raf = requestAnimationFrame(step);
    };
    m.raf = requestAnimationFrame(step);
  }

  // Runs on every class change of #movie_player (YouTube flips classes constantly). Only write when
  // something differs: DOMTokenList writes always fire a mutation record, and this is that observer.
  function checkAd(m) {
    if (M !== m) return;
    const ad = O.adShowing(m.player.classList);
    if (ad !== m.ad) {
      m.ad = ad;
      m.ui.frame.classList.toggle('ad', ad);
      if (!ad) {
        m.keys.sub = null; m.keys.panel = null;
        if (!m.video.paused && !m.video.ended) { start(m); loop(m); }
        draw(m);
        fitSubtitle(m); // same cue as before the ad: renderSubtitle would skip the fit
      }
    }
    // re-assert after YouTube rewrites className; off while an ad plays so its captions stay usable
    if (m.player.classList.contains(ON_CLASS) === ad) m.player.classList.toggle(ON_CLASS, !ad);
  }

  function draw(m) {
    if (M !== m || m.ad) return;
    const t = m.video.currentTime || 0;
    m.t = t;
    renderSubtitle(m, t);
    renderPanel(m, t);
  }

  function teardownOverlay() {
    const m = M;
    if (!m) return;
    M = null;
    if (m.raf) cancelAnimationFrame(m.raf);
    clearTimeout(m.introTimer);
    clearTimeout(m.hintTimer);
    m.abort.abort();
    if (m.ro) m.ro.disconnect();
    if (m.mo) m.mo.disconnect();
    m.host.remove();
    m.player.classList.remove(ON_CLASS);
  }

  function teardownAll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (cancelWait) cancelWait();
    teardownOverlay();
    removePill();
    const player = document.getElementById('movie_player');
    if (player) player.classList.remove(ON_CLASS);
  }

  /* ---------- render (ported from web/app.js; operates on m.ui instead of $('id')) ---------- */

  // The intro card is optional data; anything malformed just means no card.
  function renderIntro(m, intro) {
    const box = m.ui.intro;
    box.hidden = true;
    box.classList.remove('show');
    try {
      const rows = I.introRows(intro);
      if (!rows) return;
      m.ui.introTitle.replaceChildren(...rows.title.map((r) => el('div', r)));
      m.ui.introLines.replaceChildren(...rows.lines.map((r) => el('div', r)));
      box.hidden = false;
    } catch (e) { box.hidden = true; }
  }

  function showIntro(m) {
    const hint = m.ui.hint;
    hint.classList.add('show');
    m.hintTimer = setTimeout(() => hint.classList.remove('show'), HINT_SECONDS * 1000);
    const box = m.ui.intro;
    if (box.hidden) return;
    box.classList.add('show');
    m.introTimer = setTimeout(() => box.classList.remove('show'), INTRO_SECONDS * 1000);
  }

  function renderSubtitle(m, t) {
    const { cues, words } = m.lesson;
    const ci = T.cueIndexAt(cues, words, t);
    const hit = T.activeHitAt(m.flat, cues, words, t);
    let lit = null; // [a, b] global word range to paint orange
    let term = ''; // its vocab term: what a click on the orange span looks up
    if (hit && ci >= 0) {
      const v = m.vocabById.get(hit.vocabId);
      const h = v.hits[hit.hitIdx];
      if (h.cue === ci) { lit = [h.a, h.b]; term = v.term; }
    }
    const key = ci + '|' + (lit ? lit.join('-') : '');
    if (key === m.keys.sub) return;
    m.keys.sub = key;
    const { en, zh } = m.ui;
    if (ci < 0) { en.replaceChildren(); zh.replaceChildren(); en.dataset.cue = ''; return; }
    const cue = cues[ci];
    const parts = [];
    // Every token is its own clickable .w span; a vocab hit spanning several tokens is one .kw span
    // (data-term = the vocab term), so a click on it looks up the whole term.
    let kw = null;
    cue.tokens.forEach((tok, k) => {
      const w = cue.a + k;
      const inHit = lit && w >= lit[0] && w <= lit[1];
      if (inHit && kw) { kw.textContent += ' ' + tok; return; }
      if (k) parts.push(document.createTextNode(' '));
      if (inHit) {
        kw = el('span', tok, 'kw');
        if (term) kw.dataset.term = term;
        parts.push(kw);
      } else parts.push(el('span', tok, 'w'));
    });
    const enChanged = en.dataset.cue !== String(ci);
    en.replaceChildren(...parts);
    if (enChanged) {
      en.dataset.cue = String(ci);
      zh.textContent = cue.zh || '';
      fitSubtitle(m);
    }
  }

  // Shrink English when it needs more than two lines, Chinese when it overflows one line.
  // Never measured while hidden (display:none gives 0): toggling a line back on re-fits.
  function fitSubtitle(m) {
    const { en, zh } = m.ui;
    if (m.showEn) {
      en.classList.remove('long');
      if (en.textContent && en.getClientRects().length) {
        en.classList.add('measuring'); // lift the 2-line clamp while measuring
        const lh = parseFloat(getComputedStyle(en).lineHeight);
        if (en.scrollHeight > lh * 2.3) en.classList.add('long');
        en.classList.remove('measuring');
      }
    }
    if (m.showZh) {
      zh.classList.remove('long');
      if (zh.textContent && zh.getClientRects().length && zh.scrollWidth > zh.clientWidth + 1) zh.classList.add('long');
    }
  }

  function buildPanel(m) {
    const n = m.lesson.vocab.length;
    m.ui.panel.hidden = n === 0;
    m.ui.total.textContent = String(n);
    // All occurrences are rendered once as a vertical track; renderPanel slides it so the current
    // occurrence sits in the middle slot.
    const track = el('div', null, 'ptrack');
    m.flat.forEach((h, fi) => {
      const v = m.vocabById.get(h.vocabId);
      const r = el('div', null, 'prow future');
      const l1 = el('div', null, 'l1');
      l1.append(el('span', v.term, 'term'), el('span', v.pos || '', 'pos'), el('span', v.ipa || '', 'ipa'),
        el('span', '×' + v.hits.length, 'times'));
      const dots = el('span', null, 'dots');
      dots.append(...v.hits.map((_, j) => el('i', null, j === h.hitIdx ? 'on' : '')));
      const l2 = el('div', null, 'l2');
      l2.append(el('span', v.zh, 'pzh'), dots);
      r.append(l1, l2);
      r.addEventListener('click', (e) => { e.stopPropagation(); seek(m, m.flat[fi].start - 0.3); });
      track.append(r);
    });
    m.ui.rows.replaceChildren(track);
    m.ui.track = track;
    m.keys.panel = null;
  }

  function renderPanel(m, t) {
    const { words } = m.lesson;
    const total = m.lesson.vocab.length;
    const k = T.seenCount(m.flat, words, t);
    const countKey = k + '/' + total;
    if (countKey !== m.keys.count) { m.keys.count = countKey; m.ui.count.textContent = k + ' / ' + total; }
    const live = m.flat.length > 0 && t >= m.flat[0].start - PANEL_LEAD;
    m.ui.panel.classList.toggle('live', live);
    if (!m.showVocab) return;
    const ps = T.panelState(m.flat, words, t);
    if (ps.current === m.keys.panel) return;
    const track = m.ui.track;
    if (!track) return;
    const rowEls = track.children;
    if (!m.rowH && rowEls[0]) m.rowH = rowEls[0].getBoundingClientRect().height;
    if (!m.rowH) return; // not laid out yet (hidden): try again on the next draw
    m.keys.panel = ps.current;
    const first = ps.rows.length ? ps.rows[0] : 0;
    track.style.transform = 'translateY(' + (-first * m.rowH) + 'px)';
    for (let fi = 0; fi < rowEls.length; fi++) {
      const r = rowEls[fi];
      r.classList.toggle('current', fi === ps.current);
      r.classList.toggle('future', ps.current < 0 || fi > ps.current);
    }
  }

  function seek(m, t) {
    m.video.currentTime = Math.max(0, t);
    if (m.video.paused) m.video.play().catch(() => { });
    draw(m);
  }

  /* ---------- click a subtitle word → pause, Cambridge dictionary in a popup beside the video ---------- */

  function onWordClick(m, e) {
    if (M !== m) return;
    const raw = D.clickWord(e.target);
    if (!raw) return;
    e.stopPropagation(); // the click stays ours: YouTube's player must not toggle play/pause too
    e.preventDefault();
    const word = D.dictWord(raw);
    if (!word) return; // a number or punctuation only
    m.video.pause();
    const sc = window.screen || {};
    const left = Number.isFinite(sc.availLeft) ? sc.availLeft : 0;
    send({ type: 'ytlearn:dict', url: D.dictUrl(word), screen: { left, width: sc.availWidth } })
      .then((r) => { if (!r || !r.ok) log('dict:failed', r && r.error); });
  }

  /* ---------- keyboard (capture phase, only our keys, only while mounted) ---------- */

  function onKey(e) {
    const m = M;
    if (!m || !O) return;
    const action = O.keyAction(e, { active: !m.ad, path: typeof e.composedPath === 'function' ? e.composedPath() : [] });
    if (!action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const f = m.ui.frame;
    if (action === 'zh') { m.showZh = !m.showZh; f.classList.toggle('no-zh', !m.showZh); if (m.showZh) fitSubtitle(m); }
    else if (action === 'en') { m.showEn = !m.showEn; f.classList.toggle('no-en', !m.showEn); if (m.showEn) fitSubtitle(m); }
    else if (action === 'vocab') {
      m.showVocab = !m.showVocab;
      f.classList.toggle('no-vocab', !m.showVocab);
      if (m.showVocab) { m.rowH = 0; m.keys.panel = null; renderPanel(m, m.t); }
    } else {
      const target = O.cueSeekTarget(m.lesson.cues, m.lesson.words, m.video.currentTime || 0, action);
      if (target !== null) seek(m, target);
    }
  }

  /* ---------- boot ---------- */

  window.addEventListener('keydown', onKey, true);
  document.addEventListener('yt-navigate-finish', () => { lastHref = location.href; syncRoute(); });
  setInterval(() => {
    // Fallback when yt-navigate-finish is missed or renamed; also catches ytd-watch-flexy catching up with the URL.
    if (!S) return;
    if (location.href !== lastHref || currentVideoId() !== S.videoId) { lastHref = location.href; syncRoute(); }
  }, ROUTE_POLL_MS);
  ready.then(() => { lastHref = location.href; syncRoute(); }, (e) => log('overlay:load-failed', String(e && e.message || e)));
})();
