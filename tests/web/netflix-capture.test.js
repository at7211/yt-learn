// extension/netflix-manifest.js + extension/netflix-capture.js (probe mode) in a vm context standing in for the
// isolated world. The MAIN-world hook is either a scripted fake or, in the last test, the real netflix-hook.js
// in a second context sharing the same fake window.postMessage bus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LIB = read('../../extension/netflix-manifest.js');
const CAP = read('../../extension/netflix-capture.js');
const HOOK = read('../../extension/netflix-hook.js');
const ORIGIN = 'https://www.netflix.com';
const plain = (x) => JSON.parse(JSON.stringify(x));
const U = (n) => `https://ipv4-c0${n}-tpe001-ix.1.oca.nflxvideo.net/?o=1&v=${n}`;
const TTML = '<?xml version="1.0" encoding="utf-8"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0t" end="10t">Made-up line.</p></div></body></tt>';
const STATS = { parsed: 4, suspected: 1, summarized: 1, unknownShape: 0, skippedReviver: 0 };
const TRACKS = [
  { lang: 'en', type: 'ASSISTIVE', name: 'English (CC)', forced: false, formats: { 'imsc1.1': U(3) } },
  { lang: 'en', type: 'PRIMARY', name: 'English', forced: false, formats: { 'dfxp-ls-sdh': U(2), 'imsc1.1': U(1) } },
  { lang: 'zh-Hant', type: 'PRIMARY', name: '中文', forced: false, formats: { 'imsc1.1': U(4) } },
];

// A shared window.postMessage bus; each world's listeners get events whose source is that world's window.
function bus() {
  const worlds = [];
  const posted = [];
  return {
    posted,
    attach(win, listeners) { worlds.push({ win, listeners }); },
    post(data, targetOrigin, origin = ORIGIN) {
      posted.push({ data: plain(data), targetOrigin });
      setTimeout(() => {
        for (const w of worlds) for (const f of w.listeners.slice()) f({ source: w.win, origin, data: plain(data) });
      }, 0);
    },
  };
}

function world(b, { path = '/watch/81234567', fetchImpl, extra = {} } = {}) {
  const listeners = [];
  const active = new Set();
  const ctx = {
    URL, TextEncoder, TextDecoder, AbortController, Uint8Array,
    setTimeout: (fn, ms) => { const id = setTimeout(() => { active.delete(id); fn(); }, ms); active.add(id); return id; },
    clearTimeout: (id) => { active.delete(id); clearTimeout(id); },
    location: { pathname: path },
    addEventListener: (n, f) => { if (n === 'message') listeners.push(f); },
    removeEventListener: (n, f) => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
    postMessage: (d, o) => b.post(d, o),
    fetch: fetchImpl,
    document: { querySelector: () => null },
    ...extra,
  };
  vm.createContext(ctx);
  const win = vm.runInContext('globalThis', ctx);
  vm.runInContext('var window = globalThis;', ctx);
  b.attach(win, listeners);
  return { ctx, win, listeners, active };
}

// fetch fakes
const okFetch = (text = TTML, calls = []) => async (url, init) => {
  calls.push({ url, init });
  const bytes = new TextEncoder().encode(text);
  return { status: 200, ok: true, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes.buffer };
};

// A scripted hook: replies(n, msg) -> reply object (or null for silence) for the n-th nf-get.
function fakeHook(b, { replies, seekAck = (m) => ({ ok: true }) } = {}) {
  const listeners = [];
  let n = 0;
  const seen = { gets: [], seeks: [] };
  const win = {};
  b.attach(win, listeners);
  listeners.push((ev) => {
    const m = ev.data;
    if (m.type === 'ytlearn:nf-get') {
      seen.gets.push(m);
      const r = replies(n++, m);
      if (r) b.post({ type: 'ytlearn:nf-manifest', nonce: m.nonce, hook: 1, movieId: m.movieId, stats: STATS, ...r }, ORIGIN);
    } else if (m.type === 'ytlearn:nf-seek') {
      seen.seeks.push(m);
      const a = seekAck(m);
      if (a) b.post({ type: 'ytlearn:nf-seek-ack', requestId: m.requestId, hook: 1, ...a }, ORIGIN);
    }
  });
  return seen;
}
const FOUND = { state: 'found', manifest: { movieId: '81234567', durationMs: 1500000, tracks: TRACKS }, currentMs: 61234.4, title: 'A made-up title' };

