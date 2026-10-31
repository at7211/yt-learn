// extension/netflix-manifest.js + extension/ttml.js + extension/netflix-capture.js (probe and formal mode) in a vm context standing in for the
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

test('no reply at all -> 「Netflix hook 不在（請重新載入頁面）」 (asked repeatedly within the deadline)', async () => {
  const s = setup({ replies: () => null });
  assert.equal(await rejection(s.run({ timeoutMs: 1200 })), 'Netflix hook 不在（請重新載入頁面）');
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
  assert.match(await rejection(other.run()), /hook 回覆格式不對（manifest\.movieId）/);
  assert.equal(other.calls.length, 0);
  const evil = setup({ replies: () => ({ ...FOUND, manifest: { ...FOUND.manifest, tracks: [{ ...TRACKS[1], formats: { 'imsc1.1': 'https://evil.example/x' } }] } }) });
  assert.match(await rejection(evil.run()), /hook 回覆格式不對（url）/);
  assert.equal(evil.calls.length, 0);
});

test('a reply over the 128 KB cap -> the error names the real size, the state and the track count', async () => {
  const longUrl = 'https://a.nflxvideo.net/?' + 'q'.repeat(1990);
  const tracks = Array.from({ length: 80 }, () => ({ ...TRACKS[1], formats: { 'imsc1.1': longUrl } }));
  const s = setup({ replies: () => ({ ...FOUND, manifest: { ...FOUND.manifest, tracks } }) });
  const msg = await rejection(s.run());
  assert.match(msg, /^hook 回覆太大（1[0-9]{2} KB，上限 128 KB；state found、80 軌）$/);
  assert.equal(s.calls.length, 0);
  assertClean(s);
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
  assert.equal(await rejection(p), 'Netflix hook 不在（請重新載入頁面）');
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
  assert.deepEqual(plain((await setup({ seekAck: () => null }).run()).seek), { ms: 61234, ok: false, error: 'hook 沒有回覆 seek' });
  const noSession = setup({ replies: () => { const { currentMs, ...rest } = FOUND; return rest; } });
  const r = await noSession.run();
  assert.deepEqual(plain(r.seek), { ok: false, error: '找不到播放器 session' });
  assert.equal(noSession.seen.seeks.length, 0);
});

