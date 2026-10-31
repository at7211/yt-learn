// extension/netflix-manifest.js + extension/netflix-hook.js in a vm context (the page's MAIN world):
// JSON.parse transparency, the manifest cache, and the window.postMessage bridge.
// The context has its own JSON intrinsic, so wrapping it never touches the test runner's JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const LIB = readFileSync(new URL('../../extension/netflix-manifest.js', import.meta.url), 'utf8');
const HOOK = readFileSync(new URL('../../extension/netflix-hook.js', import.meta.url), 'utf8');
const ORIGIN = 'https://www.netflix.com';
const plain = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setTimeout(r, 0));
const U = (n) => `https://ipv4-c0${n}-tpe001-ix.1.oca.nflxvideo.net/?o=1&v=${n}`;

const manifestText = (movieId, { old = false, wrap = true } = {}) => {
  const m = old
    ? { movieId, duration: 1500000, timedtexttracks: [{ language: 'en', type: 'PRIMARY', isForcedNarrative: false, ttDownloadables: { 'imsc1.1': { downloadUrls: { 1: U(1) } } } }] }
    : { movieId, duration: 1500000, textTracks: [{ bcp47: 'en', trackType: 'PRIMARY', isForcedNarrative: false, downloadables: { 'imsc1.1': { urls: [{ url: U(1) }] }, simplesdh: { urls: [{ url: U(2) }] } } }] };
  return JSON.stringify(wrap ? { version: 'v1', result: m } : m);
};

// player: {movieId, currentMs, durationMs, sessionId} | null
function page({ path = '/watch/81234567', player = { movieId: 81234567, currentMs: 61000, durationMs: 1500000 }, metadata, domTitle, beforeHook } = {}) {
  const posted = [];
  const listeners = [];
  const calls = { seek: [], play: [] };
  const ctx = {
    URL, TextEncoder, setTimeout, clearTimeout,
    location: { pathname: path },
    addEventListener: (name, f) => { if (name === 'message') listeners.push(f); },
    postMessage: (data, targetOrigin) => {
      posted.push({ data: plain(data), targetOrigin });
      setTimeout(() => { for (const f of listeners.slice()) f({ source: win, origin: ORIGIN, data: plain(data) }); }, 0);
    },
    document: {
      querySelector: (s) => (s === '[data-uia="video-title"]' && domTitle ? { textContent: domTitle, querySelector: () => null } : null),
    },
  };
  if (player) {
    const p = {
      getMovieId: () => player.movieId, getCurrentTime: () => player.currentMs, getDuration: () => player.durationMs,
      seek: (ms) => calls.seek.push(ms), play: () => calls.play.push(true),
    };
    ctx.netflix = { appContext: { state: { playerApp: { getAPI: () => ({
      videoPlayer: {
        getAllPlayerSessionIds: () => ['preview-1', player.sessionId || 'watch-abc'],
        getVideoPlayerBySessionId: (id) => (id.startsWith('watch-') ? p : { getMovieId: () => 1 }),
      },
      getVideoMetadataByVideoId: (id) => { if (!metadata) throw new Error('nope'); return metadata(id); },
    }) } } } };
  }
  vm.createContext(ctx);
  const win = vm.runInContext('globalThis', ctx);
  vm.runInContext('var window = globalThis;', ctx);
  if (beforeHook) beforeHook(win);
  const native = vm.runInContext('JSON.parse', ctx);
  vm.runInContext(LIB, ctx);
  vm.runInContext(HOOK, ctx);
  // A message from another world (same window, netflix origin) unless overridden.
  const send = (data, ev = {}) => { for (const f of listeners.slice()) f({ source: win, origin: ORIGIN, data, ...ev }); };
  const replies = (type) => posted.map((p) => p.data).filter((d) => d.type === type);
  const parse = (text, reviver) => (reviver ? win.JSON.parse(text, reviver) : win.JSON.parse(text));
  return { ctx, win, native, posted, send, replies, parse, calls, listeners };
}

async function get(p, movieId, nonce = 'n' + Math.random()) {
  p.send({ type: 'ytlearn:nf-get', nonce, movieId });
  await tick();
  const r = p.replies('ytlearn:nf-manifest').filter((d) => d.nonce === nonce);
  assert.equal(r.length, 1, 'exactly one reply');
  assert.equal(p.win.ytLearnNfValidateGetReply(r[0], movieId), null, 'reply passes the caller validator');
  return r[0];
}

test('JSON.parse is wrapped once, keeps name/arity, returns the very same result, and never logs', () => {
  const p = page();
  assert.notEqual(p.win.JSON.parse, p.native);
  assert.equal(p.win.JSON.parse.name, 'parse');
  assert.equal(p.win.JSON.parse.length, 2);
  assert.deepEqual(plain(p.parse('{"a":[1,2,{"b":null}]}')), { a: [1, 2, { b: null }] });
  assert.ok(!/console\./.test(HOOK), 'the hook never writes to the console');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(HOOK), 'the hook never sends a request');
});

