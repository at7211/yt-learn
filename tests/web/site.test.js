// extension/site.js: the per-site adapters the overlay engine uses. Pure over a fake document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteFor, youtube, udemy, netflix, netflixSeeker, seekAckOk, NF_SEEK_ACK_MS } from '../../extension/site.js';

const A = 'puh91fohvTA';
const B = 'abcdefghijk';
const LURL = 'https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738?start=0#overview';

// Minimal fake DOM: elements answer querySelector by exact selector string from a map.
function elem(sel = {}, attrs = {}, classes = []) {
  return {
    querySelector: (q) => sel[q] || null,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    classList: classes,
  };
}
function doc({ byId = {}, sel = {} } = {}) {
  return { getElementById: (id) => byId[id] || null, querySelector: (q) => sel[q] || null };
}

test('siteFor: www.youtube.com, www.udemy.com and www.netflix.com only', () => {
  assert.equal(siteFor('www.youtube.com'), youtube);
  assert.equal(siteFor('www.udemy.com'), udemy);
  assert.equal(siteFor('www.netflix.com'), netflix);
  for (const h of ['youtube.com', 'm.youtube.com', 'udemy.com', 'mycompany.udemy.com', 'netflix.com', 'help.netflix.com', '127.0.0.1', '', undefined]) {
    assert.equal(siteFor(h), null, String(h));
  }
  assert.equal(youtube.name, 'youtube');
  assert.equal(udemy.name, 'udemy');
  assert.equal(netflix.name, 'netflix');
});

test('youtube.lessonId: URL id, null when ytd-watch-flexy[video-id] disagrees, null for Udemy URLs', () => {
  const W = 'https://www.youtube.com/watch?v=' + A;
  assert.equal(youtube.lessonId(W, doc()), A, 'no flexy yet');
  assert.equal(youtube.lessonId(W, doc({ sel: { 'ytd-watch-flexy': elem({}, { 'video-id': A }) } })), A);
  assert.equal(youtube.lessonId(W, doc({ sel: { 'ytd-watch-flexy': elem({}, {}) } })), A, 'attribute absent');
  assert.equal(youtube.lessonId(W, doc({ sel: { 'ytd-watch-flexy': elem({}, { 'video-id': B }) } })), null, 'mid-navigation');
  assert.equal(youtube.lessonId('https://www.youtube.com/feed/subscriptions', doc()), null);
  assert.equal(youtube.lessonId(LURL, doc()), null);
  assert.equal(youtube.lessonId('https://www.netflix.com/watch/81234567', doc()), null, 'netflix.<id> is not a YouTube lesson');
});

test('youtube.findPlayer: #movie_player + video.html5-main-video, falling back to any video', () => {
  const main = { tag: 'main' };
  const other = { tag: 'other' };
  const root = elem({ 'video.html5-main-video': main, video: other });
  assert.deepEqual(youtube.findPlayer(doc({ byId: { movie_player: root } })), { root, video: main });
  const root2 = elem({ video: other });
  assert.deepEqual(youtube.findPlayer(doc({ byId: { movie_player: root2 } })), { root: root2, video: other });
  assert.equal(youtube.findPlayer(doc({ byId: { movie_player: elem() } })), null, 'no video');
  assert.equal(youtube.findPlayer(doc()), null, 'no player');
});

test('youtube.isAd: ad-showing / ad-interrupting on the root', () => {
  assert.equal(youtube.isAd(elem({}, {}, ['html5-video-player', 'ad-showing'])), true);
  assert.equal(youtube.isAd(elem({}, {}, ['html5-video-player', 'ad-interrupting'])), true);
  assert.equal(youtube.isAd(elem({}, {}, ['html5-video-player', 'playing-mode'])), false);
  assert.equal(youtube.isAd(null), false);
});

