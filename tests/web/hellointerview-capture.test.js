// Runs extension/vtt.js then extension/hellointerview-capture.js in a vm context with a fake HelloInterview page.
// Only ids, URLs and the hand-written tests/fixtures/hello_small.vtt; no caption text from any site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const VTT_SRC = read('../../extension/vtt.js');
const CAP_SRC = read('../../extension/hellointerview-capture.js');
const VTT = read('../fixtures/hello_small.vtt');
const IDS = JSON.parse(read('../fixtures/lesson_ids.json'));
const LEARN = 'https://www.hellointerview.com/learn/';
const PATH = 'system-design/patterns/queue-basics';
const HREF = LEARN + PATH;
const ID = 'hello.system-design.patterns.queue-basics';
const SIGNED = 'https://acct.r2.cloudflarestorage.com/hellointerview-files/premium-content/demo/en.vtt'
  + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc&X-Amz-Signature=deadbeef';
const VIDEO_SRC = 'https://acct.r2.cloudflarestorage.com/hellointerview-files/premium-content/demo/720p.mp4'
  + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=cafebabe';
const TITLE = 'Queue Basics for Interviews | Hello Interview System Design in a Hurry';
const CAPTIONS = 'track[kind="captions"]';
const LEAK = /r2\.cloudflarestorage|X-Amz/;
const clone = (o) => JSON.parse(JSON.stringify(o));

const track = (o = {}) => ({ kind: 'captions', label: 'English', srclang: '', src: SIGNED, ...o });
function makeVideo({ tracks = [track()], duration = 30 } = {}) {
  const listeners = {};
  const sel = (s) => {
    if (s !== CAPTIONS) throw new Error('unexpected selector ' + s);
    return tracks.filter((t) => t.kind === 'captions');
  };
  return {
    src: VIDEO_SRC, currentSrc: VIDEO_SRC, duration, tracks, listeners,
    querySelector: (s) => sel(s)[0] || null,
    querySelectorAll: (s) => sel(s),
    addEventListener(n, f) { listeners[n] = f; },
    removeEventListener(n, f) { if (listeners[n] === f) delete listeners[n]; },
  };
}