function setup({ replies = () => FOUND, seekAck, fetchImpl, path, extra } = {}) {
  const b = bus();
  const calls = [];
  const w = world(b, { path, fetchImpl: fetchImpl || okFetch(TTML, calls), extra });
  vm.runInContext(LIB, w.ctx);
  vm.runInContext(CAP, w.ctx);
  const seen = fakeHook(b, { replies, seekAck });
  const run = (o) => w.win.ytLearnNetflixCapture({ probe: true, timeoutMs: 1500, ...o });
  return { b, w, seen, calls, run };
}

async function rejection(p) {
  try { await p; } catch (e) { return String(e && e.message); }
  assert.fail('expected rejection');
}

function assertClean(s) {
  assert.equal(s.w.listeners.length, 0, 'message listener removed');
  assert.equal(s.w.active.size, 0, 'no timers left');
}

test('probe happy path: stats, tracks, one English fetch (PRIMARY, imsc1.1, credentials omit, redirect error), seek ack', async () => {
  const s = setup();
  const r = plain(await s.run({ expectLessonId: 'netflix.81234567' }));
  assert.deepEqual(r.hook, STATS);
  assert.equal(r.state, 'found');
  assert.equal(r.movieId, '81234567');
  assert.equal(r.title, 'A made-up title');
  assert.deepEqual(r.tracks, [
    { lang: 'en', type: 'ASSISTIVE', forced: false, formats: ['imsc1.1'] },
    { lang: 'en', type: 'PRIMARY', forced: false, formats: ['dfxp-ls-sdh', 'imsc1.1'] },
    { lang: 'zh-Hant', type: 'PRIMARY', forced: false, formats: ['imsc1.1'] },
  ]);
  assert.equal(s.calls.length, 1, 'exactly one subtitle request');
  assert.equal(s.calls[0].url, U(1));
  assert.equal(s.calls[0].init.credentials, 'omit');
  assert.equal(s.calls[0].init.redirect, 'error');
  assert.ok(s.calls[0].init.signal);
  assert.deepEqual(r.enFetch, { lang: 'en', type: 'PRIMARY', format: 'imsc1.1', status: 200, bytes: new TextEncoder().encode(TTML).length, head: TTML.slice(0, 80) });
  assert.deepEqual(r.seek, { ms: 61234, ok: true });
  assert.deepEqual(plain(s.seen.seeks.map(({ requestId, ...m }) => m)), [{ type: 'ytlearn:nf-seek', expectedMovieId: '81234567', ms: 61234, play: false }]);
  assert.ok(s.b.posted.every((p) => p.targetOrigin === ORIGIN));
  assertClean(s);
});

test('no reply at all -> 「Netflix 鉤子不在（請重新載入頁面）」 (asked repeatedly within the deadline)', async () => {
  const s = setup({ replies: () => null });
  assert.equal(await rejection(s.run({ timeoutMs: 1200 })), 'Netflix 鉤子不在（請重新載入頁面）');
  assert.ok(s.seen.gets.length >= 2);
  assertClean(s);
});

test('pending -> pending -> found: retried every ~500 ms, then succeeds', async () => {
  const s = setup({ replies: (n) => (n < 2 ? { state: 'pending' } : FOUND), });
  const t0 = Date.now();
  const r = await s.run({ timeoutMs: 3000 });
  assert.equal(r.state, 'found');
  assert.equal(s.seen.gets.length, 3);
  assert.ok(Date.now() - t0 >= 900, 'waited between asks');
  assert.notEqual(s.seen.gets[0].nonce, s.seen.gets[1].nonce);
});