test('a reviver is honoured exactly like the native call (same call count) and the call is not summarised', async () => {
  const p = page();
  const text = manifestText(81234567);
  let nativeCalls = 0;
  let hookCalls = 0;
  const a = p.native.call(p.win.JSON, text, function (k, v) { nativeCalls++; return v; });
  const b = p.parse(text, function (k, v) { hookCalls++; return v; });
  assert.equal(hookCalls, nativeCalls);
  assert.ok(hookCalls > 5);
  assert.deepEqual(plain(b), plain(a));
  const r = await get(p, '81234567');
  assert.equal(r.state, 'pending', 'reviver calls are never summarised');
  assert.equal(r.stats.skippedReviver, 1);
  assert.equal(r.stats.suspected, 0);
});

test('native exceptions propagate unchanged (same class and message)', () => {
  const p = page();
  let want;
  try { p.native.call(p.win.JSON, '{bad'); } catch (e) { want = e; }
  assert.throws(() => p.parse('{bad'), (e) => e instanceof p.win.SyntaxError && e.message === want.message);
  assert.throws(() => p.win.JSON.parse(), (e) => e instanceof p.win.SyntaxError);
  const boom = new Error('reviver boom');
  assert.throws(() => p.parse('{"a":1}', () => { throw boom; }), (e) => e === boom);
});

test('primitives and null parse as usual and only count as parsed', async () => {
  const p = page();
  assert.equal(p.parse('1'), 1);
  assert.equal(p.parse('null'), null);
  assert.equal(p.parse('"x"'), 'x');
  assert.equal(p.parse('true'), true);
  const r = await get(p, '81234567');
  assert.equal(r.stats.parsed, 4);
  assert.equal(r.stats.suspected, 0);
});

test('this is passed through, the original is called exactly once, frozen results are returned untouched', async () => {
  const seen = [];
  const frozen = Object.freeze({ result: Object.freeze(JSON.parse(manifestText(81234567, { wrap: false }))) });
  const p = page({
    beforeHook: (win) => {
      win.JSON.parse = function (text) { seen.push({ self: this, text }); return frozen; };
    },
  });
  const self = { me: 1 };
  const out = p.win.JSON.parse.call(self, 'anything');
  assert.equal(out, frozen, 'same object');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].self, self);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.result));
  const r = await get(p, '81234567');
  assert.equal(r.state, 'found');
});

test('installing twice is a no-op (no double wrapping)', () => {
  const p = page();
  const first = p.win.JSON.parse;
  const listeners = p.listeners.length;
  vm.runInContext(HOOK, p.ctx);
  assert.equal(p.win.JSON.parse, first);
  assert.equal(p.listeners.length, listeners);
});

test('nf-get: found (new and old names, .result or root) with title and currentMs; pending for another movie', async () => {
  const p = page({ metadata: (id) => ({ _video: { title: 'Episode ' + id } }) });
  p.parse(manifestText(81234567));
  const r = await get(p, '81234567');
  assert.equal(r.state, 'found');
  assert.equal(r.hook, 1);
  assert.equal(r.currentMs, 61000);
  assert.equal(r.title, 'Episode 81234567');
  assert.deepEqual(r.manifest.tracks, [{ lang: 'en', type: 'PRIMARY', name: '', forced: false, formats: { 'imsc1.1': U(1) } }]);
  assert.deepEqual(r.stats, { parsed: 1, suspected: 1, summarized: 1, unknownShape: 0, skippedReviver: 0 });
  p.parse(manifestText(70000001, { old: true, wrap: false }));
  assert.equal((await get(p, '70000001')).state, 'found');
  const other = await get(p, '99');
  assert.equal(other.state, 'pending');
  assert.equal('manifest' in other, false);
  assert.equal('currentMs' in other, false, 'no session for that movie');
});

test('nf-get: title falls back to the DOM, then is omitted', async () => {
  const p = page({ domTitle: '  Some   Show  E1 ' });
  p.parse(manifestText(81234567));
  assert.equal((await get(p, '81234567')).title, 'Some Show E1');
  const q = page();
  q.parse(manifestText(81234567));
  assert.equal('title' in (await get(q, '81234567')), false);
});

test('unknownShape is per movieId: a suspected-but-unreadable manifest -> unsupported for that movie only; a later good one wins', async () => {
  const p = page();
  p.parse(JSON.stringify({ result: { movieId: 5550001, audioTracks: [], textTracks: 'renamed' } }));
  assert.equal((await get(p, '5550001')).state, 'unsupported');
  assert.equal((await get(p, '81234567')).state, 'pending');
  const r = await get(p, '81234567');
  assert.equal(r.stats.unknownShape, 1);
  p.parse(manifestText(5550001));
  assert.equal((await get(p, '5550001')).state, 'found');
});