/* speed > 1 runs the page's clock (Date.now and its timers) faster than real time, so FIND_MS (5 s) waits stay short. */
function makePage({
  href = HREF, videos = [makeVideo()], title = TITLE, vtt = VTT, status = 200,
  fetchImpl, onFetch, speed = 1,
} = {}) {
  const calls = { fetched: [] };
  const active = new Set();
  const t0 = Date.now();
  const now = () => t0 + (Date.now() - t0) * speed;
  class VDate extends Date { static now() { return now(); } }
  /* hostname / pathname always look valid: the capture must judge the page by location.href alone. */
  const location = { href, hostname: 'www.hellointerview.com', pathname: '/learn/' + PATH, origin: 'https://www.hellointerview.com' };
  const state = { videos };
  const page = { calls, active, location, state, now };
  const ctx = {
    Promise, Date: VDate, JSON, RegExp, Number, Array, String, Error, console: { log() {} }, AbortController,
    setTimeout: (fn, ms) => { const id = setTimeout(() => { active.delete(id); fn(); }, (ms || 0) / speed); active.add(id); return id; },
    clearTimeout: (id) => { active.delete(id); clearTimeout(id); },
    location,
    document: {
      title,
      querySelectorAll: (s) => (s === 'video' ? state.videos.slice() : []),
      querySelector: () => null,
      contains: (n) => state.videos.includes(n),
    },
    fetch: async (url, init) => {
      calls.fetched.push({ url, init });
      if (onFetch) onFetch(page);
      if (fetchImpl) return fetchImpl(url, init);
      return { ok: status >= 200 && status < 300, status, text: async () => vtt };
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(VTT_SRC, ctx);
  vm.runInContext(CAP_SRC, ctx);
  page.ctx = ctx;
  page.run = (opts) => ctx.ytLearnHelloCapture({ timeoutMs: 1000, ...opts });
  return page;
}

async function rejection(p) {
  try { await p; } catch (e) { return String(e && e.message); }
  assert.fail('expected rejection');
}
const NO_EN = '這一頁沒有英文字幕';
const SWITCHED = '換頁了，請回到原課程頁再試';
const NOT_PAGE = '這不是 HelloInterview 課程頁';

test('happy path: raw shape, canonical sourceUrl, no R2 URL anywhere in the raw', async () => {
  const page = makePage({ href: HREF + '/?tab=notes#t=10' });
  const raw = clone(await page.run({ expectLessonId: ID }));
  assert.deepEqual(Object.keys(raw).sort(), ['capturedAt', 'channel', 'duration', 'events', 'kind', 'lang', 'source', 'sourceUrl', 'title', 'videoId']);
  assert.equal(raw.videoId, ID);
  assert.equal(raw.source, 'hellointerview');
  assert.equal(raw.sourceUrl, HREF);
  assert.equal(raw.title, 'Queue Basics for Interviews');
  assert.equal(raw.channel, 'HelloInterview');
  assert.equal(raw.duration, 30);
  assert.equal(raw.lang, 'en');
  assert.equal(raw.kind, 'unknown');
  assert.match(raw.capturedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(raw.events.map((e) => e.t), [500, 2000, 4000, 8000, 10000, 12500]);
  assert.deepEqual(raw.events[0], { t: 500, d: 1500, segs: [[null, 'Let us sketch a tiny queue service.']] });
  assert.equal(raw.events[2].segs[0][1], 'Each job carries a short retry counter.');
  const s = JSON.stringify(raw);
  assert.ok(!s.includes('r2.cloudflarestorage.com'), 'no R2 host in raw');
  assert.ok(!s.includes('X-Amz'), 'no signature in raw');
  assert.equal(page.active.size, 0);
});

test('fetch uses track.src with credentials omit, exactly one request', async () => {
  const page = makePage();
  await page.run();
  assert.equal(page.calls.fetched.length, 1);
  const [{ url, init }] = page.calls.fetched;
  assert.equal(url, SIGNED);
  assert.equal(init.credentials, 'omit');
  assert.ok(init.signal, 'abort signal passed');
});

test('video without a captions track is skipped; the first one with a track wins', async () => {
  const bare = makeVideo({ tracks: [track({ kind: 'chapters', src: 'https://x.example/ch.vtt' })] });
  const first = makeVideo({ tracks: [track({ src: 'https://cdn.example/first.vtt' })], duration: 40 });
  const second = makeVideo({ tracks: [track({ src: 'https://cdn.example/second.vtt' })] });
  const page = makePage({ videos: [bare, first, second] });
  const raw = await page.run();
  assert.equal(page.calls.fetched[0].url, 'https://cdn.example/first.vtt');
  assert.equal(raw.duration, 40);
});

test('track selection: srclang en / en-US accepted; empty srclang + label English accepted', async () => {
  for (const t of [
    { srclang: 'en', label: '' },
    { srclang: 'en-US', label: 'Captions' },
    { srclang: 'EN_gb', label: '' },
    { srclang: '', label: 'English' },
    { srclang: '', label: 'english (auto)' },
  ]) {
    const page = makePage({ videos: [makeVideo({ tracks: [track({ ...t, src: 'https://cdn.example/x.vtt' })] })] });
    await page.run();
    assert.equal(page.calls.fetched[0].url, 'https://cdn.example/x.vtt', JSON.stringify(t));
  }
  const page = makePage({ videos: [makeVideo({ tracks: [
    track({ srclang: 'de', label: 'Deutsch', src: 'https://cdn.example/de.vtt' }),
    track({ srclang: 'en', label: 'English', src: 'https://cdn.example/en.vtt' }),
  ] })] });
  await page.run();
  assert.equal(page.calls.fetched[0].url, 'https://cdn.example/en.vtt');
  assert.equal(await rejection(makePage({ videos: [makeVideo({ tracks: [track({ srclang: 'eng' })] })] }).run()), NO_EN);
});

test('French-only (srclang=fr) -> 這一頁沒有英文字幕', async () => {
  const page = makePage({ videos: [makeVideo({ tracks: [track({ srclang: 'fr', label: 'Français' })] })] });
  assert.equal(await rejection(page.run()), NO_EN);
  assert.equal(page.calls.fetched.length, 0);
});

test('srclang=fr + label English -> 這一頁沒有英文字幕 (srclang wins)', async () => {
  const page = makePage({ videos: [makeVideo({ tracks: [track({ srclang: 'fr', label: 'English' })] })] });
  assert.equal(await rejection(page.run()), NO_EN);
  assert.equal(page.calls.fetched.length, 0);
});

test('no label and no srclang -> 這一頁沒有英文字幕', async () => {
  const page = makePage({ videos: [makeVideo({ tracks: [track({ srclang: '', label: '' })] })] });
  assert.equal(await rejection(page.run()), NO_EN);
  assert.equal(page.calls.fetched.length, 0);
});

test('no video -> 這一頁沒有影片 after FIND_MS', async () => {
  const page = makePage({ videos: [], speed: 25 });
  const start = page.now();
  assert.equal(await rejection(page.run({ timeoutMs: 25000 })), '這一頁沒有影片');
  const waited = page.now() - start;
  assert.ok(waited >= 4900 && waited < 8000, 'waited ' + waited + ' ms (page clock)');
  assert.equal(page.active.size, 0);
});

test('video appears after 1 s (SPA) -> captured', async () => {
  const page = makePage({ videos: [], speed: 25 });
  setTimeout(() => { page.state.videos = [makeVideo()]; }, 1000 / 25);
  const start = page.now();
  const raw = await page.run({ timeoutMs: 25000, expectLessonId: ID });
  assert.equal(raw.videoId, ID);
  assert.ok(page.now() - start < 4000, 'did not wait for FIND_MS');
  assert.equal(page.active.size, 0);
});

test('video without captions track -> 找不到字幕', async () => {
  const page = makePage({ videos: [makeVideo({ tracks: [] }), makeVideo({ tracks: [track({ kind: 'subtitles' })] })], speed: 25 });
  assert.equal(await rejection(page.run({ timeoutMs: 25000 })), '找不到字幕');
  assert.equal(page.calls.fetched.length, 0);
});

test('non-https track src -> 找不到字幕', async () => {
  for (const src of ['http://cdn.example/en.vtt', 'blob:https://www.hellointerview.com/1', '', undefined]) {
    const page = makePage({ videos: [makeVideo({ tracks: [track({ src })] })] });
    assert.equal(await rejection(page.run()), '找不到字幕', String(src));
    assert.equal(page.calls.fetched.length, 0);
  }
});

test('403 -> 字幕連結已過期，請重新整理頁面再試', async () => {
  assert.equal(await rejection(makePage({ status: 403 }).run()), '字幕連結已過期，請重新整理頁面再試');
  assert.equal(await rejection(makePage({ status: 401 }).run()), '字幕連結已過期，請重新整理頁面再試');
});

test('500 -> 字幕檔下載失敗（HTTP 500）', async () => {
  assert.equal(await rejection(makePage({ status: 500 }).run()), '字幕檔下載失敗（HTTP 500）');
  assert.equal(await rejection(makePage({ status: 404 }).run()), '字幕檔下載失敗（HTTP 404）');
});

test('not WEBVTT -> 字幕檔格式不對', async () => {
  assert.equal(VTT.charCodeAt(0), 0xFEFF, 'fixture keeps its BOM');
  assert.equal(await rejection(makePage({ vtt: '<html>signed link expired</html>' }).run()), '字幕檔格式不對');
  assert.equal(await rejection(makePage({ vtt: '' }).run()), '字幕檔格式不對');
});

test('empty VTT -> 字幕內容為空', async () => {
  assert.equal(await rejection(makePage({ vtt: 'WEBVTT\n\n' }).run()), '字幕內容為空');
  assert.equal(await rejection(makePage({ vtt: '﻿WEBVTT\n\nNOTE only a note\n' }).run()), '字幕內容為空');
});

test('unexpected fetch rejection containing a signed URL -> fixed message, URL absent from the thrown message', async () => {
  const boom = () => new Error('Failed to fetch ' + SIGNED + ' (net::ERR_FAILED)');
  const cases = [
    makePage({ fetchImpl: async () => { throw boom(); } }),
    makePage({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => { throw boom(); } }) }),
    makePage({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => VTT }) }),
  ];
  cases[2].ctx.ytLearnParseVtt = () => { throw boom(); };
  for (const page of cases) {
    let err;
    try { await page.run(); } catch (e) { err = e; }
    assert.ok(err, 'rejected');
    assert.equal(err.message, '字幕讀取失敗');
    assert.ok(!LEAK.test(err.message) && !LEAK.test(String(err.stack || '')), 'no signed URL in message or stack');
    assert.equal(page.active.size, 0);
  }
});

