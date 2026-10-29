// Runs extension/capture.js in a fresh vm context with a fake YouTube page.
// Mismatch policy (documented in capture.js): a player response for another
// video is treated as "not ready"; at the deadline the error is
// 播放器資料與網址不一致 if another id was seen, otherwise 逾時.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/capture.js', import.meta.url), 'utf8');
const VID = 'puh91fohvTA';
const TT = (q) => `https://www.youtube.com/api/timedtext?v=${VID}&lang=en${q || ''}`;

function playerResponse(over = {}) {
  return {
    videoDetails: { videoId: VID, title: 'T', author: 'A', lengthSeconds: '120' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: 'fr', kind: '' }, { languageCode: 'en', kind: 'asr' },
    ] } },
    ...over,
  };
}

const JSON3 = { events: [
  { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello' }, { utf8: ' world', tOffsetMs: 400 }] },
  { tStartMs: 1000, dDurationMs: 500 },
  { tStartMs: 1500, dDurationMs: 800, segs: [{ utf8: '\n' }] },
  { tStartMs: 2000, dDurationMs: 900, segs: [{ utf8: 'again' }] },
] };

function makePage({
  readyAfter = 0, pr = () => playerResponse(), otherIdUntilReady = false,
  timedtextAfter = 0, entries = () => [TT('&kind=asr')], json3 = JSON3,
  videoPaused = false, videoMuted = false, ccPressed = 'false', playRejects = false,
} = {}) {
  const calls = { play: 0, pause: 0, cc: 0, fetched: [], mutedAtPlay: null, prPolls: 0, perfPolls: 0, cleared: 0 };
  const active = new Set();
  const video = {
    paused: videoPaused,
    muted: videoMuted,
    play() { calls.play++; calls.mutedAtPlay = this.muted; this.paused = false; return playRejects ? Promise.reject(new Error('no')) : Promise.resolve(); },
    pause() { calls.pause++; this.paused = true; },
  };
  const cc = {
    pressed: ccPressed,
    getAttribute(n) { return n === 'aria-pressed' ? this.pressed : null; },
    click() { calls.cc++; this.pressed = this.pressed === 'true' ? 'false' : 'true'; },
  };
  const player = {
    getPlayerResponse() {
      calls.prPolls++;
      if (calls.prPolls > readyAfter) return pr();
      return otherIdUntilReady ? playerResponse({ videoDetails: { videoId: 'zzzzzzzzzzz' } }) : undefined;
    },
  };
  const ctx = {
    URL, AbortController, Promise, Date, console: { log() {} },
    setTimeout: (fn, ms) => { const id = setTimeout(() => { active.delete(id); fn(); }, ms); active.add(id); return id; },
    clearTimeout: (id) => { active.delete(id); clearTimeout(id); },
    location: { href: 'https://www.youtube.com/watch?v=' + VID },
    navigator: { userAgentData: { brands: [{ brand: 'Google Chrome', version: '155' }] } },
    document: {
      getElementById: (id) => (id === 'movie_player' ? player : null),
      querySelector: (s) => (s === 'video' ? video : s === '.ytp-subtitles-button' ? cc : null),
    },
    performance: {
      getEntriesByType(t) {
        if (t !== 'resource') return [];
        calls.perfPolls++;
        const base = [{ name: 'https://www.youtube.com/s/player/base.js' }];
        return calls.perfPolls > timedtextAfter ? base.concat(entries(calls).map((name) => ({ name }))) : base;
      },
      clearResourceTimings() { calls.cleared++; },
    },
    fetch: async (url) => {
      calls.fetched.push(url);
      const body = typeof json3 === 'function' ? json3(calls.fetched.length, url) : json3;
      return body === 404 ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => body };
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, calls, video, cc, active, run: (opts) => ctx.ytLearnCapture({ expectVideoId: VID, pollMs: 10, timeoutMs: 2000, ...opts }) };
}

async function rejection(p) {
  try { await p; } catch (e) { return String(e && e.message); }
  assert.fail('expected rejection');
}

test('success after delayed readiness: raw shape, ASR missing offset -> 0', async () => {
  const page = makePage({ readyAfter: 3, timedtextAfter: 2 });
  const raw = JSON.parse(JSON.stringify(await page.run()));
  assert.equal(raw.videoId, VID);
  assert.equal(raw.title, 'T');
  assert.equal(raw.channel, 'A');
  assert.equal(raw.duration, 120);
  assert.equal(raw.lang, 'en');
  assert.equal(raw.kind, 'asr');
  assert.equal(raw.chrome, '155');
  assert.match(raw.capturedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(raw.events.length, 2);
  assert.deepEqual(raw.events[0], { t: 0, d: 1000, segs: [[0, 'hello'], [400, 'world']] });
  assert.deepEqual(raw.events[1], { t: 2000, d: 900, segs: [[0, 'again']] });
  assert.ok(page.calls.prPolls > 3);
  assert.equal(page.calls.fetched.length, 1);
  assert.equal(new URL(page.calls.fetched[0]).searchParams.get('fmt'), 'json3');
  assert.equal(page.active.size, 0, 'no timers left');
});

test('background mode: mutes, plays, pauses at end; CC turned back off', async () => {
  const page = makePage({ videoPaused: true });
  await page.run({ inPlace: false });
  assert.equal(page.calls.play, 1);
  assert.equal(page.calls.mutedAtPlay, true);
  assert.equal(page.calls.pause, 1);
  assert.equal(page.cc.pressed, 'false');
  assert.equal(page.calls.cc, 2);
});

test('manual track: missing offset is null unless the event has some offset', async () => {
  const page = makePage({
    entries: () => [TT('')],
    pr: () => playerResponse({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } } }),
    json3: { events: [
      { tStartMs: 0, dDurationMs: 10, segs: [{ utf8: 'a' }, { utf8: 'b', tOffsetMs: 5 }] },
      { tStartMs: 20, dDurationMs: 10, segs: [{ utf8: 'c' }] },
    ] },
  });
  const raw = JSON.parse(JSON.stringify(await page.run()));
  assert.equal(raw.kind, 'manual');
  assert.deepEqual(raw.events[0].segs, [[0, 'a'], [5, 'b']]);
  assert.deepEqual(raw.events[1].segs, [[null, 'c']]);
});

