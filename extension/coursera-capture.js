/* isolated world。ytLearnCourseraCapture({expectLessonId, timeoutMs, pollMs, apiMs}) -> Promise<raw>；錯誤一律 throw 中文訊息。
   英文字幕網址依序找：(1) onDemandLectureVideos API（以 item id 查，不會拿到上一講的字幕）
   (2) 頁面上的 <track>（Coursera 開始播放才會掛上；換課當下可能還是上一講的）
   (3) 靜音播放幾秒讓 <track> 掛上，之後還原靜音、播放狀態與播放位置。需先載入 vtt.js。
   expectLessonId 在起點、等待中與回傳前都核對網址（換課 → 「換課了，請回到原講座再試」）。
   所有等待都有期限；結束時清掉自己排的計時器。 */
globalThis.ytLearnCourseraCapture = async function (opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 25000;
  const pollMs = opts.pollMs || 500;
  const apiMs = opts.apiMs || 5000; // each API request: a hung API must leave time for the fallbacks
  const PLAY_WINDOW_MS = 3000;
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const sleep = (ms) => new Promise((r) => later(r, Math.max(0, Math.min(ms, left()))));
  const log = (...a) => console.log('[yt-learn]', ...a);
  const timeoutError = () => new Error('逾時：' + timeoutMs / 1000 + ' 秒內沒有取得字幕');

  const route = () => {
    const m = /^\/learn\/([A-Za-z0-9_-]{1,120})\/lecture\/([A-Za-z0-9_-]{1,32})(?:\/|$)/.exec(location.pathname);
    return m ? { slug: m[1], itemId: m[2] } : null;
  };
  const lessonIdNow = () => {
    const r = route();
    return r ? 'coursera.' + r.slug + '.' + r.itemId : null;
  };
  const checkNav = () => {
    if (opts.expectLessonId && lessonIdNow() !== opts.expectLessonId) throw new Error('換課了，請回到原講座再試');
  };
  const withAbort = async (fn, ms = left()) => {
    const ac = new AbortController();
    later(() => ac.abort(), Math.max(1, Math.min(ms, left())));
    try {
      return await fn(ac.signal);
    } catch (e) {
      if (ac.signal.aborted) throw timeoutError();
      throw e;
    }
  };

  const isEnglish = (lang) => typeof lang === 'string' && /^en([_-]|$)/i.test(lang);
  const absolute = (src) => new URL(src, location.href).href;
  const fromTracks = () => {
    const tracks = [...document.querySelectorAll('track')].filter((x) => x.getAttribute('src'));
    const t = tracks.find((x) => isEnglish(x.srclang)) || tracks.find((x) => !x.srclang); // no srclang: the course's own language
    return t ? absolute(t.getAttribute('src')) : null;
  };
  const getJson = (path) => withAbort(async (signal) => {
    const res = await fetch(path, { credentials: 'same-origin', signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }, apiMs);
  const fromApi = async ({ slug, itemId }) => {
    try {
      const course = await getJson('/api/onDemandCourses.v1?q=slug&slug=' + encodeURIComponent(slug));
      const courseId = course?.elements?.[0]?.id;
      if (!courseId) return null;
      const lecture = await getJson('/api/onDemandLectureVideos.v1/' + encodeURIComponent(courseId + '~' + itemId)
        + '?includes=video&fields=onDemandVideos.v1(sources,subtitles,subtitlesVtt,subtitlesTxt)');
      const subs = lecture?.linked?.['onDemandVideos.v1']?.[0]?.subtitlesVtt;
      const lang = subs ? Object.keys(subs).find(isEnglish) : null;
      return lang ? absolute(subs[lang]) : null;
    } catch (e) {
      log('api failed', e && e.message);
      return null;
    }
  };

  let video = null;
  let played = false;
  let playbackEnded = false;
  let restoreMuted = null;
  let restoreTime = 0;
  const endPlayback = () => {
    if (!played || playbackEnded) return;
    playbackEnded = true;
    try { video.pause(); } catch (e) { log('ignored', e); }
    if (restoreMuted !== null) video.muted = restoreMuted;
    video.currentTime = restoreTime;
  };

  try {
    const lecture = route();
    if (!lecture) throw new Error('這不是 Coursera 影片頁');
    checkNav();

    /* (1) 等影片元素出現 */
    for (;;) {
      video = document.querySelector('.video-js video') || document.querySelector('video');
      if (video) break;
      if (left() <= 0) throw new Error('找不到 Coursera 影片播放器');
      await sleep(pollMs);
      checkNav();
    }

    /* (2) 找英文字幕：API → track → 靜音播放等 track 掛上 */
    let subUrl = await fromApi(lecture);
    checkNav();
    subUrl = subUrl || fromTracks();
    if (!subUrl) {
      if (video.paused) {
        restoreMuted = video.muted;
        restoreTime = video.currentTime;
        video.muted = true;
        played = true;
        Promise.resolve(video.play()).catch((e) => log('ignored', e));
        later(endPlayback, PLAY_WINDOW_MS);
      }
      for (;;) {
        checkNav();
        subUrl = fromTracks();
        if (subUrl) break;
        if (left() <= 0) throw new Error('逾時：' + timeoutMs / 1000 + ' 秒內沒有取得字幕，這支影片可能沒有英文字幕');
        await sleep(pollMs);
      }
    }
    endPlayback();

    /* (3) 下載 VTT */
    const vttText = await withAbort(async (signal) => {
      const res = await fetch(subUrl, { credentials: 'same-origin', signal });
      if (!res.ok) throw new Error('字幕檔下載失敗（HTTP ' + res.status + '）');
      return await res.text();
    });
    if (!/^﻿?WEBVTT/.test(vttText)) throw new Error('字幕檔格式不對');
    if (typeof globalThis.ytLearnParseVtt !== 'function') throw new Error('vtt.js 未載入');
    let events = globalThis.ytLearnParseVtt(vttText).events;
    if (!events.length) throw new Error('字幕內容為空');

    /* (4) 影片長度：播放器沒有 metadata 時退回最後一句的結束時間 */
    const last = events[events.length - 1];
    const duration = Math.ceil(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (last.t + last.d) / 1000);
    const beyond = events.filter((e) => e.t > duration * 1000).length;
    if (beyond > events.length / 2) throw new Error('字幕時間超出影片長度');
    if (beyond) events = events.filter((e) => e.t <= duration * 1000);

    /* (5) 組 raw */
    const title = (document.querySelector('h1')?.textContent || document.title || '').replace(/\s*\|\s*Coursera\s*$/i, '').trim();
    checkNav();
    return {
      videoId: lessonIdNow(),
      source: 'coursera',
      sourceUrl: location.origin + location.pathname,
      title: title || lecture.itemId,
      channel: lecture.slug.replace(/-/g, ' '),
      duration,
      lang: 'en',
      kind: 'unknown',
      capturedAt: new Date().toISOString(),
      events,
    };
  } finally {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    endPlayback();
  }
};
