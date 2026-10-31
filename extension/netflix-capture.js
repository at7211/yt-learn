/* isolated world。ytLearnNetflixCapture({probe:true, timeoutMs, expectLessonId?}) -> Promise<probe result>；
   需先載入 netflix-manifest.js（validator 與挑軌）。正式擷取（TTML 解析、組 raw）在步驟 4 加上，這裡只有 probe：
   (1) 對 MAIN world 的鉤子送 ytlearn:nf-get，pending 時在總期限內每 500 ms 重問；
   (2) 挑英文軌，只抓那一個網址（credentials omit、redirect error、最多讀 2 MB），回報 status／bytes／前 80 字；
   (3) 送 ytlearn:nf-seek（ms = 回覆帶回的 currentMs、play:false），回報 ack。
   鉤子層的失敗（沒有回覆、一直 pending、認不出、已關閉、回覆格式不對）throw 中文訊息；挑軌、下載、seek 的問題
   寫進結果（enFetch.error、seek.error），診斷頁才看得到其它欄位。所有等待都有期限，結束時清掉計時器與 listener。 */
globalThis.ytLearnNetflixCapture = async function (opts) {
  opts = opts || {};
  const ORIGIN = 'https://www.netflix.com';
  const RETRY_MS = 500;
  const SEEK_ACK_MS = 1000;
  const MAX_BYTES = 2 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs || 25000;
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const NF = {
    validateGet: globalThis.ytLearnNfValidateGetReply,
    validateAck: globalThis.ytLearnNfValidateSeekAck,
    pick: globalThis.ytLearnNetflixPickTrack,
  };
  if (typeof NF.validateGet !== 'function' || typeof NF.pick !== 'function') throw new Error('netflix-manifest.js 未載入');
  if (!opts.probe) throw new Error('Netflix 正式擷取尚未實作'); // TODO(step 4): TTML + raw

  const movieIdNow = () => {
    const m = /^\/watch\/([0-9]{1,12})(?:\/|$)/.exec(location.pathname);
    return m ? m[1] : null;
  };
  const checkNav = (movieId) => {
    if (movieIdNow() !== movieId) throw new Error('換集了，請回到原本那一集再試');
  };
  const rand = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  // One listener for the whole run; each waiter says which reply it wants.
  const waiters = new Set();
  const onMessage = (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    for (const w of Array.from(waiters)) if (w.match(d)) w.resolve(d);
  };
  // Post `msg` and wait up to `ms` for the first reply `match` accepts; null on timeout.
  const request = (msg, match, ms) => new Promise((resolve) => {
    const w = {
      match,
      resolve: (d) => { waiters.delete(w); clearTimeout(w.timer); timers.delete(w.timer); resolve(d); },
    };
    w.timer = later(() => { waiters.delete(w); resolve(null); }, Math.max(1, ms));
    waiters.add(w); // listener is already registered: no reply can be missed
    window.postMessage(msg, ORIGIN);
  });
  const sleep = (ms) => new Promise((r) => later(r, Math.max(0, Math.min(ms, left()))));

  // Validator reason -> Chinese message. Too large: the real size, plus whatever still reads (state, track count).
  function replyError(err, reply) {
    const m = /^too large: (\d+) bytes$/.exec(err);
    if (!m) return '鉤子回覆格式不對（' + err + '）';
    const kb = (n) => Math.ceil(n / 1024) + ' KB';
    const max = globalThis.ytLearnNetflixMaxReplyBytes || 128 * 1024;
    const extra = [];
    if (typeof reply.state === 'string' && reply.state.length <= 32) extra.push('state ' + reply.state);
    const tracks = reply.manifest && Array.isArray(reply.manifest.tracks) ? reply.manifest.tracks.length : null;
    if (tracks !== null) extra.push(tracks + ' 軌');
    return '鉤子回覆太大（' + kb(Number(m[1])) + '，上限 ' + kb(max) + (extra.length ? '；' + extra.join('、') : '') + '）';
  }

  async function getManifest(movieId) {
    let last = null;
    while (left() > 0) {
      const t0 = Date.now();
      const nonce = rand();
      const reply = await request({ type: 'ytlearn:nf-get', nonce, movieId },
        (d) => d.type === 'ytlearn:nf-manifest' && d.nonce === nonce, Math.min(RETRY_MS, left()));
      if (reply) {
        const err = NF.validateGet(reply, movieId);
        if (err) throw new Error(replyError(err, reply));
        last = reply.state;
        if (reply.state === 'found') return reply;
        if (reply.state === 'unsupported') throw new Error('Netflix 改版了，認不出字幕清單');
        if (reply.state === 'off') throw new Error('Netflix 鉤子已關閉（請重新載入頁面）');
        await sleep(RETRY_MS - (Date.now() - t0));
      }
    }
    if (last === 'pending') throw new Error('還沒收到這部片的字幕清單');
    throw new Error('Netflix 鉤子不在（請重新載入頁面）');
  }

  async function readCapped(res) {
    const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('字幕檔超過 2 MB');
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch (e) { /* ignore */ }
          throw new Error('字幕檔超過 2 MB');
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.byteLength; }
      return out;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('字幕檔超過 2 MB');
    return new Uint8Array(buf);
  }

  async function fetchTrack(url) {
    const ac = new AbortController();
    later(() => ac.abort(), Math.max(1, left()));
    try {
      const res = await fetch(url, { credentials: 'omit', redirect: 'error', signal: ac.signal });
      const out = { status: res.status };
      const bytes = await readCapped(res);
      out.bytes = bytes.byteLength;
      out.head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096)).replace(/^﻿/, '').slice(0, 80);
      return out;
    } catch (e) {
      if (ac.signal.aborted) return { error: '逾時：' + timeoutMs / 1000 + ' 秒內沒有下載完字幕檔' };
      return { error: String((e && e.message) || e) };
    }
  }

  async function seek(movieId, ms) {
    const requestId = rand();
    const ack = await request({ type: 'ytlearn:nf-seek', requestId, expectedMovieId: movieId, ms, play: false },
      (d) => d.type === 'ytlearn:nf-seek-ack' && d.requestId === requestId, Math.max(1, Math.min(SEEK_ACK_MS, left())));
    if (!ack) return { ok: false, error: '鉤子沒有回覆 seek' };
    const err = NF.validateAck(ack, requestId);
    if (err) return { ok: false, error: 'seek 回覆格式不對（' + err + '）' };
    return ack.ok ? { ok: true } : { ok: false, error: ack.error || 'unknown' };
  }

  window.addEventListener('message', onMessage);
  try {
    const movieId = movieIdNow();
    if (!movieId) throw new Error('這不是 Netflix 播放頁');
    if (opts.expectLessonId && 'netflix.' + movieId !== opts.expectLessonId) throw new Error('換集了，請回到原本那一集再試');

    const reply = await getManifest(movieId);
    checkNav(movieId);
    const tracks = reply.manifest.tracks;
    const result = {
      movieId,
      hook: reply.stats,
      state: reply.state,
      title: reply.title || null,
      show: reply.show || null,
      durationMs: reply.manifest.durationMs,
      tracks: tracks.map((t) => ({ lang: t.lang, type: t.type, forced: t.forced, formats: Object.keys(t.formats) })),
    };

    const en = NF.pick(tracks, 'en');
    if (!en) result.enFetch = { error: '這部片沒有英文字幕' };
    else result.enFetch = { lang: en.track.lang, type: en.track.type, format: en.format, ...(await fetchTrack(en.url)) };

    if (typeof reply.currentMs !== 'number') result.seek = { ok: false, error: '找不到播放器 session' };
    else result.seek = { ms: Math.round(reply.currentMs), ...(await seek(movieId, Math.round(reply.currentMs))) };
    checkNav(movieId);
    return result;
  } finally {
    window.removeEventListener('message', onMessage);
    waiters.clear();
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }
};