test('unexpected exception outside the fetch -> 字幕讀取失敗', async () => {
  const LEAKY = 'https://x.r2.cloudflarestorage.com/?X-Amz-Signature=LEAK';
  const v1 = makeVideo();
  Object.defineProperty(v1, 'duration', { get() { throw new Error('media error at ' + LEAKY); } });
  const v2 = makeVideo();
  v2.querySelectorAll = () => { throw new Error('selector failed near ' + LEAKY); };
  for (const page of [makePage({ videos: [v1] }), makePage({ videos: [v2] })]) {
    let err;
    try { await page.run(); } catch (e) { err = e; }
    assert.ok(err, 'rejected');
    assert.equal(err.message, '字幕讀取失敗');
    for (const s of [err.message, String(err.stack || '')]) assert.ok(!/LEAK|X-Amz/.test(s), s);
    assert.equal(page.active.size, 0);
  }
});

test('vtt.js missing -> vtt.js 未載入', async () => {
  const page = makePage();
  vm.runInContext('delete globalThis.ytLearnParseVtt', page.ctx);
  assert.equal(vm.runInContext('typeof globalThis.ytLearnParseVtt', page.ctx), 'undefined');
  assert.equal(await rejection(page.run()), 'vtt.js 未載入');
  assert.equal(page.calls.fetched.length, 0, 'no signed request without vtt.js');
  assert.equal(page.active.size, 0);
});

