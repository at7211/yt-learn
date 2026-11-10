/* yt-learn overlay engine: content script on https://www.youtube.com/*, https://www.udemy.com/* and
   https://www.hellointerview.com/* (manifest), and on https://www.netflix.com/* while Netflix is switched on (background.js registers it)
   (isolated world, document_idle). Everything site-specific (lesson id from the route, the player
   {root, video}, ads, the native-caption rule, SPA navigation events, seeking) comes from a site adapter
   (site.js siteFor(location.hostname)). A site can be switched off for good on this page (Netflix:
   ytlearn:site-off from the worker, or any reply with {disabled:true}) → disable(). On a lesson page, the toolbar icon (background.js → ytlearn:toggle)
   lays the lesson over the player root:
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
  const ROUTE_POLL_MS = 1000; // fallback for the site's navigation events; also catches player replacement
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
  let Ph = null; // phrase.js
  let site = null; // site.js adapter for this host (null: unsupported host, the overlay stays idle)
  const ready = Promise.all([import(url('timing.js')), import(url('intro.js')), import(url('overlay-state.js')), import(url('dict.js')),
    import(url('site.js')), import(url('phrase.js'))])
    .then(([t, i, o, d, st, ph]) => {
      T = t; I = i; O = o; D = d; Ph = ph;
      site = st.siteFor(location.hostname);
      if (site) S = O.initialState();
      else log('overlay:unsupported-host', location.hostname);
    });
  let cssText = null;
  let S = null; // overlay-state machine
  let M = null; // the mounted overlay (see mount())
  let P = null; // the progress pill: { host, box, timer }
  let pollTimer = null;
  let cancelWait = null; // cancels a pending waitForPlayer (teardown / toggle-off)
  let lastHref = '';
  // Player identity: playerSeq is bumped whenever a {root, video} found on the page differs from the
  // last one seen (plain reference compare). It is the `token` the state machine compares.
  let lastPlayer = null;
  let playerSeq = 0;
  let posFix = null; // { root, prev }: root was position:static, we set relative (restored on teardown)

  /* ---------- messaging ---------- */

  // Every worker reply passes through here: {disabled:true} (the site was switched off) disables the
  // page before the caller sees it, so the caller's isStale check ends whatever it was doing.
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          if (chrome.runtime.lastError) { resolve({ error: '擴充功能未回應，請重新整理此頁' }); return; }
          if (O && O.replyDisables(reply)) disable('reply:' + msg.type);
          resolve(reply || { error: '擴充功能沒有回應' });
        });
      } catch (e) {
        resolve({ error: '擴充功能已重新載入，請重新整理此頁' });
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'ytlearn:site-off') {
      // Only the named site's pages act on it (the worker may broadcast to every tab); no reply either way.
      ready.then(() => { if (site && O.siteOffApplies(msg, site.name)) disable('site-off'); }, () => { });
      return false;
    }
    // ytlearn:toggle = the icon; ytlearn:mount = the worker after a capture it ran itself (turn on, never off).
    if (!msg || (msg.type !== 'ytlearn:toggle' && msg.type !== 'ytlearn:mount')) return false;
    const mountOnly = msg.type === 'ytlearn:mount';
    // Answer once the imports are done (a freshly injected overlay must not say {handled:false} just
    // because it is still loading). A page whose route we cannot read (e.g. URL and ytd-watch-flexy
    // disagree mid-navigation) is left to the worker's fallback flow.
    ready.then(() => {
      // Switched off on this page: say handled so the worker does not fall back to a capture, do nothing.
      if (S && S.disabled) { sendResponse({ handled: true }); return; }
      const id = currentVideoId();
      // A mount for another lesson (the tab moved on to another episode while the worker captured): leave it.
      if (mountOnly && id !== msg.videoId) { sendResponse({ handled: true }); return; }
      // No player on the page (an article-type Udemy lecture or HelloInterview page, YouTube mid-navigation): let the worker's
      // fallback flow run instead of silently building with nowhere to show the pill. Toggling an
      // overlay that is already up or building still works even if the player vanished.
      const handled = !!id && (S.mounted || S.building || !!findPlayer());
      sendResponse({ handled });
      if (!handled) return;
      if (id) onToggle(mountOnly).catch((e) => log('toggle:error', String(e && e.message || e)));
    }, () => sendResponse({ handled: false }));
    return true;
  });

  /* ---------- route ---------- */

  // The lesson id of the page (null off a lesson page or mid-navigation). Only called after `ready`.
  function currentVideoId() {
    return site ? site.lessonId(location.href, document) : null;
  }

  function findPlayer() {
    return site ? site.findPlayer(document) : null;
  }

  // -> playerSeq after looking at the page. A player that disappears does not count (the token keeps
  // naming the last one seen); only a different {root, video} replacing a seen one bumps the sequence.
  function playerToken() {
    const f = findPlayer();
    if (f) {
      if (lastPlayer && (lastPlayer.root !== f.root || lastPlayer.video !== f.video)) playerSeq++;
      lastPlayer = f;
    }
    return playerSeq;
  }

  function syncRoute() {
    if (!S) return;
    const r = O.navigate(S, currentVideoId(), playerToken());
    if (r.state === S) return;
    S = r.state;
    if (r.teardown) teardownAll();
    if (r.autoload) load(O.tokenOf(S), { build: false });
  }

  // Permanent for this page (until reload): every wait, timer and pending seek dropped, the overlay removed,
  // and on Netflix the MAIN-world hook told to stand down (ytlearn:nf-off makes it a no-op for good).
  function disable(why) {
    if (!S || S.disabled) return;
    S = O.disable(S);
    log('disabled', why);
    teardownAll();
    if (site && site.name === 'netflix') window.postMessage({ type: 'ytlearn:nf-off' }, 'https://www.netflix.com');
  }

  async function onToggle(mountOnly = false) {
    await ready;
    if (S.disabled) return;
    syncRoute();
    const r = mountOnly ? O.mountOnly(S) : O.toggle(S);
    S = r.state;
    log(mountOnly ? 'mount' : 'toggle', S.videoId, r.action);
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
    send({ type: 'ytlearn:build', videoId: tok.videoId, url: location.href }).then((r) => {
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
    const found = findPlayer();
    const player = found && found.root;
    if (!player || O.isStale(S, tok)) return;
    holdPosition(player);
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
    s.textContent = site.nativeCaptionCss; // hides the site's own captions while ON_CLASS is on the root
    (document.head || document.documentElement).append(s);
  }

  // Our layers are position:absolute; inset:0 inside the root. A static root gets position:relative
  // while we are on it (the sites' chosen roots are positioned today; the HelloInterview parentElement
  // fallback may not be).
  function holdPosition(root) {
    if (posFix && posFix.root === root) return;
    releasePosition();
    if (getComputedStyle(root).position !== 'static') return;
    posFix = { root, prev: root.style.position };
    root.style.position = 'relative';
  }

  function releasePosition() {
    if (!posFix) return;
    posFix.root.style.position = posFix.prev;
    posFix = null;
  }

  function waitForPlayer(tok) {
    return new Promise((resolve) => {
      const find = () => {
        const f = findPlayer();
        return f ? { player: f.root, video: f.video } : null;
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
    // 我的片語: a tab in the head swaps the vocab track for the saved phrase notes
    const tabN = el('span', '0');
    const tab = el('button', null, 'ptab');
    tab.type = 'button';
    tab.hidden = true;
    tab.append('我的片語 ', tabN);
    head.append(el('span', null, 'rule'), title, count, tab);
    const rows = el('div', null, 'panel-rows');
    const notes = el('div', null, 'pnotes');
    notes.hidden = true;
    panel.append(head, rows, notes);

    const subs = el('div', null, 'layer subs');
    const en = el('div', null, 'sub-en');
    const zh = el('div', null, 'sub-zh');
    subs.append(en, zh);

    const hint = el('div', HINT_TEXT, 'layer hint'); // top strip on the first play: which keys do what

    const ask = el('button', '問 AI', 'ph-ask');
    ask.type = 'button';
    ask.hidden = true;
    const card = el('div', null, 'ph-card');
    card.hidden = true;

    frame.append(shade, intro, panel, subs, hint, ask, card);
    return { frame, intro, introTitle, introLines, panel, title, total, count, tab, tabN, rows, notes, track: null, subs, en, zh, hint, ask, card };
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
    lastPlayer = { root: player, video }; // the identity we mount on; the route poll compares against it
    holdPosition(player);
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
      tok, player, video, host, root, ui, lesson,
      flat: T.flattenHits(lesson.vocab, lesson.words),
      vocabById: new Map(lesson.vocab.map((v) => [v.id, v])),
      keys: { sub: null, panel: null, count: null },
      rowH: 0, t: 0, raf: 0, started: false, introShown: false, introTimer: null,
      showZh: true, showEn: true, showVocab: true, showShade: true, ad: false,
      abort: new AbortController(), ro: null, mo: null,
      notes: {}, notesRev: 0, noteCount: 0, notesView: false, // 我的片語: {"a-b": NOTE} from ytlearn:notes
      // phrase selection: frozen holds the subtitle line still; sel is the drag; open the selection the
      // button / card is about; gen stops an explain loop; swallowUntil eats the click after a pointerup
      ph: { frozen: false, sel: null, open: null, gen: 0, swallowUntil: 0 },
    };
    M = m;
    renderIntro(m, lesson.intro);
    buildPanel(m);
    player.append(host);
    bindPlayer(m);
    S = O.markMounted(S, tok);
    log('mounted', tok.videoId, lesson.cues.length, 'cues', lesson.vocab.length, 'vocab');
    loadNotes(m);
  }

  function bindPlayer(m) {
    const { video, player } = m;
    const sig = { signal: m.abort.signal };
    const onPlay = () => { start(m); loop(m); };
    video.addEventListener('play', () => closePhrase(m), sig); // playing closes the phrase card
    video.addEventListener('play', onPlay, sig);
    video.addEventListener('playing', onPlay, sig);
    for (const ev of ['pause', 'ended', 'seeked', 'seeking', 'timeupdate']) video.addEventListener(ev, () => draw(m), sig);
    bindPhrase(m, sig);
    m.ro = new ResizeObserver(() => { closePhrase(m); m.rowH = 0; m.keys.panel = null; fitSubtitle(m); renderPanel(m, m.t); });
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

  // Runs on every class change of the player root (YouTube flips classes constantly). Only write when
  // something differs: DOMTokenList writes always fire a mutation record, and this is that observer.
  function checkAd(m) {
    if (M !== m) return;
    const ad = site.isAd(m.player);
    if (ad !== m.ad) {
      m.ad = ad;
      m.ui.frame.classList.toggle('ad', ad);
      if (ad) closePhrase(m, false); // the frame is hidden for the ad
      else {
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
    m.ph.gen++; // an explain loop in flight stops at its next step
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
    if (S) S = O.teardown(S); // async work started before this (lesson reply, player wait, poll) is now stale
    if (site && typeof site.cancelSeek === 'function') site.cancelSeek();
    clearTimeout(pollTimer);
    pollTimer = null;
    if (cancelWait) cancelWait();
    teardownOverlay();
    removePill();
    const found = findPlayer();
    if (found) found.root.classList.remove(ON_CLASS);
    releasePosition();
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
    if (m.ph.frozen) return; // a selection, the 問 AI button or the card holds the line still
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
    const key = ci + '|' + (lit ? lit.join('-') : '') + '|' + m.notesRev;
    if (key === m.keys.sub) return;
    m.keys.sub = key;
    const { en, zh } = m.ui;
    if (ci < 0) { en.replaceChildren(); zh.replaceChildren(); en.dataset.cue = ''; return; }
    const cue = cues[ci];
    const noted = Ph.notedWords(m.notes, ci);
    const parts = [];
    // Every token is its own .w span carrying its global word index (data-i: what a drag selects); a vocab
    // hit is a .kw wrapper around its tokens' .w spans (data-term = the vocab term, which a click on any of
    // them looks up). Words inside a saved phrase note get .noted (a faint underline).
    let kw = null;
    cue.tokens.forEach((tok, k) => {
      const w = cue.a + k;
      const span = el('span', tok, noted.has(w) ? 'w noted' : 'w');
      span.dataset.i = String(w);
      const inHit = lit && w >= lit[0] && w <= lit[1];
      if (inHit && kw) { kw.append(document.createTextNode(' '), span); return; }
      if (k) parts.push(document.createTextNode(' '));
      if (inHit) {
        kw = el('span', null, 'kw');
        if (term) kw.dataset.term = term;
        kw.append(span);
        parts.push(kw);
      } else parts.push(span);
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
    applyPanelView(m);
  }

  function renderPanel(m, t) {
    const { words } = m.lesson;
    const total = m.lesson.vocab.length;
    const k = T.seenCount(m.flat, words, t);
    const countKey = k + '/' + total;
    if (countKey !== m.keys.count) { m.keys.count = countKey; m.ui.count.textContent = k + ' / ' + total; }
    const live = (m.flat.length > 0 && t >= m.flat[0].start - PANEL_LEAD) || m.noteCount > 0; // notes: visible from the start
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

  // R / [ / ] / a vocab row. A paused video resumes after the jump (as before). A site adapter with its own
  // seek (Netflix: through the hook, never video.currentTime) takes over when it returns true.
  function seek(m, t) {
    t = Math.max(0, t);
    const play = m.video.paused;
    const bySite = typeof site.seek === 'function' && site.seek(m.video, t, { play, lessonId: m.tok.videoId, gen: m.tok.gen }) === true;
    // Defense in depth: on Netflix video.currentTime is never written (error M7375), whatever the adapter said.
    if (!bySite && site.name !== 'netflix') {
      m.video.currentTime = t;
      if (play) m.video.play().catch(() => { });
    }
    draw(m);
  }

  // A note's card: jump to its cue WITHOUT playing. A site adapter with its own seek (Netflix: through the
  // hook, play:false) takes over when it returns true; video.currentTime is never written on Netflix.
  function seekNoPlay(m, t) {
    t = Math.max(0, t);
    m.video.pause();
    const bySite = typeof site.seek === 'function' && site.seek(m.video, t, { play: false, lessonId: m.tok.videoId, gen: m.tok.gen }) === true;
    if (!bySite && site.name !== 'netflix') m.video.currentTime = t;
  }

  /* ---------- a plain click on a subtitle word → pause, Cambridge dictionary in a popup beside the video ---------- */

  function lookUpWord(m, target) {
    const raw = D.clickWord(target);
    if (!raw) return;
    const word = D.dictWord(raw);
    if (!word) return; // a number or punctuation only
    m.video.pause();
    const sc = window.screen || {};
    const left = Number.isFinite(sc.availLeft) ? sc.availLeft : 0;
    send({ type: 'ytlearn:dict', url: D.dictUrl(word), screen: { left, width: sc.availWidth } })
      .then((r) => { if (!r || !r.ok) log('dict:failed', r && r.error); });
  }

  /* ---------- phrase: drag across subtitle words → 問 AI → card (phrase.js; ported from web/app.js) ----------
     Press a word: the video pauses and the line freezes (no re-render, so the spans under the pointer stay).
     Drag over other words of the same cue: .sel. Release on the same word without leaving it: the dictionary
     (or the card of a saved note covering it). Two or more words: a 問 AI button; its click sends
     ytlearn:explain and polls ytlearn:explain-poll (each one short worker request) while the card shows
     載入中. Esc, a press outside, or playing closes it; closing only stops the polling. Everything a press on
     our words / button / card does stays ours: stopPropagation keeps it from the site's player. Hit testing
     uses the closed shadow root's own elementFromPoint (document.elementFromPoint stops at the host). */

  const wordOf = (n) => (n && typeof n.closest === 'function' ? n.closest('.w[data-i]') : null);
  const subWords = (m) => [...m.ui.en.querySelectorAll('.w[data-i]')];
  const stop = (e) => e.stopPropagation();

  function bindPhrase(m, sig) {
    const subs = m.ui.subs;
    subs.addEventListener('pointerdown', (e) => onSubsDown(m, e), sig);
    subs.addEventListener('pointermove', (e) => onSubsMove(m, e), sig);
    subs.addEventListener('pointerup', (e) => onSubsUp(m, e), sig);
    subs.addEventListener('pointercancel', (e) => onSubsCancel(m, e), sig);
    subs.addEventListener('lostpointercapture', (e) => onSubsCancel(m, e), sig);
    // the mouse events and the click / dblclick of a press on a word are ours (no play toggle, no fullscreen)
    for (const ev of ['mousedown', 'mouseup', 'click', 'dblclick']) {
      subs.addEventListener(ev, (e) => {
        if (!wordOf(e.target) && Date.now() > m.ph.swallowUntil) return;
        e.preventDefault();
        e.stopPropagation();
      }, sig);
    }
    // the button, the card and the notes tab: clicks never reach the player; buttons never take focus (Space)
    for (const box of [m.ui.ask, m.ui.card, m.ui.tab]) {
      for (const ev of ['pointerdown', 'pointerup', 'mouseup', 'click', 'dblclick']) box.addEventListener(ev, stop, sig);
      box.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('button')) e.preventDefault();
      }, sig);
    }
    m.ui.ask.addEventListener('click', () => askAI(m, false), sig);
    m.ui.tab.addEventListener('click', () => { m.notesView = !m.notesView; applyPanelView(m); }, sig);
  }

  function paintSel(m, a, b) {
    for (const w of subWords(m)) {
      const i = Number(w.dataset.i);
      w.classList.toggle('sel', a != null && i >= a && i <= b);
    }
  }

  function onSubsDown(m, e) {
    if (M !== m || e.button !== 0) return;
    const w = wordOf(e.target);
    if (!w) return;
    e.preventDefault(); // no text selection, no compat mousedown
    e.stopPropagation(); // the press stays ours: the site's player must not toggle play/pause too
    const ci = Number(m.ui.en.dataset.cue);
    const i = Number(w.dataset.i);
    if (!Number.isInteger(ci) || !m.lesson.cues[ci] || !Number.isInteger(i)) return;
    closePhrase(m, false); // a new press ends any card / button; the line on screen stays as it is
    m.video.pause();
    m.ph.frozen = true;
    m.ph.sel = { pointerId: e.pointerId, ci, down: i, cur: i, moved: false, target: w };
    try { w.setPointerCapture(e.pointerId); } catch (err) { /* the drag still works while over the words */ }
    paintSel(m, i, i);
  }

  function onSubsMove(m, e) {
    const sel = m.ph.sel;
    if (!sel || e.pointerId !== sel.pointerId) return;
    e.stopPropagation();
    const hit = typeof m.root.elementFromPoint === 'function' ? m.root.elementFromPoint(e.clientX, e.clientY) : null;
    const w = wordOf(hit);
    if (!w || !m.ui.en.contains(w)) return; // between words or off the line: keep the last range
    const r = Ph.spanRange(m.lesson.cues[sel.ci], sel.down, Number(w.dataset.i));
    if (!r) return;
    if (r.a !== r.b) sel.moved = true;
    sel.cur = r.a === sel.down ? r.b : r.a;
    paintSel(m, r.a, r.b);
  }

  function onSubsUp(m, e) {
    const sel = m.ph.sel;
    if (!sel || e.pointerId !== sel.pointerId) return;
    e.stopPropagation();
    m.ph.sel = null;
    m.ph.swallowUntil = Date.now() + 500;
    try { sel.target.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    const kind = Ph.dragKind(sel.down, sel.cur, sel.moved);
    if (kind === 'phrase') {
      const r = Ph.spanRange(m.lesson.cues[sel.ci], sel.down, sel.cur);
      showAsk(m, sel.ci, r.a, r.b);
      return;
    }
    if (kind === 'dict') {
      const note = Ph.noteAtWord(m.notes, sel.ci, sel.down);
      if (note) { openNoteCard(m, note); return; }
      closePhrase(m);
      lookUpWord(m, sel.target);
      return;
    }
    closePhrase(m);
  }

  function onSubsCancel(m, e) {
    if (!m.ph.sel || e.pointerId !== m.ph.sel.pointerId) return;
    closePhrase(m);
  }

  // A press anywhere on the page outside our shadow root closes the button / card. Presses inside it
  // arrive retargeted to the host (the host itself takes no pointer events): our own handlers decide.
  function onOutsideDown(e) {
    const m = M;
    if (!m || !m.ph.frozen || m.ph.sel || e.target === m.host) return;
    closePhrase(m);
  }

  // Ends the selection, hides the button and the card, stops any explain polling and lets the subtitle follow
  // the video again (rerender=false: the caller keeps the line on screen).
  function closePhrase(m, rerender = true) {
    if (!m || !m.ph) return;
    const ph = m.ph;
    ph.gen++;
    ph.sel = null;
    ph.open = null;
    m.ui.ask.hidden = true;
    m.ui.card.hidden = true;
    m.ui.card.replaceChildren();
    if (!ph.frozen) return;
    paintSel(m, null, null);
    ph.frozen = false;
    if (rerender && M === m) { m.keys.sub = null; draw(m); }
  }

  // The selection's rect (its .w spans), else the subtitle block, else the lower part of the frame.
  function anchorRect(m, a, b) {
    const fr = m.ui.frame.getBoundingClientRect();
    const spans = subWords(m).filter((w) => { const i = Number(w.dataset.i); return i >= a && i <= b; });
    return Ph.unionRect(spans.map((w) => w.getBoundingClientRect()))
      || Ph.unionRect([m.ui.subs.getBoundingClientRect()])
      || { left: fr.left, right: fr.right, top: fr.top + fr.height * 0.8, bottom: fr.bottom };
  }

  function showAsk(m, ci, a, b) {
    const phrase = Ph.phraseText(m.lesson.cues[ci], a, b);
    if (!phrase) { closePhrase(m); return; }
    m.ph.open = { ci, a, b, phrase };
    const p = Ph.placeAbove(anchorRect(m, a, b), m.ui.frame.getBoundingClientRect(), 0, 6);
    m.ui.ask.style.left = p.cx + 'px';
    m.ui.ask.style.bottom = p.bottom + 'px';
    m.ui.ask.hidden = false;
  }

  function showCard(m, view) {
    const o = m.ph.open;
    const card = m.ui.card;
    m.ui.ask.hidden = true;
    card.replaceChildren(...Ph.cardNodes(document, { ...view, phrase: o ? o.phrase : '' }, {
      close: () => closePhrase(m),
      retry: () => askAI(m, false),
      override: () => askAI(m, true),
    }));
    card.hidden = false;
    const p = Ph.placeAbove(o ? anchorRect(m, o.a, o.b) : anchorRect(m, -1, -1), m.ui.frame.getBoundingClientRect(), card.offsetWidth);
    card.style.left = p.left + 'px';
    card.style.bottom = p.bottom + 'px';
    card.style.maxHeight = p.maxHeight + 'px';
  }

  // A saved note: its card at once, no AI call. The line must already show the note's cue.
  function openNoteCard(m, note) {
    m.ph.frozen = true;
    m.ph.open = { ci: note.cue, a: note.a, b: note.b, phrase: note.phrase };
    paintSel(m, note.a, note.b);
    showCard(m, { kind: 'done', result: note.result });
  }

  async function askAI(m, override) {
    const o = m.ph.open;
    if (!o || M !== m) return;
    const saved = Ph.noteFor(m.notes, o.ci, o.a, o.b, o.phrase);
    if (saved) { showCard(m, { kind: 'done', result: saved.result }); return; }
    const gen = ++m.ph.gen;
    const live = () => M === m && gen === m.ph.gen && m.ph.open === o;
    showCard(m, { kind: 'loading' });
    const r = await Ph.runExplain({
      post: (body) => send({ type: 'ytlearn:explain', ...body }),
      poll: (key) => send({ type: 'ytlearn:explain-poll', key }),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      cancelled: () => !live(),
      onPending: (p) => { if (p.warning && live()) showCard(m, { kind: 'loading', warning: p.warning }); },
    }, { videoId: m.tok.videoId, cue: o.ci, a: o.a, b: o.b, phrase: o.phrase, override: override === true });
    if (r.kind === 'done' && M === m) addNote(m, r.note);
    if (!live() || r.kind === 'cancelled') return;
    if (r.kind === 'done') showCard(m, { kind: 'done', result: r.note.result });
    else showCard(m, { kind: r.kind, error: r.error });
  }

  /* ---------- 我的片語 (phrase notes) in the panel ---------- */

  async function loadNotes(m) {
    const r = await send({ type: 'ytlearn:notes', videoId: m.tok.videoId });
    if (M !== m || !r || r.status !== 200 || !r.json || !r.json.notes || typeof r.json.notes !== 'object') return;
    m.notes = { ...r.json.notes, ...m.notes };
    notesChanged(m);
  }

  function addNote(m, note) {
    if (!note || typeof note !== 'object' || !Number.isInteger(note.a) || !Number.isInteger(note.b)) return;
    m.notes[Ph.noteKey(note.a, note.b)] = note;
    notesChanged(m);
    if (Number(m.ui.en.dataset.cue) !== note.cue) return; // the line may be frozen: underline the new note now
    for (const w of subWords(m)) {
      const i = Number(w.dataset.i);
      if (i >= note.a && i <= note.b) w.classList.add('noted');
    }
  }

  function notesChanged(m) {
    m.notesRev++;
    m.noteCount = Ph.noteList(m.notes).length;
    m.ui.notes.replaceChildren(...Ph.noteRowNodes(document, m.notes, (n, e) => { if (e) e.stopPropagation(); openNoteFromPanel(m, n); }));
    applyPanelView(m);
    if (!m.ph.frozen) draw(m);
  }

  // The panel shows the vocab track or 我的片語: notes alone keep the panel up even with no vocab.
  function applyPanelView(m) {
    const nv = m.lesson.vocab.length;
    const nn = m.noteCount;
    const notesView = nn > 0 && (m.notesView || nv === 0);
    const ui = m.ui;
    ui.panel.hidden = nv === 0 && nn === 0;
    ui.panel.classList.toggle('notes-view', notesView);
    ui.rows.hidden = notesView;
    ui.notes.hidden = !notesView;
    ui.title.hidden = nv === 0;
    ui.count.hidden = nv === 0 || notesView;
    ui.tab.hidden = nn === 0;
    ui.tab.disabled = nv === 0; // nothing to switch back to
    ui.tab.className = notesView ? 'ptab on' : 'ptab';
    ui.tabN.textContent = String(nn);
    if (!notesView && nv) { m.rowH = 0; m.keys.panel = null; renderPanel(m, m.t); } // the track measured 0 rows while hidden
  }

  // Click a note: jump to its cue without playing, draw that cue, then its card (no AI call).
  function openNoteFromPanel(m, note) {
    if (M !== m || !m.lesson.cues[note.cue]) return;
    const at = m.lesson.words[m.lesson.cues[note.cue].a].t + 0.05;
    closePhrase(m, false);
    seekNoPlay(m, at);
    m.keys.sub = null;
    renderSubtitle(m, at); // Netflix seeks asynchronously: draw the target cue now, then hold it
    openNoteCard(m, note);
  }

  /* ---------- keyboard (capture phase, only our keys, only while mounted) ---------- */

  function onKey(e) {
    const m = M;
    if (!m || !O) return;
    if (m.ph.frozen && (e.key === 'Escape' || e.code === 'Escape') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePhrase(m);
      return;
    }
    const action = O.keyAction(e, { active: !m.ad, path: typeof e.composedPath === 'function' ? e.composedPath() : [] });
    if (!action) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const f = m.ui.frame;
    if (action === 'zh') { m.showZh = !m.showZh; f.classList.toggle('no-zh', !m.showZh); if (m.showZh) fitSubtitle(m); }
    else if (action === 'en') { m.showEn = !m.showEn; f.classList.toggle('no-en', !m.showEn); if (m.showEn) fitSubtitle(m); }
    else if (action === 'shade') { m.showShade = !m.showShade; f.classList.toggle('no-shade', !m.showShade); }
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
  window.addEventListener('pointerdown', onOutsideDown, true);
  setInterval(() => {
    // Fallback when the site's navigation event is missed or renamed (Udemy has none: this poll is its
    // router; Netflix and HelloInterview pushState changes fire nothing either); also catches ytd-watch-flexy
    // catching up with the URL, and a player whose {root, video} was replaced under the same lesson id (Udemy
    // swaps <video>, HelloInterview rebuilds the whole player): either change → navigate → remount.
    if (!S || S.disabled) return;
    if (location.href !== lastHref || currentVideoId() !== S.videoId || (S.videoId !== null && playerToken() !== S.token)) { lastHref = location.href; syncRoute(); }
  }, ROUTE_POLL_MS);
  ready.then(() => {
    if (!site) return;
    for (const ev of site.navEvents) {
      (ev.target === 'window' ? window : document).addEventListener(ev.name, () => { lastHref = location.href; syncRoute(); });
    }
    lastHref = location.href;
    syncRoute();
  }, (e) => log('overlay:load-failed', String(e && e.message || e)));
})();