test('always pending -> 「還沒收到這部片的字幕清單」', async () => {
  const s = setup({ replies: () => ({ state: 'pending' }) });
  assert.equal(await rejection(s.run({ timeoutMs: 1200 })), '還沒收到這部片的字幕清單');
  assertClean(s);
});

test('unsupported -> 「Netflix 改版了，認不出字幕清單」; off -> hook switched off', async () => {
  assert.equal(await rejection(setup({ replies: () => ({ state: 'unsupported' }) }).run()), 'Netflix 改版了，認不出字幕清單');
  assert.match(await rejection(setup({ replies: () => ({ state: 'off' }) }).run()), /已關閉/);
});

test('a reply for another movie, or with a bad subtitle hostname, is refused before any fetch', async () => {
  const other = setup({ replies: () => ({ ...FOUND, manifest: { ...FOUND.manifest, movieId: '1' } }) });
  assert.match(await rejection(other.run()), /鉤子回覆格式不對（manifest\.movieId）/);
  assert.equal(other.calls.length, 0);
  const evil = setup({ replies: () => ({ ...FOUND, manifest: { ...FOUND.manifest, tracks: [{ ...TRACKS[1], formats: { 'imsc1.1': 'https://evil.example/x' } }] } }) });
  assert.match(await rejection(evil.run()), /鉤子回覆格式不對（url）/);
  assert.equal(evil.calls.length, 0);
});

test('replies with another nonce, from another origin, or from another window are ignored', async () => {
  const s = setup({ replies: () => null });
  // inject stray replies directly
  const stray = { type: 'ytlearn:nf-manifest', hook: 1, movieId: '81234567', stats: STATS, ...FOUND };
  const p = s.run({ timeoutMs: 1000 });
  setTimeout(() => {
    s.b.post({ ...stray, nonce: 'not-mine' }, ORIGIN);
    const nonce = s.seen.gets[0].nonce;
    for (const f of s.w.listeners.slice()) f({ source: s.w.win, origin: 'https://evil.example', data: { ...stray, nonce } });
    for (const f of s.w.listeners.slice()) f({ source: {}, origin: ORIGIN, data: { ...stray, nonce } });
  }, 50);
  assert.equal(await rejection(p), 'Netflix 鉤子不在（請重新載入頁面）');
});

test('2 MB cap: Content-Length, a streamed body and a plain arrayBuffer over the cap are all refused', async () => {
  const big = 2 * 1024 * 1024 + 1;
  const byHeader = setup({ fetchImpl: async () => ({ status: 200, headers: { get: () => String(big) }, arrayBuffer: async () => { throw new Error('must not read'); } }) });
  assert.equal((await byHeader.run()).enFetch.error, '字幕檔超過 2 MB');
  let cancelled = false;
  let reads = 0;
  const stream = setup({ fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: new Uint8Array(512 * 1024) }; },
    cancel: async () => { cancelled = true; },
  }) } }) });
  const r = await stream.run();
  assert.equal(r.enFetch.error, '字幕檔超過 2 MB');
  assert.ok(cancelled);
  assert.equal(reads, 5, 'stops reading right after the cap');
  const buf = setup({ fetchImpl: async () => ({ status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(big) }) });
  assert.equal((await buf.run()).enFetch.error, '字幕檔超過 2 MB');
  // the probe still reports the seek
  assert.equal(r.seek.ok, true);
});