test('youtube: native caption rule and navigation event are the pre-adapter ones', () => {
  assert.equal(youtube.nativeCaptionCss,
    '#movie_player.ytlearn-on .ytp-caption-window-container{opacity:0 !important;pointer-events:none !important}');
  // navEvents contract: [{target:'document'|'window', name}]
  assert.deepEqual(youtube.navEvents.map((e) => ({ ...e })), [{ target: 'document', name: 'yt-navigate-finish' }]);
  assert.equal(youtube.seek, undefined, 'the engine seeks YouTube itself (video.currentTime)');
});

test('udemy.lessonId: lecture URLs -> udemy.<id>, everything else null', () => {
  assert.equal(udemy.lessonId(LURL, doc()), 'udemy.5800738');
  assert.equal(udemy.lessonId('https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738/'), 'udemy.5800738');
  for (const u of ['https://www.udemy.com/course/30-days-of-python/', 'https://www.udemy.com/course/x/learn/quiz/1',
    'https://mycompany.udemy.com/course/x/learn/lecture/1', 'https://www.youtube.com/watch?v=' + A, '', undefined]) {
    assert.equal(udemy.lessonId(u, doc()), null, String(u));
  }
});

test('udemy.findPlayer: shaka root and its first video; null if either is missing', () => {
  const SHAKA = '[data-purpose="shaka-video-player"]';
  const v = { tag: 'video' };
  const root = elem({ video: v });
  assert.deepEqual(udemy.findPlayer(doc({ sel: { [SHAKA]: root } })), { root, video: v });
  assert.equal(udemy.findPlayer(doc({ sel: { [SHAKA]: elem() } })), null);
  assert.equal(udemy.findPlayer(doc({ sel: { video: v } })), null, 'a video outside the player does not count');
});

test('udemy: never an ad, hides its own caption container, no navigation events (the poll is the router)', () => {
  assert.equal(udemy.isAd(elem({}, {}, ['ad-showing'])), false);
  assert.equal(udemy.nativeCaptionCss, '[data-purpose="shaka-video-player"].ytlearn-on [class*="caption-container"]{opacity:0}');
  assert.deepEqual([...udemy.navEvents], []);
  assert.equal(udemy.seek, undefined, 'the engine seeks Udemy itself (video.currentTime)');
});

/* ---------- Netflix ---------- */

const NURL = 'https://www.netflix.com/watch/81234567?trackId=14277281';
const NF_ROOT = '.watch-video--player-view';

test('netflix.lessonId: watch pages -> netflix.<movieId>, everything else null', () => {
  assert.equal(netflix.lessonId(NURL, doc()), 'netflix.81234567');
  assert.equal(netflix.lessonId('https://www.netflix.com/watch/81234567/'), 'netflix.81234567');
  for (const u of ['https://www.netflix.com/browse', 'https://www.netflix.com/title/81234567', 'https://www.netflix.com/watch/123abc',
    'http://www.netflix.com/watch/1', 'https://www.youtube.com/watch?v=' + A, LURL, '', undefined]) {
    assert.equal(netflix.lessonId(u, doc()), null, String(u));
  }
});

test('netflix.findPlayer: .watch-video--player-view and the first video inside it; null if either is missing', () => {
  const v = { tag: 'video' };
  const root = elem({ video: v });
  assert.deepEqual(netflix.findPlayer(doc({ sel: { [NF_ROOT]: root } })), { root, video: v });
  assert.equal(netflix.findPlayer(doc({ sel: { [NF_ROOT]: elem() } })), null, 'no video yet');
  assert.equal(netflix.findPlayer(doc({ sel: { video: v } })), null, 'a video outside the player view does not count');
  assert.equal(netflix.findPlayer(doc()), null);
  assert.equal(netflix.findPlayer(null), null);
});