test('player keeps reporting another video id -> 播放器資料與網址不一致', async () => {
  const page = makePage({ readyAfter: 1e9, otherIdUntilReady: true });
  assert.equal(await rejection(page.run({ timeoutMs: 200 })), '播放器資料與網址不一致');
  assert.equal(page.active.size, 0);
  assert.equal(page.calls.play, 0);
});

test('player never ready (no id at all) -> 逾時', async () => {
  const page = makePage({ readyAfter: 1e9 });
  assert.match(await rejection(page.run({ timeoutMs: 200 })), /^逾時：0\.2 秒內沒有取得字幕$/);
  assert.equal(page.active.size, 0);
});

test('other id first, then the right one -> success', async () => {
  const page = makePage({ readyAfter: 4, otherIdUntilReady: true });
  const raw = await page.run();
  assert.equal(raw.videoId, VID);
});

test('no caption tracks -> 此影片沒有字幕軌', async () => {
  const page = makePage({ pr: () => playerResponse({ captions: undefined }) });
  assert.equal(await rejection(page.run()), '此影片沒有字幕軌');
  assert.equal(page.calls.play, 0);
  assert.equal(page.active.size, 0);
});

test('translated (tlang) entry ignored, non-tlang used', async () => {
  const page = makePage({ entries: () => [TT('&kind=asr&fmt=srv3'), TT('&kind=asr&tlang=zh-Hant')] });
  await page.run();
  const u = new URL(page.calls.fetched[0]);
  assert.equal(u.searchParams.has('tlang'), false);
  assert.equal(u.searchParams.get('fmt'), 'json3');
});

test('only a translated entry -> keeps polling -> 逾時', async () => {
  const page = makePage({ entries: () => [TT('&tlang=zh-Hant')] });
  assert.match(await rejection(page.run({ timeoutMs: 300, pollMs: 50 })), /^逾時/);
  assert.equal(page.calls.fetched.length, 0);
});

test('timedtext never appears -> 逾時, no timers left, playback stopped', async () => {
  const page = makePage({ timedtextAfter: 1e9, videoPaused: true });
  const t0 = Date.now();
  assert.match(await rejection(page.run({ timeoutMs: 300, pollMs: 50 })), /^逾時：0\.3 秒內沒有取得字幕$/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(page.active.size, 0, 'no timers left');
  const polls = page.calls.perfPolls;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(page.calls.perfPolls, polls, 'polling stopped');
  assert.equal(page.calls.pause, 1);
  assert.equal(page.cc.pressed, 'false');
});

test('json3 with empty events -> 字幕內容為空', async () => {
  const page = makePage({ json3: { events: [] } });
  assert.equal(await rejection(page.run()), '字幕內容為空');
  assert.equal(page.active.size, 0);
});

test('json3 events with no usable text -> 字幕內容為空', async () => {
  const page = makePage({ json3: { events: [{ tStartMs: 0, segs: [{ utf8: '\n' }] }] } });
  assert.equal(await rejection(page.run()), '字幕內容為空');
});

test('caption time beyond duration -> 字幕時間超出影片長度', async () => {
  const page = makePage({ json3: { events: [{ tStartMs: 999999, segs: [{ utf8: 'x' }] }] } });
  assert.equal(await rejection(page.run()), '字幕時間超出影片長度');
});

test('a trailing event past the duration is dropped, the rest is kept', async () => {
  const page = makePage({ json3: { events: [
    { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'keep' }] },
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'keep too' }] },
    { tStartMs: 999999, segs: [{ utf8: 'overrun' }] },
  ] } });
  const raw = await page.run();
  assert.deepEqual(JSON.parse(JSON.stringify(raw.events.map((e) => e.t))), [1000, 2000]);
});