test('fetch failures land in enFetch (HTTP status is reported as is; network errors as error)', async () => {
  const s404 = setup({ fetchImpl: async () => ({ status: 403, headers: { get: () => '9' }, arrayBuffer: async () => new TextEncoder().encode('forbidden').buffer }) });
  const r = await s404.run();
  assert.equal(r.enFetch.status, 403);
  assert.equal(r.enFetch.head, 'forbidden');
  const down = setup({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal((await down.run()).enFetch.error, 'Failed to fetch');
});

test('no English track -> enFetch.error 「這部片沒有英文字幕」, nothing fetched, the rest still reported', async () => {
  const s = setup({ replies: () => ({ ...FOUND, manifest: { ...FOUND.manifest, tracks: [TRACKS[2], { ...TRACKS[1], forced: true }] } }) });
  const r = await s.run();
  assert.equal(r.enFetch.error, '這部片沒有英文字幕');
  assert.equal(s.calls.length, 0);
  assert.equal(r.tracks.length, 2);
  assert.equal(r.seek.ok, true);
});

test('seek: refused ack, no ack, no player session', async () => {
  assert.deepEqual(plain((await setup({ seekAck: () => ({ ok: false, error: 'urlMismatch' }) }).run()).seek), { ms: 61234, ok: false, error: 'urlMismatch' });
  assert.deepEqual(plain((await setup({ seekAck: () => null }).run()).seek), { ms: 61234, ok: false, error: '鉤子沒有回覆 seek' });
  const noSession = setup({ replies: () => { const { currentMs, ...rest } = FOUND; return rest; } });
  const r = await noSession.run();
  assert.deepEqual(plain(r.seek), { ok: false, error: '找不到播放器 session' });
  assert.equal(noSession.seen.seeks.length, 0);
});

test('not a watch page, another episode than expected, or a non-probe call -> errors', async () => {
  assert.equal(await rejection(setup({ path: '/browse' }).run()), '這不是 Netflix 播放頁');
  assert.equal(await rejection(setup().run({ expectLessonId: 'netflix.1' })), '換集了，請回到原本那一集再試');
  const s = setup();
  assert.match(await rejection(s.w.win.ytLearnNetflixCapture({ timeoutMs: 1000 })), /尚未實作/);
  assert.equal(s.seen.gets.length, 0);
});

test('end to end with the real hook: MAIN world parses a manifest, the probe finds it, fetches, seeks via the player API', async () => {
  const b = bus();
  const calls = [];
  const player = { seeks: [] };
  const main = world(b, { extra: { netflix: { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ['watch-1'],
    getVideoPlayerBySessionId: () => ({ getMovieId: () => 81234567, getCurrentTime: () => 42000, getDuration: () => 1500000, seek: (ms) => player.seeks.push(ms), play: () => {} }),
  } }) } } } } } });
  vm.runInContext(LIB, main.ctx);
  vm.runInContext(HOOK, main.ctx);
  const text = JSON.stringify({ result: { movieId: 81234567, duration: 1500000, textTracks: [
    { bcp47: 'en', trackType: 'PRIMARY', isForcedNarrative: false, downloadables: { 'imsc1.1': { urls: [{ url: U(1) }] }, simplesdh: { urls: [{ url: U(9) }] } } }] } });
  main.win.JSON.parse(text);
  const iso = world(b, { fetchImpl: okFetch(TTML, calls) });
  vm.runInContext(LIB, iso.ctx);
  vm.runInContext(CAP, iso.ctx);
  const r = plain(await iso.win.ytLearnNetflixCapture({ probe: true, timeoutMs: 2000 }));
  assert.equal(r.state, 'found');
  assert.equal(r.hook.summarized, 1);
  assert.equal(r.hook.skippedReviver, 0);
  assert.deepEqual(r.tracks, [{ lang: 'en', type: 'PRIMARY', forced: false, formats: ['imsc1.1'] }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, U(1));
  assert.equal(r.enFetch.status, 200);
  assert.ok(r.enFetch.head.includes('<tt'));
  assert.deepEqual(r.seek, { ms: 42000, ok: true });
  assert.deepEqual(player.seeks, [42000]);
});
