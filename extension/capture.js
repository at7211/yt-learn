/* 與 bookmarklet.js 步驟 (1)–(5) 同源；改一邊請同步另一邊。 */
globalThis.ytLearnCapture = async function (opts) {
  const expectVideoId = opts.expectVideoId;
  const timeoutMs = opts.timeoutMs || 25000;
  const pollMs = opts.pollMs || 500;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + timeoutMs;
  let dead = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      dead = true;
      reject(new Error('逾時：' + timeoutMs / 1000 + ' 秒內沒有取得字幕'));
    }, timeoutMs);
  });

  const run = async () => {
    const getPr = () => {
      const a = document.getElementById('movie_player')?.getPlayerResponse?.();
      if (a && a.videoDetails?.videoId === expectVideoId) return a;
      const b = window.ytInitialPlayerResponse;
      if (b && b.videoDetails?.videoId === expectVideoId) return b;
      return null;
    };

    let pr = null;
    while (!dead) {
      pr = getPr();
      if (pr) break;
      await sleep(pollMs);
    }
    if (!pr) throw new Error('逾時：播放器資料未就緒');
    const videoId = pr.videoDetails.videoId;
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) throw new Error('此影片沒有字幕軌');
    const track = tracks.find((t) => t.languageCode === 'en') || tracks[0];
    const duration = Number(pr.videoDetails.lengthSeconds) || 0;

    const video = document.querySelector('video');
    const ccBtn = document.querySelector('.ytp-subtitles-button');
    if (ccBtn && ccBtn.getAttribute('aria-pressed') !== 'true') ccBtn.click();
    if (video) {
      video.muted = true;
      video.play().catch(() => {});
    }

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
    let url = null;
    while (!dead) {
      url = findUrl();
      if (url) break;
      await sleep(pollMs);
    }
    if (!url) throw new Error('逾時：沒有出現字幕請求');

    const u = new URL(url);
    u.searchParams.set('fmt', 'json3');
    const j3 = await (await fetch(u.toString())).json();
    const evs = j3.events;
    if (!Array.isArray(evs) || !evs.length) throw new Error('json3 events 為空');

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
    if (!events.length) throw new Error('沒有可用的字幕片段');
    const last = events[events.length - 1];
    if (duration && last.t > duration * 1000) throw new Error('字幕時間超出影片長度，可能抓到錯的軌');
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
    if (video) video.pause();
    return raw;
  };

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    dead = true;
    clearTimeout(timer);
  }
};
