/* Netflix read-only hook: MAIN world, document_start, registered by background.js (id ytlearn-netflix-hook)
   together with netflix-manifest.js, only while the user has turned Netflix on.
   - Wraps JSON.parse transparently: the original is called exactly once with the same this/arguments,
     native exceptions propagate unchanged, the result object is returned untouched. Only the summarising
     step is inside try/catch. Calls with a reviver are never summarised.
   - Keeps summaries (track list + signed subtitle URLs) of up to 10 manifests, keyed by movieId.
   - Answers the isolated world over window.postMessage (ytlearn:nf-get / nf-seek / nf-off), never sends a
     request, never changes one, never writes to the console.
   - After ytlearn:nf-off it is a permanent no-op (JSON.parse restored if it is still our wrapper). */
(() => {
  if (globalThis.__ytlearnNfHook) return;
  try {
    Object.defineProperty(globalThis, '__ytlearnNfHook', { value: true, configurable: false, enumerable: false, writable: false });
  } catch (e) {
    return;
  }
  // Captured once: page code changing these globals later cannot change what the hook does.
  const suspect = globalThis.ytLearnNetflixSuspect;
  const summarize = globalThis.ytLearnNetflixSummarize;
  const validateRequest = globalThis.ytLearnNfValidateRequest;
  const HOOK = globalThis.ytLearnNetflixHookVersion;
  const ORIGIN = 'https://www.netflix.com';
  if (typeof suspect !== 'function' || typeof summarize !== 'function' || typeof validateRequest !== 'function') return;

  const MAX_CACHE = 10;
  const MAX_UNKNOWN = 50;
  const MAX_STR = 256;
  const orig = JSON.parse;
  const cache = new Map(); // movieId -> summary (insertion order = LRU order)
  const unknown = new Set(); // movieIds whose manifest was suspected but not understood
  const stats = { parsed: 0, suspected: 0, summarized: 0, unknownShape: 0, skippedReviver: 0 };
  let disabled = false;

  function remember(s) {
    cache.delete(s.movieId);
    cache.set(s.movieId, s);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    unknown.delete(s.movieId);
  }

  function inspect(result) {
    const m = suspect(result);
    if (!m) return;
    stats.suspected++;
    let s = null;
    try { s = summarize(m); } catch (e) { s = null; }
    if (s) {
      stats.summarized++;
      remember(s);
      return;
    }
    stats.unknownShape++;
    const id = String(m.movieId);
    if (!cache.has(id)) {
      unknown.delete(id);
      unknown.add(id);
      while (unknown.size > MAX_UNKNOWN) unknown.delete(unknown.values().next().value);
    }
  }

  // Same name and arity as the native one. `arguments` is passed through as is.
  const wrapper = {
    parse(text, reviver) {
      const result = Reflect.apply(orig, this, arguments);
      if (disabled) return result;
      try {
        stats.parsed++;
        if (typeof reviver === 'function') stats.skippedReviver++;
        else if (result !== null && typeof result === 'object') inspect(result);
      } catch (e) { /* summarising must never affect the page */ }
      return result;
    },
  }.parse;

  try {
    JSON.parse = wrapper;
  } catch (e) {
    return;
  }

  /* ---------- page player (best effort; every call guarded) ---------- */

  function videoPlayer() {
    try {
      return globalThis.netflix.appContext.state.playerApp.getAPI().videoPlayer || null;
    } catch (e) {
      return null;
    }
  }

  function playerFor(movieId) {
    const vp = videoPlayer();
    if (!vp) return null;
    try {
      const ids = vp.getAllPlayerSessionIds();
      for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== 'string' || !id.startsWith('watch-')) continue;
        const p = vp.getVideoPlayerBySessionId(id);
        if (p && String(p.getMovieId()) === movieId) return p;
      }
    } catch (e) { /* no session */ }
    return null;
  }

  const clip = (s) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, MAX_STR) : null);

  function titleFor(movieId) {
    const out = {};
    try {
      const md = globalThis.netflix.appContext.state.playerApp.getAPI().getVideoMetadataByVideoId(Number(movieId));
      const v = md && (md._video || md.video);
      const title = clip(md && md.title) || clip(v && v.title);
      const show = clip(md && md._metadata && md._metadata.video && md._metadata.video.title);
      if (title) out.title = title;
      if (show && show !== title) out.show = show;
    } catch (e) { /* not available */ }
    if (!out.title) {
      try {
        const el = document.querySelector('[data-uia="video-title"]');
        const t = clip(el && el.textContent);
        if (t) out.title = t;
        const h = el && el.querySelector('h4');
        const show = clip(h && h.textContent);
        if (show && !out.show && show !== t) out.show = show;
      } catch (e) { /* no DOM title */ }
    }
    return out;
  }

  function currentMs(p) {
    try {
      const ms = p.getCurrentTime();
      return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- bridge ---------- */

  const post = (msg) => window.postMessage(msg, ORIGIN);
  const statsCopy = () => ({ ...stats });

  function answerGet(msg) {
    const reply = { type: 'ytlearn:nf-manifest', nonce: msg.nonce, hook: HOOK, movieId: msg.movieId, state: 'off', stats: statsCopy() };
    if (disabled) return post(reply);
    const p = playerFor(msg.movieId);
    const ms = p ? currentMs(p) : null;
    if (ms !== null) reply.currentMs = ms;
    const s = cache.get(msg.movieId);
    if (s) {
      reply.state = 'found';
      reply.manifest = s;
      Object.assign(reply, titleFor(msg.movieId));
    } else {
      reply.state = unknown.has(msg.movieId) ? 'unsupported' : 'pending';
    }
    post(reply);
  }

  function answerSeek(msg) {
    const ack = (ok, error) => post(ok
      ? { type: 'ytlearn:nf-seek-ack', requestId: msg.requestId, hook: HOOK, ok: true }
      : { type: 'ytlearn:nf-seek-ack', requestId: msg.requestId, hook: HOOK, ok: false, error });
    if (disabled) return ack(false, 'off');
    const m = /^\/watch\/([0-9]{1,12})(?:\/|$)/.exec(location.pathname);
    if (!m || m[1] !== msg.expectedMovieId) return ack(false, 'urlMismatch');
    const p = playerFor(msg.expectedMovieId);
    if (!p) return ack(false, 'noSession');
    try {
      const dur = p.getDuration();
      if (!(typeof dur === 'number' && Number.isFinite(dur) && dur > 0) || msg.ms > dur) return ack(false, 'outOfRange');
      p.seek(msg.ms);
      if (msg.play) p.play();
    } catch (e) {
      return ack(false, 'apiError');
    }
    return ack(true);
  }

  function turnOff() {
    disabled = true;
    cache.clear();
    unknown.clear();
    if (JSON.parse === wrapper) JSON.parse = orig;
  }

  window.addEventListener('message', (ev) => {
    try {
      if (ev.source !== window || ev.origin !== ORIGIN) return;
      const msg = ev.data;
      if (validateRequest(msg) !== null) return; // our own replies and everything else land here
      if (msg.type === 'ytlearn:nf-get') answerGet(msg);
      else if (msg.type === 'ytlearn:nf-seek') answerSeek(msg);
      else if (msg.type === 'ytlearn:nf-off') turnOff();
    } catch (e) { /* never let a bridge message break the page */ }
  });
})();
