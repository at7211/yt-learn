/* Netflix manifest helpers: pure functions, no DOM, no network. Loaded in two worlds:
   MAIN (registered with netflix-hook.js at document_start) and ISOLATED (injected with netflix-capture.js).
   Everything that crosses between the worlds is untrusted: the validators below are the single contract
   both ends share (tests/web/netflix-manifest.test.js).

   ytLearnNetflixSuspect(obj)        -> the manifest object (root or .result) | null
   ytLearnNetflixSummarize(manifest) -> {movieId, durationMs, tracks:[{lang, type, name, forced, formats}]} | null
   ytLearnNetflixPickTrack(tracks, lang) -> {track, format, url} | null
   ytLearnNfUrlOk(url)               -> boolean (https, *.nflxvideo.net, no userinfo/port, <= 2048 chars)
   ytLearnNfValidateRequest(msg)     -> null (valid) | reason string        (hook side)
   ytLearnNfValidateGetReply(msg, askedMovieId) -> null | reason string     (caller side)
   ytLearnNfValidateSeekAck(msg, requestId)     -> null | reason string     (caller side) */
(function (g) {
  const HOOK_VERSION = 1;
  const ORIGIN = 'https://www.netflix.com';
  const FORMATS = ['imsc1.1', 'dfxp-ls-sdh']; // preference order; every other format key is dropped
  const MAX_TRACKS = 200;
  const MAX_STR = 256;
  const MAX_NAME = 128;
  const MAX_URL = 2048;
  const MAX_MSG = 128 * 1024; // a real manifest summary (~50 tracks × 2 URLs × ~350 chars) is ~40 KB
  const MOVIE_ID_RE = /^[0-9]{1,12}$/;
  const SUSPECT_KEYS = ['textTracks', 'timedtexttracks', 'audioTracks', 'audio_tracks'];
  const STATES = ['found', 'pending', 'unsupported', 'off'];
  const STAT_KEYS = ['parsed', 'suspected', 'summarized', 'unknownShape', 'skippedReviver'];
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  const str = (s) => (typeof s === 'string' && s !== '' ? s : null);

  // A positive integer movieId (number, or a digit string) -> its decimal string; else null.
  function movieIdOf(m) {
    const v = m.movieId;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 1e12) return String(v);
    if (typeof v === 'string' && MOVIE_ID_RE.test(v) && Number(v) > 0) return v;
    return null;
  }

  function urlOk(u) {
    if (typeof u !== 'string' || u.length > MAX_URL) return false;
    let p;
    try { p = new URL(u); } catch (e) { return false; }
    return p.protocol === 'https:' && !p.username && !p.password && !p.port
      && p.hostname.endsWith('.nflxvideo.net') && p.hostname.length > '.nflxvideo.net'.length;
  }

  // Level one: "looks like a manifest" — root or .result with a positive movieId and any track key.
  function suspect(obj) {
    for (const m of [obj, isObj(obj) ? obj.result : null]) {
      if (!isObj(m) || movieIdOf(m) === null) continue;
      if (SUSPECT_KEYS.some((k) => has(m, k))) return m;
    }
    return null;
  }

  // First acceptable URL of one downloadable: new shape urls[].url (or urls[] strings), old downloadUrls{}.
  function firstUrl(d) {
    if (!isObj(d)) return null;
    const cands = [];
    if (Array.isArray(d.urls)) for (const x of d.urls) cands.push(isObj(x) ? x.url : x);
    if (isObj(d.downloadUrls)) for (const k of Object.keys(d.downloadUrls)) cands.push(d.downloadUrls[k]);
    for (const u of cands) if (urlOk(u)) return u;
    return null;
  }

  // {fmt: downloadable} from the new `downloadables` or the old `ttDownloadables` (object keyed by format;
  // an array of {contentProfile|format, ...} is accepted too).
  function downloadablesOf(t) {
    const d = has(t, 'downloadables') ? t.downloadables : t.ttDownloadables;
    if (Array.isArray(d)) {
      const out = {};
      for (const x of d) {
        const k = isObj(x) ? str(x.contentProfile) || str(x.format) : null;
        if (k && !has(out, k)) out[k] = x;
      }
      return out;
    }
    return isObj(d) ? d : {};
  }

  // Level two: the summary the hook keeps. null = suspected but not understood (-> unknownShape).
  function summarize(m) {
    if (!isObj(m)) return null;
    const movieId = movieIdOf(m);
    if (movieId === null) return null;
    const list = Array.isArray(m.textTracks) ? m.textTracks : (Array.isArray(m.timedtexttracks) ? m.timedtexttracks : null);
    if (!list) return null;
    const tracks = [];
    for (const t of list) {
      if (tracks.length >= MAX_TRACKS) break;
      if (!isObj(t) || t.isNoneTrack === true) continue;
      const dl = downloadablesOf(t);
      const formats = {};
      for (const f of FORMATS) {
        const u = has(dl, f) ? firstUrl(dl[f]) : null;
        if (u) formats[f] = u;
      }
      tracks.push({
        lang: (str(t.bcp47) || str(t.language) || '').slice(0, MAX_STR),
        type: (str(t.trackType) || str(t.type) || '').slice(0, MAX_STR),
        name: (str(t.displayName) || str(t.languageDescription) || '').slice(0, MAX_NAME),
        forced: t.isForcedNarrative === true || t.isForced === true,
        formats,
      });
    }
    const dur = m.duration;
    return { movieId, durationMs: typeof dur === 'number' && Number.isFinite(dur) && dur > 0 ? dur : null, tracks };
  }

  // Candidates: not forced, language matches, at least one kept format. PRIMARY before ASSISTIVE before
  // anything else; within a rank the plain tag (en / en-US, zh-Hant / zh-Hant-TW) first; stable otherwise.
  function pickTrack(tracks, lang) {
    const zh = /^zh-hant/i.test(String(lang || ''));
    const re = zh ? /^zh-Hant/i : /^en([_-]|$)/i;
    const plain = zh ? /^zh-Hant(-TW)?$/i : /^en(-US)?$/i;
    const rank = (t) => {
      const ty = String(t.type || '').toUpperCase();
      return (ty === 'PRIMARY' ? 0 : ty === 'ASSISTIVE' ? 2 : 4) + (plain.test(t.lang) ? 0 : 1);
    };
    const cands = (Array.isArray(tracks) ? tracks : [])
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => isObj(t) && t.forced !== true && typeof t.lang === 'string' && re.test(t.lang)
        && isObj(t.formats) && FORMATS.some((f) => has(t.formats, f)))
      .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i);
    if (!cands.length) return null;
    const track = cands[0].t;
    const format = FORMATS.find((f) => has(track.formats, f));
    return { track, format, url: track.formats[format] };
  }

  /* ---------- bridge contract ---------- */

  const shortStr = (s, max) => typeof s === 'string' && s.length <= (max || MAX_STR);
  const nonNegInt = (n) => Number.isSafeInteger(n) && n >= 0;
  function byteLength(msg) {
    let s;
    try { s = JSON.stringify(msg); } catch (e) { return Infinity; }
    if (typeof s !== 'string') return Infinity;
    return typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : s.length * 3;
  }

  function validateRequest(msg) {
    if (!isObj(msg) || typeof msg.type !== 'string') return 'not a message';
    if (msg.type === 'ytlearn:nf-get') {
      if (!shortStr(msg.nonce) || msg.nonce === '') return 'nonce';
      if (typeof msg.movieId !== 'string' || !MOVIE_ID_RE.test(msg.movieId)) return 'movieId';
      return null;
    }
    if (msg.type === 'ytlearn:nf-seek') {
      if (!shortStr(msg.requestId) || msg.requestId === '') return 'requestId';
      if (typeof msg.expectedMovieId !== 'string' || !MOVIE_ID_RE.test(msg.expectedMovieId)) return 'expectedMovieId';
      if (!nonNegInt(msg.ms)) return 'ms';
      if (typeof msg.play !== 'boolean') return 'play';
      return null;
    }
    if (msg.type === 'ytlearn:nf-off') return null;
    return 'type';
  }

  function trackError(t) {
    if (!isObj(t)) return 'track';
    for (const k of ['lang', 'type', 'name']) if (!shortStr(t[k])) return 'track.' + k;
    if (typeof t.forced !== 'boolean') return 'track.forced';
    if (!isObj(t.formats)) return 'track.formats';
    for (const k of Object.keys(t.formats)) {
      if (!FORMATS.includes(k)) return 'format ' + k;
      if (!urlOk(t.formats[k])) return 'url';
    }
    return null;
  }

  function validateGetReply(msg, askedMovieId) {
    if (!isObj(msg) || msg.type !== 'ytlearn:nf-manifest') return 'type';
    const bytes = byteLength(msg);
    if (bytes > MAX_MSG) return 'too large: ' + bytes + ' bytes';
    if (msg.hook !== HOOK_VERSION) return 'hook version';
    if (!shortStr(msg.nonce)) return 'nonce';
    if (msg.movieId !== askedMovieId) return 'movieId';
    if (!STATES.includes(msg.state)) return 'state';
    if (!isObj(msg.stats) || !STAT_KEYS.every((k) => nonNegInt(msg.stats[k]))) return 'stats';
    for (const k of ['title', 'show']) if (has(msg, k) && !shortStr(msg[k])) return k;
    if (has(msg, 'currentMs') && !(typeof msg.currentMs === 'number' && Number.isFinite(msg.currentMs) && msg.currentMs >= 0)) return 'currentMs';
    if (msg.state !== 'found') return has(msg, 'manifest') ? 'manifest not allowed' : null;
    const m = msg.manifest;
    if (!isObj(m)) return 'manifest';
    if (m.movieId !== askedMovieId) return 'manifest.movieId';
    if (m.durationMs !== null && !(typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) && m.durationMs > 0)) return 'durationMs';
    if (!Array.isArray(m.tracks) || m.tracks.length > MAX_TRACKS) return 'tracks';
    for (const t of m.tracks) {
      const e = trackError(t);
      if (e) return e;
    }
    return null;
  }

  function validateSeekAck(msg, requestId) {
    if (!isObj(msg) || msg.type !== 'ytlearn:nf-seek-ack') return 'type';
    if (byteLength(msg) > 4096) return 'too large';
    if (msg.requestId !== requestId) return 'requestId';
    if (msg.hook !== HOOK_VERSION) return 'hook version';
    if (typeof msg.ok !== 'boolean') return 'ok';
    if (has(msg, 'error') && !shortStr(msg.error)) return 'error';
    return null;
  }

  g.ytLearnNetflixHookVersion = HOOK_VERSION;
  g.ytLearnNetflixOrigin = ORIGIN;
  g.ytLearnNetflixMaxReplyBytes = MAX_MSG;
  g.ytLearnNetflixFormats = FORMATS.slice();
  g.ytLearnNetflixSuspect = suspect;
  g.ytLearnNetflixSummarize = summarize;
  g.ytLearnNetflixPickTrack = pickTrack;
  g.ytLearnNfUrlOk = urlOk;
  g.ytLearnNfValidateRequest = validateRequest;
  g.ytLearnNfValidateGetReply = validateGetReply;
  g.ytLearnNfValidateSeekAck = validateSeekAck;
})(globalThis);