test('probe: not a watch page, another episode than expected -> errors', async () => {
  assert.equal(await rejection(setup({ path: '/browse' }).run()), '這不是 Netflix 播放頁');
  assert.equal(await rejection(setup().run({ expectLessonId: 'netflix.1' })), '換集了，請回到原本那一集再試');
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

/* ---------- formal capture: ytLearnNetflixCapture({expectLessonId, timeoutMs}) -> raw ---------- */

const TTMLJS = read('../../extension/ttml.js');
const EN_TTML = read('../fixtures/netflix_small.ttml');
const MANIFEST = (() => { const { _comment, ...m } = JSON.parse(read('../fixtures/netflix_manifest.json')); return m; })();
const EN_URL = MANIFEST.tracks[1].formats['imsc1.1'];
const ZH_URL = MANIFEST.tracks[3].formats['imsc1.1'];
const ttml = (ps) => '<?xml version="1.0" encoding="UTF-8"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000" ttp:timeBase="media"><body><div>' + ps + '</div></body></tt>';
const ZH_TTML = ttml('<p begin="12340000t" end="34560000t">編出來的第一句。</p><p begin="40000000t" end="60000000t">桌上有<span>煎餅</span>和茶。</p>');
const ZH_EVENTS = [{ t: 1234, d: 2222, text: '編出來的第一句。' }, { t: 4000, d: 2000, text: '桌上有煎餅和茶。' }];
const EN_EVENTS = [
  { t: 1234, d: 2222, segs: [[null, 'First line of a made-up sentence.']] },
  { t: 4000, d: 2000, segs: [[null, 'Pancakes & tea are on the table.']] },
  { t: 9000, d: 2000, segs: [[null, 'We sing about the pretend river']] },
  { t: 14000, d: 1000, segs: [[null, 'Wait (quietly) for me.']] },
  { t: 16000, d: 1500, segs: [[null, 'Speaker one says hi. Speaker two waves back.']] },
  { t: 21000, d: 2000, segs: [[null, 'It\'s "fine", <really> été.']] },
];
const CFOUND = { state: 'found', manifest: MANIFEST, currentMs: 1000, title: 'An invented episode' };
const withManifest = (patch) => () => ({ ...CFOUND, manifest: { ...MANIFEST, ...patch } });

// routes: {url: text | {status, body?} | (init) => Promise<response>}; anything else -> network error.
function routeFetch(routes, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (typeof r === 'function') return r(init);
    if (r === undefined) throw new TypeError('Failed to fetch');
    const { status = 200, body = '' } = typeof r === 'string' ? { body: r } : r;
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return { status, ok: status >= 200 && status < 300, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
}

function setupCap({ replies = () => CFOUND, routes = { [EN_URL]: EN_TTML, [ZH_URL]: ZH_TTML }, path, extra, ttmlLoaded = true } = {}) {
  const b = bus();
  const calls = [];
  const w = world(b, { path, fetchImpl: routeFetch(routes, calls), extra });
  vm.runInContext(LIB, w.ctx);
  if (ttmlLoaded) vm.runInContext(TTMLJS, w.ctx);
  vm.runInContext(CAP, w.ctx);
  const seen = fakeHook(b, { replies });
  const run = (o) => w.win.ytLearnNetflixCapture({ expectLessonId: 'netflix.81234567', timeoutMs: 1500, ...o });
  return { b, w, seen, calls, run };
}
const noCapturedAt = ({ capturedAt, ...rest }) => rest;

test('capture happy path: raw shape (Udemy fields + source/sourceUrl), English PRIMARY imsc1.1, zh-Hant ref, fetch rules', async () => {
  const s = setupCap();
  const raw = plain(await s.run());
  assert.match(raw.capturedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(noCapturedAt(raw), {
    videoId: 'netflix.81234567',
    source: 'netflix',
    sourceUrl: 'https://www.netflix.com/watch/81234567',
    title: 'An invented episode',
    channel: 'Netflix',
    duration: 1500,
    lang: 'en',
    kind: 'manual',
    events: EN_EVENTS,
    ref: { lang: 'zh-Hant', kind: 'official', events: ZH_EVENTS },
  });
  assert.ok(!('refStatus' in raw));
  assert.deepEqual(s.calls.map((c) => c.url), [EN_URL, ZH_URL], 'English first, then the reference');
  for (const c of s.calls) {
    assert.equal(c.init.credentials, 'omit');
    assert.equal(c.init.redirect, 'error');
    assert.ok(c.init.signal);
  }
  assert.equal(s.seen.seeks.length, 0, 'the formal capture does not seek');
  assertClean(s);
});

test('capture: hook errors are the probe\'s (no reply, pending -> found, always pending, unsupported, off)', async () => {
  const none = setupCap({ replies: () => null });
  assert.equal(await rejection(none.run({ timeoutMs: 1200 })), 'Netflix hook 不在（請重新載入頁面）');
  assertClean(none);
  const later = setupCap({ replies: (n) => (n < 2 ? { state: 'pending' } : CFOUND) });
  assert.equal((await later.run({ timeoutMs: 3000 })).videoId, 'netflix.81234567');
  assert.equal(later.seen.gets.length, 3);
  assert.equal(await rejection(setupCap({ replies: () => ({ state: 'pending' }) }).run({ timeoutMs: 1200 })), '還沒收到這部片的字幕清單');
  assert.equal(await rejection(setupCap({ replies: () => ({ state: 'unsupported' }) }).run()), 'Netflix 改版了，認不出字幕清單');
  assert.equal(await rejection(setupCap({ replies: () => ({ state: 'off' }) }).run()), 'Netflix hook 已關閉（請重新載入頁面）');
});

test('capture: manifest for another movie, or a subtitle URL on another host -> refused, nothing fetched', async () => {
  const other = setupCap({ replies: withManifest({ movieId: '1' }) });
  assert.equal(await rejection(other.run()), 'hook 回覆格式不對（manifest.movieId）');
  assert.equal(other.calls.length, 0);
  const evil = setupCap({ replies: withManifest({ tracks: [{ ...MANIFEST.tracks[1], formats: { 'imsc1.1': 'https://evil.example/x' } }] }) });
  assert.equal(await rejection(evil.run()), 'hook 回覆格式不對（url）');
  assert.equal(evil.calls.length, 0);
});

test('capture: 2 MB cap, HTTP failure, network failure, non-UTF-8 bytes', async () => {
  const big = new Uint8Array(2 * 1024 * 1024 + 1);
  assert.equal(await rejection(setupCap({ routes: { [EN_URL]: { body: big } } }).run()), '字幕檔超過 2 MB');
  assert.equal(await rejection(setupCap({ routes: { [EN_URL]: { status: 404, body: 'nope' } } }).run()), '字幕檔下載失敗（HTTP 404）');
  assert.equal(await rejection(setupCap({ routes: {} }).run()), '字幕檔下載失敗（Failed to fetch）');
  assert.equal(await rejection(setupCap({ routes: { [EN_URL]: { body: new Uint8Array([0x3c, 0xff, 0xfe]) } } }).run()), '字幕檔不是 UTF-8');
});

test('capture: no usable English track (only forced / other languages) -> 「這部片沒有英文字幕」, nothing fetched', async () => {
  const s = setupCap({ replies: withManifest({ tracks: [MANIFEST.tracks[2], MANIFEST.tracks[3]] }) });
  assert.equal(await rejection(s.run()), '這部片沒有英文字幕');
  assert.equal(s.calls.length, 0);
  assertClean(s);
});

test('capture: ttml.js missing, a parse error (as is), empty subtitles', async () => {
  assert.equal(await rejection(setupCap({ ttmlLoaded: false }).run()), 'ttml.js 未載入');
  const bad = await rejection(setupCap({ routes: { [EN_URL]: '<!DOCTYPE tt><tt/>' } }).run());
  assert.match(bad, /^不支援的字幕檔結構：.*DOCTYPE/);
  assert.equal(await rejection(setupCap({ routes: { [EN_URL]: ttml('<p begin="0t" end="10000000t">[music]</p>') } }).run()), '字幕內容為空');
});

test('capture: zh-Hant reference degrades to refStatus "failed" (download, parse, 5001 cues, > 200k chars); English unaffected', async () => {
  const many = ttml(Array.from({ length: 5001 }, (_, i) => `<p begin="${i}s" end="${i}.5s">第${i}句</p>`).join(''));
  const long = ttml(`<p begin="1s" end="2s">${'長'.repeat(100001)}</p><p begin="3s" end="4s">${'長'.repeat(100001)}</p>`);
  const cases = {
    'HTTP 500': { status: 500 },
    'network': undefined,
    'parse error': ttml('<p begin="1s" end="2s"><ruby>字</ruby></p>'),
    '5001 cues': many,
    '> 200k chars': long,
    'empty': ttml('<p begin="1s" end="2s">♪</p>'),
  };
  for (const [name, zh] of Object.entries(cases)) {
    const routes = { [EN_URL]: EN_TTML };
    if (zh !== undefined) routes[ZH_URL] = zh;
    const s = setupCap({ routes });
    const raw = plain(await s.run({ timeoutMs: 5000 }));
    assert.equal(raw.refStatus, 'failed', name);
    assert.ok(!('ref' in raw), name);
    assert.deepEqual(raw.events, EN_EVENTS, name);
    assert.deepEqual(s.calls.map((c) => c.url), [EN_URL, ZH_URL], name);
    assertClean(s);
  }
  // exactly 5000 cues is accepted
  const ok = ttml(Array.from({ length: 5000 }, (_, i) => `<p begin="${i}s" end="${i}.5s">第${i}句</p>`).join(''));
  const s = setupCap({ routes: { [EN_URL]: EN_TTML, [ZH_URL]: ok } });
  assert.equal(plain(await s.run({ timeoutMs: 5000 })).ref.events.length, 5000);
});

test('capture: no zh-Hant track -> refStatus "missing", no ref, nothing else fetched', async () => {
  const s = setupCap({ replies: withManifest({ tracks: MANIFEST.tracks.slice(0, 3) }) });
  const raw = plain(await s.run());
  assert.equal(raw.refStatus, 'missing');
  assert.ok(!('ref' in raw));
  assert.deepEqual(s.calls.map((c) => c.url), [EN_URL]);
});

test('capture: zh shares the deadline — too little time left after English -> refStatus "failed" without fetching zh', async () => {
  const slowEn = () => new Promise((r) => setTimeout(() => r(routeFetch({ [EN_URL]: EN_TTML }, [])(EN_URL, {})), 700));
  const s = setupCap({ routes: { [EN_URL]: slowEn, [ZH_URL]: ZH_TTML } });
  const t0 = Date.now();
  const raw = plain(await s.run({ timeoutMs: 1500 }));
  assert.ok(Date.now() - t0 < 1500, 'within the deadline');
  assert.equal(raw.refStatus, 'failed');
  assert.deepEqual(s.calls.map((c) => c.url), [EN_URL]);
  assert.deepEqual(raw.events, EN_EVENTS);
  assertClean(s);
});

test('capture: a hanging zh download is aborted at the shared deadline -> refStatus "failed", English still returned', async () => {
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const s = setupCap({ routes: { [EN_URL]: EN_TTML, [ZH_URL]: hang } });
  const t0 = Date.now();
  const raw = plain(await s.run({ timeoutMs: 1500 }));
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(raw.refStatus, 'failed');
  assert.deepEqual(raw.events, EN_EVENTS);
  assertClean(s);
});

test('capture: another episode at the start, or the page switching episodes during the capture', async () => {
  const s = setupCap();
  assert.equal(await rejection(s.run({ expectLessonId: 'netflix.1' })), '換集了，請回到原本那一集再試');
  assert.equal(s.seen.gets.length, 0);
  assert.equal(await rejection(setupCap({ path: '/browse' }).run()), '這不是 Netflix 播放頁');
  let w;
  const switching = setupCap({ routes: { [EN_URL]: EN_TTML, [ZH_URL]: async () => { w.ctx.location.pathname = '/watch/999'; return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }; } } });
  w = switching.w;
  assert.equal(await rejection(switching.run()), '換集了，請回到原本那一集再試');
});

test('capture: duration falls back to video.duration (waiting for loadedmetadata), else 「讀不到影片長度」', async () => {
  const video = { duration: NaN, ls: [], addEventListener(n, f) { this.ls.push(f); }, removeEventListener(n, f) { this.ls = this.ls.filter((x) => x !== f); } };
  setTimeout(() => { video.duration = 1200.5; for (const f of video.ls.slice()) f(); }, 100);
  const s = setupCap({ replies: withManifest({ durationMs: null }), extra: { document: { querySelector: (q) => (q === 'video' ? video : null) } } });
  assert.equal((await s.run()).duration, 1200.5);
  assert.equal(video.ls.length, 0, 'listener removed');
  assertClean(s);
  assert.equal(await rejection(setupCap({ replies: withManifest({ durationMs: null }) }).run()), '讀不到影片長度');
  const never = { duration: NaN, addEventListener() {}, removeEventListener() {} };
  const t0 = Date.now();
  assert.equal(await rejection(setupCap({ replies: withManifest({ durationMs: null }), extra: { document: { querySelector: () => never } } }).run({ timeoutMs: 800 })), '讀不到影片長度');
  assert.ok(Date.now() - t0 < 1500, 'waits at most until the deadline');
});

test('capture: cues past the duration are dropped when few, refused when more than half', async () => {
  const few = plain(await setupCap({ replies: withManifest({ durationMs: 15000 }) }).run());
  assert.deepEqual(few.events.map((e) => e.t), [1234, 4000, 9000, 14000]);
  assert.equal(few.duration, 15);
  assert.equal(await rejection(setupCap({ replies: withManifest({ durationMs: 5000 }) }).run()), '字幕時間超出影片長度');
});

test('capture: title / channel fallbacks', async () => {
  const noTitle = plain(await setupCap({ replies: () => { const { title, ...r } = CFOUND; return r; } }).run());
  assert.equal(noTitle.title, 'Netflix 81234567');
  assert.equal(noTitle.channel, 'Netflix');
  const show = plain(await setupCap({ replies: () => ({ ...CFOUND, show: 'An invented show' }) }).run());
  assert.equal(show.title, 'An invented episode');
  assert.equal(show.channel, 'An invented show');
});

test('capture: zh ref character cap counts code points like Python len() (astral characters near 200,000)', async () => {
  const two = (a, b) => ttml(`<p begin="1s" end="2s">${'𠀋'.repeat(a)}</p><p begin="3s" end="4s">${'𠀋'.repeat(b)}</p>`);
  const at = plain(await setupCap({ routes: { [EN_URL]: EN_TTML, [ZH_URL]: two(100000, 100000) } }).run({ timeoutMs: 5000 }));
  assert.ok(at.ref, 'exactly 200,000 code points (400,000 UTF-16 units) is accepted');
  assert.equal([...at.ref.events.map((e) => e.text).join('')].length, 200000);
  const over = plain(await setupCap({ routes: { [EN_URL]: EN_TTML, [ZH_URL]: two(100000, 100001) } }).run({ timeoutMs: 5000 }));
  assert.equal(over.refStatus, 'failed');
  assert.ok(!('ref' in over));
});