test('inPlace + paused video: muted play, then pause and restore muted', async () => {
  const page = makePage({ videoPaused: true, videoMuted: false, timedtextAfter: 3 });
  await page.run({ inPlace: true });
  assert.equal(page.calls.play, 1);
  assert.equal(page.calls.mutedAtPlay, true);
  assert.equal(page.calls.pause, 1);
  assert.equal(page.video.muted, false);
  assert.equal(page.video.paused, true);
  assert.equal(page.active.size, 0);
});

test('inPlace + paused video whose play() rejects: still restored', async () => {
  const page = makePage({ videoPaused: true, videoMuted: true, playRejects: true });
  await page.run({ inPlace: true });
  assert.equal(page.calls.pause, 1);
  assert.equal(page.video.muted, true);
});

test('inPlace + playing video: play()/pause() not called, muted untouched', async () => {
  const page = makePage({ videoPaused: false, videoMuted: false });
  await page.run({ inPlace: true });
  assert.equal(page.calls.play, 0);
  assert.equal(page.calls.pause, 0);
  assert.equal(page.video.muted, false);
});

test('inPlace: CC already on stays on; CC off is turned back off', async () => {
  const on = makePage({ ccPressed: 'true' });
  await on.run({ inPlace: true });
  assert.equal(on.calls.cc, 0);
  assert.equal(on.cc.pressed, 'true');
  const off = makePage({ ccPressed: 'false' });
  await off.run({ inPlace: true });
  assert.equal(off.calls.cc, 2);
  assert.equal(off.cc.pressed, 'false');
});

const FRESH = TT('&kind=asr&sig=fresh');
const STALE = TT('&kind=asr&sig=stale');

test('CC already on, entry evicted: forced CC toggle -> fresh request -> success, CC still on', async () => {
  const page = makePage({ ccPressed: 'true', entries: (c) => (c.cc >= 2 ? [FRESH] : []) });
  const raw = await page.run({ inPlace: true, timeoutMs: 2000, forceMs: 100 });
  assert.equal(raw.videoId, VID);
  assert.equal(page.calls.cleared, 1);
  assert.equal(page.calls.cc, 2);
  assert.equal(page.cc.pressed, 'true');
  assert.equal(new URL(page.calls.fetched[0]).searchParams.get('sig'), 'fresh');
  assert.equal(page.active.size, 0);
});

test('CC off initially, request late: forced refresh, CC off again after success', async () => {
  const page = makePage({ ccPressed: 'false', entries: (c) => (c.cleared ? [FRESH] : []) });
  await page.run({ forceMs: 100 });
  assert.equal(page.calls.cleared, 1);
  assert.equal(page.cc.pressed, 'false');
});

test('forced refresh happens at most once; CC restored to original on timeout', async () => {
  for (const pressed of ['true', 'false']) {
    const page = makePage({ ccPressed: pressed, entries: () => [] });
    assert.match(await rejection(page.run({ timeoutMs: 500, pollMs: 20, forceMs: 50 })), /^逾時/);
    assert.equal(page.calls.cleared, 1, 'cleared once');
    assert.equal(page.calls.cc, pressed === 'true' ? 2 : 4, 'clicks for ' + pressed);
    assert.equal(page.cc.pressed, pressed);
    assert.equal(page.active.size, 0);
  }
});

test('stale entry gives empty json3: forced refresh, new entry, second fetch succeeds', async () => {
  const page = makePage({
    entries: (c) => (c.cleared ? [FRESH] : [STALE]),
    json3: (n) => (n === 1 ? { events: [] } : JSON3),
  });
  const raw = await page.run({ inPlace: true });
  assert.equal(raw.events.length, 2);
  assert.equal(page.calls.fetched.length, 2);
  assert.equal(new URL(page.calls.fetched[0]).searchParams.get('sig'), 'stale');
  assert.equal(new URL(page.calls.fetched[1]).searchParams.get('sig'), 'fresh');
  assert.equal(page.calls.cleared, 1);
  assert.equal(page.cc.pressed, 'false');
});

test('stale entry gives HTTP error: retried once after refresh', async () => {
  const page = makePage({ entries: (c) => (c.cleared ? [FRESH] : [STALE]), json3: (n) => (n === 1 ? 404 : JSON3) });
  await page.run();
  assert.equal(page.calls.fetched.length, 2);
});

