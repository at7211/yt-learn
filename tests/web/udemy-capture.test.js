// Runs extension/vtt.js then extension/udemy-capture.js in a vm context with a fake Udemy page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const VTT_SRC = read('../../extension/vtt.js');
const CAP_SRC = read('../../extension/udemy-capture.js');
const LECTURE = JSON.parse(read('../fixtures/udemy_lecture.json'));
const VTT = read('../fixtures/udemy_small.vtt');
const PATH = '/course/30-days-of-python/learn/lecture/5800738';
const clone = (o) => JSON.parse(JSON.stringify(o));
const cap = (id, locale, source, url) => ({ id, locale_id: locale, ...(source === undefined ? {} : { source }), url: url === undefined ? `https://vtt-c.udemycdn.com/1/${locale}/${id}.vtt?x=1` : url });

function makePage({
  lecture = LECTURE, status = 200, vtt = VTT, vttStatus = 200, path = PATH,
  loader = '{"courseId":775330}', entries = [], videoDuration, switchAfterApi = false,
  title = 'Course: 30 Days of Python | Udemy',
} = {}) {
  const calls = { fetched: [] };
  const active = new Set();
  const listeners = {};
  const video = {
    duration: videoDuration,
    addEventListener(n, f) { listeners[n] = f; },
    removeEventListener(n) { delete listeners[n]; },
  };
  const location = { pathname: path, origin: 'https://www.udemy.com', href: 'https://www.udemy.com' + path };
  const ctx = {
    Promise, Date, JSON, RegExp, Number, Array, String, Error, console: { log() {} }, AbortController,
    setTimeout: (fn, ms) => { const id = setTimeout(() => { active.delete(id); fn(); }, ms); active.add(id); return id; },
    clearTimeout: (id) => { active.delete(id); clearTimeout(id); },
    location,
    document: {
      title,
      querySelector: (s) => {
        if (s === '.ud-app-loader[data-module-args]') return loader === null ? null : { getAttribute: () => loader };
        if (s === '[data-purpose="shaka-video-player"] video') return video;
        return null;
      },
    },
    performance: { getEntriesByType: (t) => (t === 'resource' ? entries.map((name) => ({ name })) : []) },
    fetch: async (url, init) => {
      calls.fetched.push({ url, init });
      if (url.startsWith('/api-2.0/')) {
        if (switchAfterApi) location.pathname = '/course/30-days-of-python/learn/lecture/999';
        return { ok: status >= 200 && status < 300, status, json: async () => clone(lecture) };
      }
      return { ok: vttStatus === 200, status: vttStatus, text: async () => vtt };
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(VTT_SRC, ctx);
  vm.runInContext(CAP_SRC, ctx);
  return {
    ctx, calls, active, video, listeners,
    run: (opts) => ctx.ytLearnUdemyCapture({ timeoutMs: 1000, ...opts }),
  };
}

async function rejection(p) {
  try { await p; } catch (e) { return String(e && e.message); }
  assert.fail('expected rejection');
}
const withCaps = (captions, extra = {}) => ({ ...clone(LECTURE), asset: { ...clone(LECTURE).asset, captions, ...extra } });

test('happy path: raw shape from fixtures', async () => {
  const page = makePage();
  const raw = JSON.parse(JSON.stringify(await page.run({ expectLessonId: 'udemy.5800738' })));
  assert.equal(raw.videoId, 'udemy.5800738');
  assert.equal(raw.source, 'udemy');
  assert.equal(raw.sourceUrl, 'https://www.udemy.com' + PATH);
  assert.equal(raw.title, 'Getting Help');
  assert.equal(raw.channel, '30 Days of Python');
  assert.equal(raw.duration, 403);
  assert.equal(raw.lang, 'en');
  assert.equal(raw.kind, 'asr');
  assert.match(raw.capturedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(raw.events.length, 6);
  for (const e of raw.events) assert.ok(Number.isInteger(e.t) && Number.isInteger(e.d));
  assert.deepEqual(raw.events[0], { t: 1000, d: 2000, segs: [[null, 'Welcome to the course.']] });
  assert.equal(page.calls.fetched.length, 2);
  assert.ok(page.calls.fetched[1].url.includes('/en_US/'));
  assert.equal(page.active.size, 0, 'no timers left');
});

test('fetch credentials: API same-origin with fields, VTT omit', async () => {
  const page = makePage();
  await page.run();
  const [api, vtt] = page.calls.fetched;
  assert.equal(api.init.credentials, 'same-origin');
  assert.equal(api.url, '/api-2.0/users/me/subscribed-courses/775330/lectures/5800738/?fields[lecture]=title,asset&fields[asset]=captions,length,title');
  assert.equal(vtt.init.credentials, 'omit');
  assert.ok(api.init.signal && vtt.init.signal);
});

test('manual en_GB preferred over auto en_US; kind manual', async () => {
  const page = makePage({ lecture: withCaps([cap(1, 'en_US', 'auto'), cap(2, 'en_GB', 'manual')]) });
  const raw = await page.run();
  assert.ok(page.calls.fetched[1].url.includes('/en_GB/'));
  assert.equal(raw.kind, 'manual');
});

test('only auto English -> asr; en_US preferred over other auto en', async () => {
  const page = makePage({ lecture: withCaps([cap(1, 'en_GB', 'auto'), cap(2, 'en_US', 'auto'), cap(3, 'fr_FR', 'manual')]) });
  const raw = await page.run();
  assert.ok(page.calls.fetched[1].url.includes('/en_US/'));
  assert.equal(raw.kind, 'asr');
});

test('missing source -> kind unknown', async () => {
  const page = makePage({ lecture: withCaps([cap(1, 'en_US')]) });
  assert.equal((await page.run()).kind, 'unknown');
});

test('empty captions and non-English only -> no English captions', async () => {
  assert.equal(await rejection(makePage({ lecture: withCaps([]) }).run()), '這堂課沒有英文字幕');
  assert.equal(await rejection(makePage({ lecture: withCaps([cap(1, 'tr_TR', 'auto'), cap(2, 'english_x', 'manual')]) }).run()), '這堂課沒有英文字幕');
});

test('English entry without https url skipped', async () => {
  const lecture = withCaps([cap(1, 'en_US', 'manual', null), cap(2, 'en_GB', 'manual', 'http://x/a.vtt'), cap(3, 'en_AU', 'auto')]);
  const page = makePage({ lecture });
  await page.run();
  assert.ok(page.calls.fetched[1].url.includes('/en_AU/'));
  const none = withCaps([cap(1, 'en_US', 'manual', 'http://x/a.vtt')]);
  assert.equal(await rejection(makePage({ lecture: none }).run()), '這堂課沒有英文字幕');
});

test('401/403 -> login error; other non-2xx -> HTTP status', async () => {
  assert.equal(await rejection(makePage({ status: 401 }).run()), '請先登入 Udemy');
  assert.equal(await rejection(makePage({ status: 403 }).run()), '請先登入 Udemy');
  assert.equal(await rejection(makePage({ status: 500 }).run()), '講座資料下載失敗（HTTP 500）');
});

test('VTT failures: HTTP error, not WEBVTT, empty events', async () => {
  assert.equal(await rejection(makePage({ vttStatus: 404 }).run()), '字幕檔下載失敗（HTTP 404）');
  assert.equal(await rejection(makePage({ vtt: '<html>nope' }).run()), '字幕檔格式不對');
  assert.equal(await rejection(makePage({ vtt: 'WEBVTT\n\n' }).run()), '字幕內容為空');
});

test('BOM before WEBVTT accepted (fixture has BOM)', async () => {
  assert.equal(VTT.charCodeAt(0), 0xFEFF);
  await makePage().run();
});

test('asset.length missing -> video loadedmetadata fallback', async () => {
  const lecture = withCaps(clone(LECTURE).asset.captions);
  delete lecture.asset.length;
  const page = makePage({ lecture });
  const p = page.run();
  setTimeout(() => { page.video.duration = 321.5; page.listeners.loadedmetadata(); }, 30);
  assert.equal((await p).duration, 321.5);
  assert.equal(page.active.size, 0);
});

test('asset.length missing and video duration already known / unavailable', async () => {
  const lecture = withCaps(clone(LECTURE).asset.captions);
  delete lecture.asset.length;
  assert.equal((await makePage({ lecture, videoDuration: 100 }).run()).duration, 100);
  assert.equal(await rejection(makePage({ lecture, videoDuration: NaN }).run({ timeoutMs: 50 })), '讀不到影片長度');
});

test('events beyond duration dropped; mostly beyond -> error', async () => {
  const lecture = withCaps(clone(LECTURE).asset.captions, { length: 7.5 });
  const raw = await makePage({ lecture }).run();
  assert.deepEqual(clone(raw.events.map((e) => e.t)), [1000, 3000, 5000, 7000, 7000]);
  const lecture2 = withCaps(clone(LECTURE).asset.captions, { length: 2 });
  assert.equal(await rejection(makePage({ lecture: lecture2 }).run()), '字幕時間超出影片長度');
});

test('lesson changed at start or before return -> 換課了', async () => {
  assert.equal(await rejection(makePage().run({ expectLessonId: 'udemy.111' })), '換課了，請回到原講座再試');
  assert.equal(await rejection(makePage({ switchAfterApi: true }).run({ expectLessonId: 'udemy.5800738' })), '換課了，請回到原講座再試');
});

test('courseId via Resource Timing when loader absent; none -> error', async () => {
  const entries = [
    'https://www.udemy.com/api-2.0/users/me/subscribed-courses/111/lectures/42/?x=1',
    'https://www.udemy.com/api-2.0/users/me/subscribed-courses/775330/lectures/5800738/?fields=a',
  ];
  const page = makePage({ loader: null, entries });
  await page.run();
  assert.ok(page.calls.fetched[0].url.includes('/subscribed-courses/775330/lectures/5800738/'));
  assert.equal(await rejection(makePage({ loader: null, entries: [entries[0]] }).run({ timeoutMs: 60 })), '找不到課程 id');
  assert.equal(await rejection(makePage({ loader: '{bad json', entries: [] }).run({ timeoutMs: 60 })), '找不到課程 id');
});

test('channel falls back to Udemy; title falls back to asset.title', async () => {
  const lecture = clone(LECTURE);
  delete lecture.title;
  const raw = await makePage({ lecture, title: 'Course: | Udemy' }).run();
  assert.equal(raw.channel, 'Udemy');
  assert.equal(raw.title, 'getting-help.mp4');
});
