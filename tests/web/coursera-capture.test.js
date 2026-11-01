// Runs extension/vtt.js then extension/coursera-capture.js in a vm context with a fake Coursera lecture page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const VTT_SRC = read('../../extension/vtt.js');
const CAP_SRC = read('../../extension/coursera-capture.js');
const ID = 'coursera.machine-learning.iYR2y';
const PATH = '/learn/machine-learning/lecture/iYR2y/welcome';
const VTT_URL = 'https://www.coursera.org/api/subtitleAssetProxy.v1/abc?fileExtension=vtt';
const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.500\nWelcome to\n<i>machine</i> learning.\n\n'
  + 'NOTE a comment\n\n2\n00:04.000 --> 00:06.000\nLet\'s begin.\n\n3\n00:00:07.000 --> 00:00:08.000\n\n';
const EVENTS = [{ t: 1000, d: 2500, segs: [[null, 'Welcome to machine learning.']] }, { t: 4000, d: 2000, segs: [[null, "Let's begin."]] }];

const track = (srclang, src = VTT_URL) => ({ srclang, getAttribute: (k) => (k === 'src' ? src : null) });
const plain = (v) => JSON.parse(JSON.stringify(v));

function makePage({
  tracks = [], tracksAfterPlay = [], api = {}, vtt = VTT, vttStatus = 200, duration = 120, paused = true, muted = false, h1 = 'Welcome', hasVideo = true, path = PATH,
} = {}) {
  const calls = { play: 0, pause: 0, fetched: [], init: [], mutedAtPlay: null };
  const video = {
    paused, muted, duration, currentTime: 0,
    play() { calls.play++; calls.mutedAtPlay = this.muted; this.paused = false; this.currentTime += 2; return Promise.resolve(); },
    pause() { calls.pause++; this.paused = true; },
  };
  const location = { href: 'https://www.coursera.org' + path + '?t=1', pathname: path, origin: 'https://www.coursera.org' };
  const document = {
    title: 'Welcome | Coursera',
    querySelector: (sel) => (sel === 'video' ? (hasVideo ? video : null) : sel === 'h1' && h1 ? { textContent: h1 } : null),
    querySelectorAll: (sel) => (sel === 'track' ? (calls.play ? [...tracks, ...tracksAfterPlay] : tracks) : []),
  };
  const fetch = async (url, init) => {
    calls.fetched.push(url);
    calls.init.push(init);
    const hit = Object.keys(api).find((k) => url.includes(k));
    if (hit && api[hit] === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (hit) return api[hit] === 403 ? { ok: false, status: 403 } : { ok: true, status: 200, json: async () => api[hit] };
    if (url === VTT_URL) return { ok: vttStatus === 200, status: vttStatus, text: async () => vtt };
    return { ok: false, status: 404 };
  };
  const ctx = { document, location, fetch, URL, AbortController, console: { log() {} }, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(VTT_SRC, ctx);
  vm.runInContext(CAP_SRC, ctx);
  return { ctx, calls, video, location };
}

const capture = (p, over = {}) => p.ctx.ytLearnCourseraCapture({ expectLessonId: ID, timeoutMs: 400, pollMs: 5, ...over });
const noApi = { onDemandCourses: 403 };

test('no API answer, a <track> on the page: English preferred, playback untouched', async () => {
  const p = makePage({ tracks: [track('zh-CN', '/api/other'), track('en')], api: noApi });
  const raw = await capture(p);
  assert.deepEqual(plain(raw), {
    videoId: ID, source: 'coursera', sourceUrl: 'https://www.coursera.org' + PATH, title: 'Welcome', channel: 'machine learning',
    duration: 120, lang: 'en', kind: 'unknown', capturedAt: raw.capturedAt, events: EVENTS,
  });
  assert.match(raw.capturedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(p.calls.fetched.at(-1), VTT_URL);
  assert.equal(p.calls.init.at(-1).credentials, 'same-origin');
  assert.equal(p.calls.play, 0);
});

test('a <track> without srclang counts, after an English one', async () => {
  const none = track('', VTT_URL);
  assert.equal((await capture(makePage({ tracks: [none], api: noApi }))).events.length, 2);
  const p = makePage({ tracks: [track('', '/api/other'), track('en')], api: noApi });
  await capture(p);
  assert.equal(p.calls.fetched.at(-1), VTT_URL);
});

test('a relative <track> src is resolved against the page; en-US counts as English', async () => {
  const raw = await capture(makePage({ api: noApi, tracks: [track('en-US', '/api/subtitleAssetProxy.v1/abc?fileExtension=vtt')] }));
  assert.equal(raw.events.length, 2);
});

const LECTURE_API = {
  onDemandCourses: { elements: [{ id: 'COURSE' }] },
  onDemandLectureVideos: { linked: { 'onDemandVideos.v1': [{ subtitlesVtt: { 'zh-CN': '/nope', en: '/api/subtitleAssetProxy.v1/abc?fileExtension=vtt' } }] } },
};

test('the lecture API wins over a <track> that may still be the previous lecture\'s', async () => {
  const p = makePage({ api: LECTURE_API, tracks: [track('en', '/api/previous-lecture.vtt')] });
  await capture(p);
  assert.equal(p.calls.fetched.at(-1), VTT_URL);
  assert.ok(!p.calls.fetched.some((u) => u.includes('previous-lecture')));
});

test('a hung API leaves time for the fallbacks', async () => {
  const p = makePage({ api: { onDemandCourses: 'hang' }, tracks: [track('en')] });
  assert.equal((await capture(p, { apiMs: 20 })).events.length, 2);
});

test('the lecture API: English only, no playback', async () => {
  const p = makePage({ api: LECTURE_API });
  const raw = await capture(p);
  assert.equal(raw.lang, 'en');
  assert.equal(p.calls.play, 0);
  assert.equal(p.calls.fetched.length, 3);
  assert.ok(p.calls.fetched[1].includes('/api/onDemandLectureVideos.v1/COURSE~iYR2y?'));
  assert.equal(p.calls.fetched[2], VTT_URL);
});

test('no <track> and the API refuses: muted playback brings the track in, then state is restored', async () => {
  const p = makePage({ api: noApi, tracksAfterPlay: [track('en')] });
  const raw = await capture(p);
  assert.equal(raw.events.length, 2);
  assert.equal(p.calls.play, 1);
  assert.equal(p.calls.mutedAtPlay, true);
  assert.equal(p.calls.pause, 1);
  assert.equal(p.video.muted, false);
  assert.equal(p.video.currentTime, 0, 'back where it was');
});

test('a video the viewer is already watching is not paused or muted', async () => {
  const p = makePage({ paused: false, api: noApi });
  await assert.rejects(capture(p), /逾時/);
  assert.equal(p.calls.play, 0);
  assert.equal(p.calls.pause, 0);
  assert.equal(p.video.muted, false);
});

test('only non-English captions: times out naming the reason, playback restored', async () => {
  const p = makePage({ tracks: [track('zh-CN')], api: noApi, muted: true });
  await assert.rejects(capture(p), /逾時.*沒有英文字幕/);
  assert.equal(p.calls.pause, 1);
  assert.equal(p.video.muted, true);
});

test('the viewer moves to another lecture mid-capture', async () => {
  const p = makePage({ api: noApi });
  const run = capture(p);
  p.location.pathname = '/learn/machine-learning/lecture/ZZZZZ/other';
  await assert.rejects(run, /換課了，請回到原講座再試/);
});

test('a page that already moved on, and a page that is no lecture, are refused before anything runs', async () => {
  const moved = makePage({ path: '/learn/machine-learning/lecture/ZZZZZ/other', tracks: [track('en')] });
  await assert.rejects(capture(moved), /換課了/);
  assert.deepEqual(moved.calls.fetched, []);
  await assert.rejects(capture(makePage({ path: '/browse' })), /這不是 Coursera 影片頁/);
});

test('no video element until the deadline', async () => {
  await assert.rejects(capture(makePage({ hasVideo: false })), /找不到 Coursera 影片播放器/);
});

test('cues past the end of the video are dropped; a track mostly past the end is refused', async () => {
  const two = makePage({ tracks: [track('en')], duration: 5 });
  assert.deepEqual(plain((await capture(two)).events).map((e) => e.t), [1000, 4000]);
  const late = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfine\n\n00:01:00.000 --> 00:01:01.000\nlate\n\n00:02:00.000 --> 00:02:01.000\nlater\n';
  await assert.rejects(capture(makePage({ tracks: [track('en')], duration: 5, vtt: late })), /字幕時間超出影片長度/);
});

test('duration falls back to the last cue while the video has no metadata', async () => {
  assert.equal((await capture(makePage({ tracks: [track('en')], duration: NaN }))).duration, 6);
});

test('title falls back to the page title without the site suffix, then to the item id', async () => {
  assert.equal((await capture(makePage({ tracks: [track('en')], h1: '' }))).title, 'Welcome');
  const p = makePage({ tracks: [track('en')], h1: '' });
  p.ctx.document.title = '';
  assert.equal((await capture(p)).title, 'iYR2y');
});

test('a VTT that starts with a BOM is accepted', async () => {
  assert.equal((await capture(makePage({ tracks: [track('en')], vtt: '\uFEFF' + VTT }))).events.length, 2);
});

test('a failed download, a file that is no VTT and an empty one are refused', async () => {
  await assert.rejects(capture(makePage({ tracks: [track('en')], vttStatus: 500 })), /字幕檔下載失敗（HTTP 500）/);
  await assert.rejects(capture(makePage({ tracks: [track('en')], vtt: '<html>' })), /字幕檔格式不對/);
  await assert.rejects(capture(makePage({ tracks: [track('en')], vtt: 'WEBVTT\n' })), /字幕內容為空/);
});