test('netflix: never an ad, hides .player-timedtext while on, popstate on window, has its own seek', () => {
  assert.equal(netflix.isAd(elem({}, {}, ['ad-showing'])), false);
  assert.equal(netflix.nativeCaptionCss, '.watch-video--player-view.ytlearn-on .player-timedtext{opacity:0 !important}');
  assert.deepEqual(netflix.navEvents.map((e) => ({ ...e })), [{ target: 'window', name: 'popstate' }]);
  assert.equal(typeof netflix.seek, 'function');
  assert.equal(typeof netflix.cancelSeek, 'function');
  for (const s of [youtube, udemy, netflix]) {
    for (const e of s.navEvents) assert.ok((e.target === 'document' || e.target === 'window') && typeof e.name === 'string', s.name);
  }
});

// A fake window: records postMessage, lets the test deliver message events, and a manual clock.
function fakeWin() {
  const posted = [];
  const listeners = new Set();
  const timers = new Map();
  let nextTimer = 1;
  const logs = [];
  const win = {
    postMessage: (data, origin) => posted.push({ data, origin }),
    addEventListener: (name, f) => { if (name === 'message') listeners.add(f); },
    removeEventListener: (name, f) => { if (name === 'message') listeners.delete(f); },
  };
  const env = {
    win,
    log: (...a) => logs.push(a),
    setTimeout: (f, ms) => { const id = nextTimer++; timers.set(id, { f, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  const deliver = (data, ev = {}) => { for (const f of [...listeners]) f({ source: win, origin: 'https://www.netflix.com', data, ...ev }); };
  const fire = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.f(); } };
  return { win, env, posted, listeners, timers, logs, deliver, fire };
}

const ack = (requestId, ok = true, extra = {}) => ({ type: 'ytlearn:nf-seek-ack', requestId, hook: 1, ok, ...extra });

test('netflix seek: returns true and posts ytlearn:nf-seek {requestId, expectedMovieId, ms (rounded), play} to the netflix origin', () => {
  const f = fakeWin();
  const sk = netflixSeeker(f.env);
  const video = { tag: 'video' };
  assert.equal(sk.seek(video, 61.2346, { play: true, lessonId: 'netflix.81234567', gen: 4 }), true);
  assert.equal(f.posted.length, 1);
  const { data, origin } = f.posted[0];
  assert.equal(origin, 'https://www.netflix.com');
  assert.equal(typeof data.requestId, 'string');
  assert.ok(data.requestId.length > 0 && data.requestId.length <= 64);
  assert.deepEqual({ ...data, requestId: 'x' }, { type: 'ytlearn:nf-seek', requestId: 'x', expectedMovieId: '81234567', ms: 61235, play: true });
  assert.deepEqual(sk.pending(), { requestId: data.requestId, lessonId: 'netflix.81234567', gen: 4, video });
  assert.equal([...f.timers.values()][0].ms, NF_SEEK_ACK_MS);
  assert.equal(NF_SEEK_ACK_MS, 1000);
  // negative times clamp to 0; play stays a boolean
  sk.seek(video, -3, { play: false, lessonId: 'netflix.81234567', gen: 4 });
  assert.equal(f.posted[1].data.ms, 0);
  assert.equal(f.posted[1].data.play, false);
  assert.notEqual(f.posted[1].data.requestId, data.requestId);
});

test('netflix seek: the request passes the hook-side validator (netflix-manifest.js ytLearnNfValidateRequest)', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const ctx = { TextEncoder, URL };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../../extension/netflix-manifest.js', import.meta.url), 'utf8'), ctx);
  const f = fakeWin();
  netflixSeeker(f.env).seek({}, 12.5, { play: true, lessonId: 'netflix.81234567', gen: 1 });
  assert.equal(ctx.ytLearnNfValidateRequest(JSON.parse(JSON.stringify(f.posted[0].data))), null);
  // and the minimal ack check agrees with the full one on the shapes the hook sends
  const rid = f.posted[0].data.requestId;
  for (const a of [ack(rid), ack(rid, false, { error: 'noSession' })]) {
    assert.equal(seekAckOk(a, rid), true);
    assert.equal(ctx.ytLearnNfValidateSeekAck(JSON.parse(JSON.stringify(a)), rid), null);
  }
});

test('seekAckOk: type, matching requestId, boolean ok', () => {
  assert.equal(seekAckOk(ack('r1'), 'r1'), true);
  assert.equal(seekAckOk(ack('r1', false), 'r1'), true);
  for (const m of [null, undefined, 'x', {}, ack('r2'), { ...ack('r1'), type: 'ytlearn:nf-manifest' }, { ...ack('r1'), ok: 'yes' }, { type: 'ytlearn:nf-seek-ack', requestId: 'r1' }]) {
    assert.equal(seekAckOk(m, 'r1'), false, JSON.stringify(m));
  }
});

test('netflix seek: ok ack clears the pending request silently; ok:false is logged; both remove the listener and the timer', () => {
  const f = fakeWin();
  const sk = netflixSeeker(f.env);
  sk.seek({}, 1, { play: false, lessonId: 'netflix.81234567', gen: 1 });
  const rid = f.posted[0].data.requestId;
  f.deliver(ack(rid));
  assert.equal(sk.pending(), null);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.logs, []);
  sk.seek({}, 2, { play: false, lessonId: 'netflix.81234567', gen: 1 });
  f.deliver(ack(f.posted[1].data.requestId, false, { error: 'outOfRange' }));
  assert.equal(sk.pending(), null);
  assert.deepEqual(f.logs, [['nf-seek:failed', 'netflix.81234567', 'outOfRange']]);
  assert.equal(f.listeners.size, 0);
});