test('abort -> 逾時訊息', async () => {
  const page = makePage({
    fetchImpl: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted: ' + url)));
    }),
  });
  let err;
  try { await page.run({ timeoutMs: 80 }); } catch (e) { err = e; }
  assert.equal(err.message, '逾時：0.08 秒內沒有取得字幕');
  assert.ok(!LEAK.test(err.message));
  assert.equal(page.active.size, 0);
});

test('duration from loadedmetadata; none -> 讀不到影片長度', async () => {
  const video = makeVideo({ duration: NaN });
  const page = makePage({ videos: [video] });
  const p = page.run();
  setTimeout(() => { video.duration = 321.5; video.listeners.loadedmetadata(); }, 30);
  assert.equal((await p).duration, 321.5);
  assert.equal(page.active.size, 0);
  assert.deepEqual(Object.keys(video.listeners), [], 'listener removed');
  for (const duration of [NaN, Infinity, 0, undefined]) {
    const v = makeVideo();
    v.duration = duration;
    const pg = makePage({ videos: [v] });
    assert.equal(await rejection(pg.run({ timeoutMs: 60 })), '讀不到影片長度', String(duration));
    assert.deepEqual(Object.keys(v.listeners), []);
    assert.equal(pg.active.size, 0);
  }
});

test('cues beyond duration: dropped, or refused when most are', async () => {
  const raw = await makePage({ videos: [makeVideo({ duration: 11 })] }).run();
  assert.deepEqual(clone(raw.events.map((e) => e.t)), [500, 2000, 4000, 8000, 10000]);
  assert.equal(await rejection(makePage({ videos: [makeVideo({ duration: 3 })] }).run()), '字幕時間超出影片長度');
});

test('path changes during fetch -> 換頁了，請回到原課程頁再試', async () => {
  const other = makePage({ onFetch: (p) => { p.location.href = LEARN + 'system-design/patterns/other-topic'; } });
  assert.equal(await rejection(other.run({ expectLessonId: ID })), SWITCHED);
  /* without expectLessonId the unchanged-href check still catches it */
  const noExpect = makePage({ onFetch: (p) => { p.location.href = LEARN + 'system-design/patterns/other-topic'; } });
  assert.equal(await rejection(noExpect.run()), SWITCHED);
  const query = makePage({ onFetch: (p) => { p.location.href = HREF + '?next=1'; } });
  assert.equal(await rejection(query.run({ expectLessonId: ID })), SWITCHED);
  const away = makePage({ onFetch: (p) => { p.location.href = 'https://www.hellointerview.com/dashboard'; } });
  assert.equal(await rejection(away.run({ expectLessonId: ID })), SWITCHED);
});