test('the cache keeps the 10 most recent manifests (LRU by movieId; re-parsing refreshes)', async () => {
  const p = page();
  for (let i = 1; i <= 11; i++) p.parse(manifestText(1000 + i));
  p.parse(manifestText(1002)); // refresh 1002 -> 1003 is now the oldest
  p.parse(manifestText(1012));
  assert.equal((await get(p, '1001')).state, 'pending');
  assert.equal((await get(p, '1003')).state, 'pending');
  for (const id of [1002, 1004, 1011, 1012]) assert.equal((await get(p, String(id))).state, 'found', String(id));
});

test('bridge ignores other windows, other origins and malformed requests', async () => {
  const p = page();
  p.send({ type: 'ytlearn:nf-get', nonce: 'a', movieId: '81234567' }, { source: {} });
  p.send({ type: 'ytlearn:nf-get', nonce: 'b', movieId: '81234567' }, { origin: 'https://evil.example' });
  p.send({ type: 'ytlearn:nf-get', nonce: 'c', movieId: 81234567 });
  p.send({ type: 'ytlearn:nf-seek', requestId: 'r', expectedMovieId: '81234567', ms: 1, play: 'true' });
  p.send(null);
  p.send('ytlearn:nf-off');
  await tick();
  assert.deepEqual(p.posted, []);
  assert.notEqual(p.win.JSON.parse, p.native, 'still on');
});

test('replies use the netflix origin as targetOrigin', async () => {
  const p = page();
  await get(p, '81234567');
  assert.ok(p.posted.length > 0);
  assert.ok(p.posted.every((x) => x.targetOrigin === ORIGIN));
});

async function seek(p, msg) {
  const requestId = 'r' + Math.random();
  p.send({ type: 'ytlearn:nf-seek', requestId, expectedMovieId: '81234567', ms: 30000, play: false, ...msg });
  await tick();
  const acks = p.replies('ytlearn:nf-seek-ack').filter((d) => d.requestId === requestId);
  assert.equal(acks.length, 1);
  assert.equal(p.win.ytLearnNfValidateSeekAck(acks[0], requestId), null, 'ack passes the caller validator');
  return acks[0];
}

test('nf-seek: checks session, URL and duration, then calls the player API seek (and play only when asked)', async () => {
  const p = page();
  const first = plain(await seek(p, {}));
  assert.deepEqual(first, { type: 'ytlearn:nf-seek-ack', requestId: first.requestId, hook: 1, ok: true });
  assert.deepEqual(p.calls.seek, [30000]);
  assert.deepEqual(p.calls.play, []);
  const ok = await seek(p, { ms: 1500000, play: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.hook, 1);
  assert.deepEqual(p.calls.seek, [30000, 1500000]);
  assert.deepEqual(p.calls.play, [true]);
  assert.equal((await seek(p, { ms: 1500001 })).error, 'outOfRange');
  assert.equal((await seek(p, { expectedMovieId: '1' })).error, 'urlMismatch');
  assert.equal((await seek(page({ path: '/watch/1' }), {})).error, 'urlMismatch');
  assert.equal((await seek(page({ player: null }), {})).error, 'noSession');
  assert.equal((await seek(page({ player: { movieId: 81234567, currentMs: 0, durationMs: 1, sessionId: 'preview-9' } }), {})).error, 'noSession');
  assert.equal((await seek(page({ player: { movieId: 81234567, currentMs: 0, durationMs: NaN } }), {})).error, 'outOfRange');
  assert.equal(p.calls.seek.length, 2, 'refused seeks never touch the player');
});

test('nf-off: permanent no-op, cache cleared, JSON.parse restored; replies become off', async () => {
  const p = page();
  p.parse(manifestText(81234567));
  p.send({ type: 'ytlearn:nf-off' });
  await tick();
  assert.equal(p.posted.length, 0, 'nf-off has no reply');
  assert.equal(p.win.JSON.parse, p.native, 'restored');
  const r = await get(p, '81234567');
  assert.equal(r.state, 'off');
  assert.equal('manifest' in r, false);
  assert.deepEqual({ ok: (await seek(p, {})).ok, error: (await seek(p, {})).error }, { ok: false, error: 'off' });
  assert.deepEqual(p.calls.seek, []);
});

test('nf-off when someone else wrapped JSON.parse after us: their wrapper stays, ours becomes a pass-through', async () => {
  const p = page();
  const ours = p.win.JSON.parse;
  const theirs = function parse(t) { return ours.call(this, t); };
  p.win.JSON.parse = theirs;
  p.send({ type: 'ytlearn:nf-off' });
  await tick();
  assert.equal(p.win.JSON.parse, theirs);
  p.parse(manifestText(81234567));
  const r = await get(p, '81234567');
  assert.equal(r.state, 'off');
  assert.equal(r.stats.parsed, 0, 'no summarising after off');
});