test('netflix seek: acks from another window/origin, with the wrong requestId or malformed are ignored; timeout after 1 s is logged', () => {
  const f = fakeWin();
  const sk = netflixSeeker(f.env);
  sk.seek({}, 1, { play: true, lessonId: 'netflix.81234567', gen: 1 });
  const rid = f.posted[0].data.requestId;
  f.deliver(ack(rid), { source: {} });
  f.deliver(ack(rid), { origin: 'https://evil.example' });
  f.deliver(ack('other'));
  f.deliver({ ...ack(rid), ok: 1 });
  f.deliver(null);
  assert.equal(sk.pending().requestId, rid, 'still waiting');
  assert.deepEqual(f.logs, []);
  f.fire();
  assert.equal(sk.pending(), null);
  assert.deepEqual(f.logs, [['nf-seek:timeout', 'netflix.81234567']]);
  assert.equal(f.listeners.size, 0);
  f.deliver(ack(rid, false, { error: 'late' }));
  assert.equal(f.logs.length, 1, 'a late ack after the timeout is dropped');
});

test('netflix seek: a new seek supersedes the previous one; cancel() (teardown / episode change / switch-off) drops it', () => {
  const f = fakeWin();
  const sk = netflixSeeker(f.env);
  sk.seek({}, 1, { play: true, lessonId: 'netflix.81234567', gen: 1 });
  const first = f.posted[0].data.requestId;
  sk.seek({}, 2, { play: true, lessonId: 'netflix.81234567', gen: 1 });
  const second = f.posted[1].data.requestId;
  assert.equal(f.listeners.size, 1);
  assert.equal(f.timers.size, 1);
  f.deliver(ack(first, false, { error: 'old' }));
  assert.deepEqual(f.logs, [], 'the superseded request\'s ack is ignored');
  assert.equal(sk.pending().requestId, second);
  sk.cancel();
  assert.equal(sk.pending(), null);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
  f.deliver(ack(second, false, { error: 'late' }));
  f.fire();
  assert.deepEqual(f.logs, []);
  sk.cancel(); // idempotent
});

test('netflix seek: a malformed lesson id posts nothing but still returns true (never video.currentTime on Netflix)', () => {
  const f = fakeWin();
  const sk = netflixSeeker(f.env);
  for (const lessonId of [undefined, 'puh91fohvTA', 'udemy.1', 'netflix.', 'netflix.12a']) {
    assert.equal(sk.seek({}, 1, { play: true, lessonId, gen: 1 }), true, String(lessonId));
  }
  assert.equal(f.posted.length, 0);
  assert.equal(f.listeners.size, 0);
});
