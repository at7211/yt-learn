// yt-learn capture. Paste into the DevTools console of a youtube.com/watch tab.
(async () => {
  const SERVER = 'http://127.0.0.1:8765';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('[yt-learn]', ...a);
  let raw = null;

  function showPanel(text, reason) {
    console.warn('[yt-learn]', reason);
    document.getElementById('yt-learn-panel')?.remove();
    const p = document.createElement('div');
    p.id = 'yt-learn-panel';
    p.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:360px;padding:10px;' +
      'background:#fff;color:#111;border:1px solid #888;border-radius:8px;font:13px/1.4 sans-serif;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.4)';
    const msg = document.createElement('div');
    msg.textContent = reason + ' 請複製下方內容，貼到 http://127.0.0.1:8765 的匯入框。';
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    ta.style.cssText = 'width:100%;height:120px;margin:6px 0;box-sizing:border-box';
    const btn = document.createElement('button');
    btn.textContent = '複製';
    btn.onclick = async () => {
      ta.select();
      try { await navigator.clipboard.writeText(ta.value); btn.textContent = '已複製'; } catch (e) { /* manual copy is fine */ }
    };
    p.append(msg, ta, btn);
    document.body.appendChild(p);
    ta.focus();
    ta.select();
  }

  try {
    // (1) video id + caption tracks
    const pr = window.ytInitialPlayerResponse;
    const videoId = pr?.videoDetails?.videoId;
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!videoId || !tracks?.length) { console.warn('[yt-learn] 此影片沒有字幕軌，結束。'); return; }
    const track = tracks.find((t) => t.languageCode === 'en') || tracks[0];
    const duration = Number(pr.videoDetails.lengthSeconds) || 0;

    // (2) turn CC on, play 2s, pause
    const video = document.querySelector('video');
    const ccBtn = document.querySelector('.ytp-subtitles-button');
    if (ccBtn && ccBtn.getAttribute('aria-pressed') !== 'true') ccBtn.click();
    if (video) {
      await video.play().catch(() => {});
      await sleep(2000);
      video.pause();
    }

    // (3) latest timedtext request for this video, not a translation
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
    let url = findUrl();
    if (!url) { await sleep(1000); url = findUrl(); }
    if (!url) { console.warn('[yt-learn] 請手動開啟 CC 再執行'); return; }

    // (4) refetch as json3
    const u = new URL(url);
    u.searchParams.set('fmt', 'json3');
    const j3 = await (await fetch(u.toString())).json();
    const evs = j3.events;
    if (!Array.isArray(evs) || !evs.length) throw new Error('json3 events 為空');

    // (5) build raw
    const events = [];
    for (const e of evs) {
      if (!e.segs) continue;
      const segs = [];
      // json3 encodes tOffsetMs=0 by omission: if any seg in the event has an offset,
      // a missing one means 0; if none do (manual captions), there is no word timing.
      const eventHasAnyOffset = e.segs.some((s) => typeof s.tOffsetMs === 'number');
      for (const s of e.segs) {
        const text = (s.utf8 ?? '').replace(/\n/g, '').trim();
        if (!text) continue;
        segs.push([s.tOffsetMs ?? (eventHasAnyOffset ? 0 : null), text]);
      }
      if (!segs.length) continue;
      events.push({ t: e.tStartMs ?? 0, d: e.dDurationMs ?? 0, segs });
    }
    if (!events.length) throw new Error('沒有可用的字幕片段');
    const last = events[events.length - 1];
    if (duration && last.t > duration * 1000) throw new Error('字幕時間超出影片長度，可能抓到錯的軌');
    const brands = navigator.userAgentData?.brands || [];
    const chromeBrand = brands.find((b) => b.brand === 'Google Chrome') || brands.find((b) => b.brand === 'Chromium');
    raw = {
      videoId,
      title: pr.videoDetails.title,
      channel: pr.videoDetails.author,
      duration,
      lang: u.searchParams.get('lang') || track.languageCode,
      kind: (u.searchParams.get('kind') || track.kind) === 'asr' ? 'asr' : 'manual',
      capturedAt: new Date().toISOString(),
      chrome: chromeBrand?.version || '',
      events,
    };
    if (!raw.chrome) delete raw.chrome;

    // (6) POST with 5s timeout
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    let res;
    try {
      res = await fetch(SERVER + '/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(raw),
        signal: ac.signal,
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error('server 回應 ' + res.status);
    const out = await res.json();
    log('OK', videoId, out.events, 'events. 下一步：', out.next);
  } catch (err) {
    // (7) fallback panel
    if (raw) showPanel(JSON.stringify(raw), '無法送到本機 server（' + (err?.message || err) + '）。');
    else console.warn('[yt-learn] 擷取失敗：', err);
  }
})();
