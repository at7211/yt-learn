/* isolated world。ytLearnUdemyCapture({expectLessonId, timeoutMs}) -> Promise<raw>；錯誤一律 throw 中文訊息。
   只重現頁面自己做的兩個請求：講座 API（same-origin）與字幕 VTT（credentials omit）；需先載入 vtt.js。
   expectLessonId 在起點與回傳前各核對一次網址（換課 → 「換課了，請回到原講座再試」）。
   所有等待都有期限；結束時清掉自己排的計時器。 */
globalThis.ytLearnUdemyCapture = async function (opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 25000;
  const POLL_MS = 200;
  const META_MS = 5000;
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
  const switched = () => new Error('換課了，請回到原講座再試');

  const lectureIdNow = () => {
    const m = /\/course\/[^/]+\/learn\/lecture\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  };
  const checkNav = () => {
    if (opts.expectLessonId && 'udemy.' + lectureIdNow() !== opts.expectLessonId) throw switched();
  };
  const pickCaption = (captions) => {
    const en = (Array.isArray(captions) ? captions : []).filter((c) => c
      && typeof c.url === 'string' && c.url.startsWith('https:')
      && typeof c.locale_id === 'string' && /^en([_-]|$)/i.test(c.locale_id));
    const named = (c) => typeof c.source === 'string' && c.source !== '' && c.source !== 'auto';
    return en.find(named) || en.find((c) => c.locale_id === 'en_US') || en[0] || null;
  };
  const withAbort = async (fn) => {
    const ac = new AbortController();
    later(() => ac.abort(), Math.max(1, left()));
    try {
      return await fn(ac.signal);
    } catch (e) {
      if (ac.signal.aborted) throw timeoutError();
      throw e;
    }
  };

  try {
    const lectureId = lectureIdNow();
    if (!lectureId) throw new Error('這不是 Udemy 講座頁');
    checkNav();

    /* (1) courseId */
    let courseId = null;
    try {
      const el = document.querySelector('.ud-app-loader[data-module-id="course-taking"][data-module-args]')
        || document.querySelector('.ud-app-loader[data-module-args]');
      const id = JSON.parse(el.getAttribute('data-module-args')).courseId;
      if (Number.isInteger(id) && id > 0) courseId = String(id);
    } catch (e) { /* 沒有 loader 或 JSON 壞掉 → 後備 */ }
    if (!courseId) {
      const re = new RegExp('/api-2\\.0/users/me/subscribed-courses/(\\d+)/lectures/' + lectureId + '/');
      for (;;) {
        for (const e of performance.getEntriesByType('resource')) {
          const m = re.exec(e.name);
          if (m) { courseId = m[1]; break; }
        }
        if (courseId || left() <= 0) break;
        await sleep(POLL_MS);
      }
      if (!courseId) throw new Error('找不到課程 id');
    }

    /* (2) 講座 API */
    const apiUrl = '/api-2.0/users/me/subscribed-courses/' + courseId + '/lectures/' + lectureId
      + '/?fields[lecture]=title,asset&fields[asset]=captions,length,title';
    const lecture = await withAbort(async (signal) => {
      const res = await fetch(apiUrl, { credentials: 'same-origin', signal });
      if (res.status === 401 || res.status === 403) throw new Error('請先登入 Udemy');
      if (!res.ok) throw new Error('講座資料下載失敗（HTTP ' + res.status + '）');
      let j;
      try { j = await res.json(); } catch (e) { throw new Error('講座資料格式不對'); }
      if (!j || typeof j.asset !== 'object' || !j.asset) throw new Error('講座資料格式不對');
      return j;
    });
    const asset = lecture.asset;

    /* (3) 挑英文字幕並抓 VTT */
    const cap = pickCaption(asset.captions);
    if (!cap) throw new Error('這堂課沒有英文字幕');
    const vttText = await withAbort(async (signal) => {
      const res = await fetch(cap.url, { credentials: 'omit', signal });
      if (!res.ok) throw new Error('字幕檔下載失敗（HTTP ' + res.status + '）');
      return await res.text();
    });
    if (!/^﻿?WEBVTT/.test(vttText)) throw new Error('字幕檔格式不對');
    if (typeof globalThis.ytLearnParseVtt !== 'function') throw new Error('vtt.js 未載入');
    let events = globalThis.ytLearnParseVtt(vttText).events;
    if (!events.length) throw new Error('字幕內容為空');

    /* (4) 影片長度 */
    const okNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
    let duration = okNum(asset.length) ? asset.length : 0;
    if (!duration) {
      const video = document.querySelector('[data-purpose="shaka-video-player"] video');
      if (video) {
        if (!okNum(video.duration)) {
          await new Promise((resolve) => {
            const done = () => { video.removeEventListener('loadedmetadata', done); resolve(); };
            video.addEventListener('loadedmetadata', done);
            later(done, Math.max(0, Math.min(META_MS, left())));
          });
        }
        if (okNum(video.duration)) duration = video.duration;
      }
      if (!duration) throw new Error('讀不到影片長度');
    }
    const beyond = events.filter((e) => e.t > duration * 1000).length;
    if (beyond > events.length / 2) throw new Error('字幕時間超出影片長度');
    if (beyond) events = events.filter((e) => e.t <= duration * 1000);

    /* (5) 組 raw */
    const docTitle = String(document.title || '');
    const channel = docTitle.replace(/^Course:\s*/, '').replace(/\s*\|\s*Udemy\s*$/, '').trim() || 'Udemy';
    const title = lecture.title || asset.title || docTitle;
    const kind = cap.source === 'auto' ? 'asr' : (typeof cap.source === 'string' && cap.source ? 'manual' : 'unknown');
    checkNav();
    return {
      videoId: 'udemy.' + lectureId,
      source: 'udemy',
      sourceUrl: location.origin + location.pathname,
      title,
      channel,
      duration,
      lang: 'en',
      kind,
      capturedAt: new Date().toISOString(),
      events,
    };
  } finally {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }
};