test('video replaced during fetch -> 換頁了，請回到原課程頁再試', async () => {
  const page = makePage({ onFetch: (p) => { p.state.videos = [makeVideo()]; } });
  assert.equal(await rejection(page.run({ expectLessonId: ID })), SWITCHED);
  assert.equal(page.location.href, HREF, 'href unchanged');
});

test('expectLessonId mismatch at start', async () => {
  const page = makePage();
  assert.equal(await rejection(page.run({ expectLessonId: 'hello.system-design.patterns.other-topic' })), SWITCHED);
  assert.equal(await rejection(makePage().run({ expectLessonId: 'udemy.123' })), SWITCHED);
  assert.equal(page.calls.fetched.length, 0);
});

test('page check uses location.href', async () => {
  const table = [
    [HREF, ID],
    [HREF + '/', ID],
    [HREF + '?x=1', ID],
    [HREF + '#transcript', ID],
    [HREF + '/?a=b#c', ID],
    [LEARN + 'system-design', 'hello.system-design'],
    ['http://www.hellointerview.com/learn/' + PATH, null],
    ['https://user@www.hellointerview.com/learn/' + PATH, null],
    ['https://www.hellointerview.com:444/learn/' + PATH, null],
    ['https://hellointerview.com/learn/' + PATH, null],
    ['https://app.hellointerview.com/learn/' + PATH, null],
    ['https://www.example.com/learn/' + PATH, null],
    ['https://www.hellointerview.com/practice/' + PATH, null],
    ['https://www.hellointerview.com/learn/', null],
    ['https://www.hellointerview.com/learn/courses/System-Design', null],
  ];
  for (const [href, want] of table) {
    const page = makePage({ href });
    if (want) assert.equal((await page.run()).videoId, want, href);
    else {
      assert.equal(await rejection(page.run()), NOT_PAGE, href);
      assert.equal(page.calls.fetched.length, 0, href);
    }
  }
});

test('path length boundary agrees with lesson_ids.json helloUrlLength', async () => {
  assert.ok(IDS.helloUrlLength.length >= 8);
  for (const [href, path] of IDS.helloUrlLength) {
    const page = makePage({ href });
    if (path) {
      const raw = await page.run();
      assert.equal(raw.videoId, 'hello.' + path.replace(/\//g, '.'), href);
      assert.equal(raw.sourceUrl, LEARN + path, href);
    } else {
      assert.equal(await rejection(page.run()), NOT_PAGE, href);
    }
  }
});

test('title from document.title without the site suffix (both observed formats); falls back to the last path segment', async () => {
  const title = async (t, href = HREF) => (await makePage({ title: t, href }).run()).title;
  assert.equal(await title('Queue Basics for Interviews | Hello Interview System Design in a Hurry'), 'Queue Basics for Interviews');
  assert.equal(await title('Practice Course | Hello Interview'), 'Practice Course');
  assert.equal(await title('Spaced Out  |  HelloInterview'), 'Spaced Out');
  assert.equal(await title('No Suffix Here'), 'No Suffix Here');
  assert.equal(await title('| Hello Interview'), 'queue basics');
  assert.equal(await title(''), 'queue basics');
  assert.equal(await title('', LEARN + 'system-design'), 'system design');
});

test('no timers left behind', async () => {
  const pages = [
    makePage(),
    makePage({ status: 500 }),
    makePage({ videos: [makeVideo({ tracks: [track({ srclang: 'fr' })] })] }),
    makePage({ fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('x')))) }),
    makePage({ videos: [makeVideo({ duration: NaN })] }),
    makePage({ onFetch: (p) => { p.state.videos = []; } }),
  ];
  for (const page of pages) {
    try { await page.run({ timeoutMs: 60 }); } catch (e) { /* outcome covered above */ }
    assert.equal(page.active.size, 0);
  }
});
