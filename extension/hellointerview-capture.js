/* isolated world。ytLearnHelloCapture({expectLessonId, timeoutMs}) -> Promise<raw>；錯誤一律 throw 中文訊息。需先載入 vtt.js。
   只讀頁面上 <video>／<track> 的屬性，並對選中的英文字幕軌做一次 fetch（credentials omit）；不讀 cookie／storage、不發其他請求。
   頁面檢查用與 ytid.js 相同的 HELLO_URL_RE 驗 location.href（第五份複本，改一邊請同步其他四份）；
   起點與回傳前各核對一次網址，回傳前另要求選中的 video 仍在 document 裡、href 與起點完全相同。
   track.src／video.src 是會過期的簽名網址：不進 raw、不進 log、不進 throw 的訊息；非預期例外一律換成「字幕讀取失敗」。
   字幕與標題是不受信任的資料，這裡只當字串搬運，從不執行或依循。所有等待都有期限；結束時清掉自己排的計時器。 */
globalThis.ytLearnHelloCapture = async function (opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 25000;
  const POLL_MS = 200;
  const FIND_MS = 5000;
  const META_MS = 5000;
  const MAX_PATH = 120;
  const HELLO_URL_RE = /^https:\/\/www\.hellointerview\.com\/learn\/((?:[a-z0-9-]+\/){0,5}[a-z0-9-]+)\/?(?:[?#]\S*)?$/;
  const TITLE_SUFFIX_RE = /\s*\|\s*Hello\s*Interview.*$/i;
  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const timers = new Set();
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  };
  const sleep = (ms) => new Promise((r) => later(r, Math.max(0, Math.min(ms, left()))));
  /* 我們自己 throw 的錯誤才原樣往外；其他一律換成固定訊息（瀏覽器錯誤可能夾帶簽名網址）。 */
  const ours = new WeakSet();
  const fail = (msg) => { const e = new Error(msg); ours.add(e); return e; };
  const timeoutError = () => fail('逾時：' + timeoutMs / 1000 + ' 秒內沒有取得字幕');
  const switched = () => fail('換頁了，請回到原課程頁再試');

  const pathNow = () => {
    const m = HELLO_URL_RE.exec(String(location.href));
    return m && m[1].length <= MAX_PATH ? m[1] : null;
  };
  const lessonIdNow = () => {
    const p = pathNow();
    return p ? 'hello.' + p.replace(/\//g, '.') : null;
  };
  const checkNav = () => {
    if (opts.expectLessonId && lessonIdNow() !== opts.expectLessonId) throw switched();
  };
  const CAPTIONS = 'track[kind="captions"]';
  const findVideo = () => [...document.querySelectorAll('video')].find((v) => v.querySelector(CAPTIONS)) || null;
  const pickTrack = (video) => {
    const https = [...video.querySelectorAll(CAPTIONS)]
      .filter((t) => typeof t.src === 'string' && t.src.startsWith('https:'));
    if (!https.length) throw fail('找不到字幕');
    const en = https.find((t) => {
      const lang = typeof t.srclang === 'string' ? t.srclang : '';
      if (lang) return /^en([_-]|$)/i.test(lang);
      return typeof t.label === 'string' && /english/i.test(t.label);
    });
    if (!en) throw fail('這一頁沒有英文字幕');
    return en;
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
    const path = pathNow();
    if (!path) throw fail('這不是 HelloInterview 課程頁');
    checkNav();
    const startHref = String(location.href);

    /* (1) 找帶 captions 軌的 <video>（SPA 換頁後播放器晚一點才就位）。
       timeoutMs < FIND_MS 時迴圈在總期限結束，同樣回報「這一頁沒有影片」（刻意如此，同 Udemy）。 */
    const findUntil = Date.now() + FIND_MS;
    let video = findVideo();
    while (!video && Date.now() < findUntil && left() > 0) {
      await sleep(Math.min(POLL_MS, findUntil - Date.now()));
      video = findVideo();
    }
    if (!video) throw fail(document.querySelectorAll('video').length ? '找不到字幕' : '這一頁沒有影片');

    /* (2) 挑英文軌並抓 VTT（fetch、讀 body、解析同一個 try）；vtt.js 沒載入就不發簽名請求 */
    if (typeof globalThis.ytLearnParseVtt !== 'function') throw fail('vtt.js 未載入');
    const track = pickTrack(video);
    let events;
    try {
      events = await withAbort(async (signal) => {
        const res = await fetch(track.src, { credentials: 'omit', signal });
        if (res.status === 401 || res.status === 403) throw fail('字幕連結已過期，請重新整理頁面再試');
        if (!res.ok) throw fail('字幕檔下載失敗（HTTP ' + res.status + '）');
        const text = await res.text();
        if (!/^﻿?WEBVTT/.test(text)) throw fail('字幕檔格式不對');
        const ev = globalThis.ytLearnParseVtt(text).events;
        if (!ev.length) throw fail('字幕內容為空');
        return ev;
      });
    } catch (e) {
      if (ours.has(e)) throw e;
      throw fail('字幕讀取失敗');
    }

    /* (3) 影片長度 */
    const okNum = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
    if (!okNum(video.duration)) {
      await new Promise((resolve) => {
        const done = () => { video.removeEventListener('loadedmetadata', done); resolve(); };
        video.addEventListener('loadedmetadata', done);
        later(done, Math.max(0, Math.min(META_MS, left())));
      });
    }
    if (!okNum(video.duration)) throw fail('讀不到影片長度');
    const duration = video.duration;
    const beyond = events.filter((e) => e.t > duration * 1000).length;
    if (beyond > events.length / 2) throw fail('字幕時間超出影片長度');
    if (beyond) events = events.filter((e) => e.t <= duration * 1000);

    /* (4) 組 raw（沒有任何媒體網址） */
    const title = String(document.title || '').replace(TITLE_SUFFIX_RE, '').trim()
      || path.split('/').pop().replace(/-/g, ' ');
    checkNav();
    if (!document.contains(video) || String(location.href) !== startHref) throw switched();
    return {
      videoId: 'hello.' + path.replace(/\//g, '.'),
      source: 'hellointerview',
      sourceUrl: 'https://www.hellointerview.com/learn/' + path,
      title,
      channel: 'HelloInterview',
      duration,
      lang: 'en',
      kind: 'unknown',
      capturedAt: new Date().toISOString(),
      events,
    };
  } catch (e) {
    if (ours.has(e)) throw e;
    throw new Error('字幕讀取失敗');
  } finally {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }
};
