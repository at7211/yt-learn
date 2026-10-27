/* 與 bookmarklet.js 步驟 (1)–(5) 同源；改一邊請同步另一邊。 */
/* MAIN world。ytLearnCapture({expectVideoId, timeoutMs, pollMs, inPlace, forceMs}) -> Promise<raw>；錯誤一律 throw 中文訊息。
   所有等待都有期限；結束時（成功、失敗、逾時）清掉自己排的計時器，並把 CC／靜音／播放狀態還原成呼叫前的樣子。
   播放器回傳的 videoId 與 expectVideoId 不同時視為「尚未就緒」繼續輪詢；到期時若曾看到別的 videoId → 播放器資料與網址不一致，否則 → 逾時。
   inPlace 時若分頁網址的 v 已不是 expectVideoId（使用者換了影片）→ 立刻 播放器資料與網址不一致。
   強制重抓（每次擷取最多一次）：forceMs 內沒有找到 timedtext 請求，或 json3 為空／下載失敗時，清掉 Resource Timing 並切換 CC 讓播放器重新請求字幕。 */
globalThis.ytLearnCapture = async function (opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 25000;
  const pollMs = opts.pollMs || 500;
  const forceMs = opts.forceMs || 3000;
  const inPlace = !!opts.inPlace;
  const PLAY_WINDOW_MS = 3000;
  const CC_TOGGLE_MS = 200;
  const log = (...a) => console.log('[yt-learn]', ...a);
  const expectVideoId = opts.expectVideoId || new URL(location.href).searchParams.get('v');
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const sleep = (ms) => new Promise((r) => later(r, Math.max(0, Math.min(ms, left()))));
  const timeoutError = () => new Error('逾時：' + timeoutMs / 1000 + ' 秒內沒有取得字幕');
  const mismatchError = () => new Error('播放器資料與網址不一致');

  let video = null;
  let ccBtn = null;
  let ccOriginal = null;
  let played = false;
  let playbackEnded = false;
  let restoreMuted = null;
  let forced = false;

  const ccOn = () => ccBtn.getAttribute('aria-pressed') === 'true';
  const endPlayback = () => {
    if (!played || playbackEnded) return;
    playbackEnded = true;
    try { video.pause(); } catch (e) { log('ignored', e); }
    if (restoreMuted !== null) video.muted = restoreMuted;
  };
  const restoreCc = () => {
    if (!ccBtn || ccOriginal === null) return;
    try { if (ccOn() !== ccOriginal) ccBtn.click(); } catch (e) { log('ignored', e); }
  };
  const checkNav = () => {
    if (!inPlace) return;
    let v = null;
    try { v = new URL(location.href).searchParams.get('v'); } catch (e) { log('ignored', e); }
    if (v !== expectVideoId) throw mismatchError();
  };

  let seenOther = null;
  const getPr = () => {
    let a = null;
    try { a = document.getElementById('movie_player')?.getPlayerResponse?.(); } catch (e) { log('ignored', e); }
    const aid = a?.videoDetails?.videoId;
    if (aid === expectVideoId) return a;
    if (aid) seenOther = aid;
    const b = globalThis.ytInitialPlayerResponse;
    if (b && b.videoDetails?.videoId === expectVideoId) return b;
    return null;
  };

  try {
    if (typeof performance.setResourceTimingBufferSize === 'function') {
      try { performance.setResourceTimingBufferSize(1000); } catch (e) { log('ignored', e); }
    }

    /* (1) 播放器資料就緒，且 videoId 與網址一致 */
    let pr = null;
    for (;;) {
      checkNav();
      pr = getPr();
      if (pr) break;
      if (left() <= 0) throw seenOther ? mismatchError() : timeoutError();
      await sleep(pollMs);
    }
    const videoId = pr.videoDetails.videoId;
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('此影片沒有字幕軌');
    const track = tracks.find((t) => t.languageCode === 'en') || tracks[0];
    const duration = Number(pr.videoDetails.lengthSeconds) || 0;

    /* (2) 開 CC；必要時靜音播放 */
    video = document.querySelector('video');
    ccBtn = document.querySelector('.ytp-subtitles-button');
    if (ccBtn) {
      ccOriginal = ccOn();
      if (!ccOriginal) ccBtn.click();
    }
    if (video) {
      if (!inPlace) {
        video.muted = true;
        played = true;
        Promise.resolve(video.play()).catch((e) => log('ignored', e));
      } else if (video.paused) {
        restoreMuted = video.muted;
        video.muted = true;
        played = true;
        Promise.resolve(video.play()).catch((e) => log('ignored', e));
        later(endPlayback, PLAY_WINDOW_MS);
      }
    }

    /* (3) 該影片最新一筆、非翻譯的 timedtext 請求；必要時強制重抓一次 */
    const findUrl = () => {
      const hits = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => {
        if (!n.includes('/api/timedtext')) return false;
        try {
          const u = new URL(n);
          return u.searchParams.get('v') === videoId && !u.searchParams.has('tlang');
        } catch (e) { return false; }
      });
      return hits[hits.length - 1];
    };
    const forceRefresh = async () => {
      forced = true;
      log('force fresh timedtext request');
      try { if (typeof performance.clearResourceTimings === 'function') performance.clearResourceTimings(); } catch (e) { log('ignored', e); }
      if (!ccBtn) return;
      if (ccOn()) {
        ccBtn.click();
        await sleep(CC_TOGGLE_MS);
        ccBtn.click();
      } else {
        ccBtn.click();
      }
    };
    const waitUrl = async () => {
      const forceAt = Date.now() + forceMs;
      for (;;) {
        checkNav();
        const hit = findUrl();
        if (hit) return hit;
        if (left() <= 0) throw timeoutError();
        if (!forced && Date.now() >= forceAt) {
          await forceRefresh();
          continue;
        }
        await sleep(pollMs);
      }
    };

    /* (4) 以 json3 重抓；空或失敗且尚未強制重抓 → 強制重抓後再試一次 */
    const fetchJson3 = async (hit) => {
      const u = new URL(hit);
      u.searchParams.set('fmt', 'json3');
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      if (ac) later(() => ac.abort(), Math.max(1, left()));
      try {
        const res = await fetch(u.toString(), ac ? { signal: ac.signal } : undefined);
        if (!res.ok) throw new Error('字幕下載失敗（HTTP ' + res.status + '）');
        const j3 = await res.json();
        const evs = j3 && j3.events;
        if (!Array.isArray(evs) || !evs.length) throw new Error('字幕內容為空');
        return { u, evs };
      } catch (e) {
        if (ac && ac.signal.aborted) throw timeoutError();
        throw e;
      }
    };
    let got;
    let url = await waitUrl();
    if (inPlace) endPlayback();
    restoreCc();
    try {
      got = await fetchJson3(url);
    } catch (e) {
      if (forced || String(e.message).startsWith('逾時')) throw e;
      log('json3 failed, retrying once', e.message);
      await forceRefresh();
      url = await waitUrl();
      restoreCc();
      got = await fetchJson3(url);
    }
    const u = got.u;
    const evs = got.evs;

    /* (5) 組 raw；ASR 軌缺 tOffsetMs 一律為 0，其他軌僅在同事件有任一 offset 時為 0 */
    const isAsr = (u.searchParams.get('kind') || track.kind) === 'asr';
    const events = [];
    for (const e of evs) {
      if (!e.segs) continue;
      const segs = [];
      const eventHasAnyOffset = e.segs.some((s) => typeof s.tOffsetMs === 'number');
      for (const s of e.segs) {
        const text = (s.utf8 ?? '').replace(/\n/g, '').trim();
        if (!text) continue;
        segs.push([s.tOffsetMs ?? (isAsr || eventHasAnyOffset ? 0 : null), text]);
      }
      if (!segs.length) continue;
      events.push({ t: e.tStartMs ?? 0, d: e.dDurationMs ?? 0, segs });
    }
    if (!events.length) throw new Error('字幕內容為空');
    const last = events[events.length - 1];
    if (duration && last.t > duration * 1000) throw new Error('字幕時間超出影片長度');
    const brands = navigator.userAgentData?.brands || [];
    const chromeBrand = brands.find((b) => b.brand === 'Google Chrome') || brands.find((b) => b.brand === 'Chromium');
    const raw = {
      videoId,
      title: pr.videoDetails.title,
      channel: pr.videoDetails.author,
      duration,
      lang: u.searchParams.get('lang') || track.languageCode,
      kind: isAsr ? 'asr' : 'manual',
      capturedAt: new Date().toISOString(),
      chrome: chromeBrand?.version || '',
      events,
    };
    if (!raw.chrome) delete raw.chrome;
    return raw;
  } finally {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    endPlayback();
    restoreCc();
  }
};