test('empty json3 twice -> 字幕內容為空 after exactly one retry; HTTP error twice -> HTTP message', async () => {
  const a = makePage({ json3: { events: [] } });
  assert.equal(await rejection(a.run()), '字幕內容為空');
  assert.equal(a.calls.fetched.length, 2);
  assert.equal(a.calls.cleared, 1);
  const b = makePage({ json3: 404 });
  assert.equal(await rejection(b.run()), '字幕下載失敗（HTTP 404）');
  assert.equal(b.calls.fetched.length, 2);
});

test('inPlace: user navigates to another video mid-capture -> 播放器資料與網址不一致 immediately', async () => {
  const page = makePage({ timedtextAfter: 1e9, videoPaused: true });
  const p = page.run({ inPlace: true, timeoutMs: 5000 });
  setTimeout(() => { page.ctx.location.href = 'https://www.youtube.com/watch?v=zzzzzzzzzzz'; }, 60);
  const t0 = Date.now();
  assert.equal(await rejection(p), '播放器資料與網址不一致');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(page.video.paused, true);
  assert.equal(page.cc.pressed, 'false');
  assert.equal(page.active.size, 0);
});

test('inPlace timeout: muted, paused and CC restored', async () => {
  const page = makePage({ timedtextAfter: 1e9, videoPaused: true, videoMuted: false, ccPressed: 'false' });
  assert.match(await rejection(page.run({ inPlace: true, timeoutMs: 400, pollMs: 20, forceMs: 50 })), /^逾時/);
  assert.equal(page.calls.play, 1);
  assert.equal(page.calls.mutedAtPlay, true);
  assert.equal(page.video.muted, false);
  assert.equal(page.video.paused, true);
  assert.equal(page.cc.pressed, 'false');
  assert.equal(page.active.size, 0);
});

const LINE_JSON3 = { events: [
  { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'When I look at the sketches,\nI really appreciate' }] },
  { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'craggy  faces' }] },
] };

test('manual line track (no kind in URL, en-US): newline -> space, every seg untimed, kind manual', async () => {
  const page = makePage({
    entries: () => ['https://www.youtube.com/api/timedtext?v=' + VID + '&lang=en-US'],
    pr: () => playerResponse({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr' }, { languageCode: 'en-US' }] } } }),
    json3: LINE_JSON3,
  });
  const raw = JSON.parse(JSON.stringify(await page.run()));
  assert.equal(raw.kind, 'manual', 'kind comes from the URL, not from tracks');
  assert.equal(raw.lang, 'en-US');
  assert.deepEqual(raw.events[0].segs, [[null, 'When I look at the sketches, I really appreciate']]);
  assert.deepEqual(raw.events[1].segs, [[null, 'craggy faces']]);
});

test('kind=asr URL with single-word segs: offsets 0 / numbers as before', async () => {
  const page = makePage({ entries: () => [TT('&kind=asr')] });
  const raw = JSON.parse(JSON.stringify(await page.run()));
  assert.equal(raw.kind, 'asr');
  assert.deepEqual(raw.events.map((e) => e.segs), [[[0, 'hello'], [400, 'world']], [[0, 'again']]]);
});

test('ASR track: a seg with internal whitespace is untimed, single words keep timing', async () => {
  const words = Array.from({ length: 9 }, (_, i) => ({ utf8: ' w' + i, tOffsetMs: i * 100 }));
  const page = makePage({
    entries: () => [TT('&kind=asr')],
    json3: { events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'two words', tOffsetMs: 0 }, ...words] }] },
  });
  const raw = JSON.parse(JSON.stringify(await page.run()));
  assert.equal(raw.kind, 'asr', '1 of 10 untimed (10%) stays asr');
  assert.deepEqual(raw.events[0].segs[0], [null, 'two words']);
  assert.deepEqual(raw.events[0].segs[1], [0, 'w0']);
  assert.deepEqual(raw.events[0].segs[9], [800, 'w8']);
});

test('kind=asr URL but more than 20% untimed segs -> downgraded to manual', async () => {
  const page = makePage({ entries: () => [TT('&kind=asr')], json3: LINE_JSON3 });
  const raw = JSON.parse(JSON.stringify(await page.run()));
  assert.equal(raw.kind, 'manual');
  const edge = makePage({
    entries: () => [TT('&kind=asr')],
    json3: { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'a b' }, { utf8: 'c' }, { utf8: 'd' }, { utf8: 'e' }, { utf8: 'f' }] }] },
  });
  assert.equal((await edge.run()).kind, 'asr', 'exactly 20% untimed is not more than 20%');
});
