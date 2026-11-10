// extension/overlay.js (the engine) in a vm context with a fake DOM / chrome / window. Its dynamic imports
// (import(url('x.js'))) are rewritten to a loader that hands back the real extension modules, so the
// engine runs against the real site.js / overlay-state.js / timing.js. Covers what only the engine can show:
// persistent disable (site-off, {disabled:true} replies), toggle after disable, seek routing (Netflix never
// writes video.currentTime), and the navEvents {target, name} binding.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/overlay.js', import.meta.url), 'utf8');
const ENGINE = SRC.replace(/import\(url\('([a-z-]+\.js)'\)\)/g, "__imp('$1')");
const NF = 'https://www.netflix.com';
const NURL = NF + '/watch/81234567?trackId=1';
const YURL = 'https://www.youtube.com/watch?v=puh91fohvTA';
const HI = 'https://www.hellointerview.com/learn/';
const HURL = HI + 'system-design/patterns/dealing-with-contention';
const HID = 'hello.system-design.patterns.dealing-with-contention';
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));
let modSeq = 0;
const booted = [];
// site.js's default Netflix seeker runs a real 1 s ack timer in this process: drop it after every test.
afterEach(() => { while (booted.length) booted.pop().cleanup(); });

// Controllable clock for the vm: setTimeout / setInterval queue up, tick(ms) runs what falls due in order.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, f, every }
  const add = (f, ms, every) => { const id = nextId++; const d = Math.max(0, Number(ms) || 0); timers.set(id, { at: now + d, f, every: every ? Math.max(1, d) : 0 }); return id; };
  const clear = (id) => { timers.delete(id); };
  const tick = (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      now = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.f();
    }
    now = end;
  };
  return { setTimeout: (f, ms) => add(f, ms, false), setInterval: (f, ms) => add(f, ms, true), clearTimeout: clear, clearInterval: clear, tick, pending: () => timers.size };
}

function fakeEl(tag = 'div') {
  const classes = new Set();
  const e = {
    tagName: tag.toUpperCase(), id: '', textContent: '', hidden: false, dataset: {}, children: [], parentNode: null,
    style: { cssText: '', position: '' }, listeners: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c), toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)); },
    get isConnected() { return !!e.parentNode; },
    append: (...kids) => { for (const k of kids) { if (k && typeof k === 'object') { k.parentNode = e; e.children.push(k); } } },
    replaceChildren: (...kids) => { e.children = []; e.append(...kids); },
    remove: () => { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter((k) => k !== e); e.parentNode = null; },
    addEventListener: (n, f) => { (e.listeners[n] = e.listeners[n] || []).push(f); },
    attachShadow: () => { e.shadow = fakeEl('#shadow'); return e.shadow; },
    querySelector: () => null,
    // only what the phrase code asks for: the subtitle's word spans
    querySelectorAll: (q) => (q === '.w[data-i]' ? descendants(e).filter((k) => k.classList && k.classList.contains('w') && k.dataset.i != null) : []),
    contains: (k) => descendants(e).includes(k),
    getClientRects: () => [],
    getBoundingClientRect: () => ({ height: 0 }),
    getAttribute: () => null,
  };
  return e;
}

function descendants(n) { return (n.children || []).flatMap((k) => [k, ...descendants(k)]); }

function fakeVideo() {
  const v = fakeEl('video');
  v.paused = true;
  v.ended = false;
  v.sets = [];
  v.plays = 0;
  let t = 3;
  Object.defineProperty(v, 'currentTime', { get: () => t, set: (x) => { v.sets.push(x); t = x; } });
  v.play = () => { v.plays++; return Promise.resolve(); };
  v.pauses = 0;
  v.pause = () => { v.pauses++; };
  return v;
}

// lesson: two cues at 2 s and 10 s
const LESSON = (id) => ({
  videoId: id, vocab: [],
  words: [{ t: 2, e: 4 }, { t: 10, e: 12 }],
  cues: [{ a: 0, b: 0, tokens: ['hello'], zh: '哈囉' }, { a: 1, b: 1, tokens: ['world'], zh: '世界' }],
});

async function boot(href, { replies = {}, hold = [], position = 'absolute', adapt = null } = {}) {
  const u = new URL(href);
  const n = ++modSeq;
  const winListeners = {};
  const docListeners = {};
  const posted = [];
  const sentMsgs = [];
  const notesMsgs = []; // ytlearn:notes (sent once per mount) kept apart so sentMsgs stays the lesson/build flow
  const held = [];
  const logs = [];
  const video = fakeVideo();
  const root = fakeEl('div');
  root.querySelector = (q) => (q === 'video' || q === 'video.html5-main-video' ? video : null);
  const sel = { '.watch-video--player-view': root, '[data-purpose="shaka-video-player"]': root };
  // HelloInterview: the video carries a captions track and sits inside a [data-media-player] root.
  // swapPlayer() replaces both (the site rebuilds the player on every navigation); null removes it.
  const hello = (r, v) => {
    v.querySelector = (q) => (q === 'track[kind="captions"]' ? { kind: 'captions' } : null);
    v.closest = (q) => (q === '[data-media-player]' ? r : null);
    v.parentElement = r;
    return { root: r, video: v };
  };
  let player = hello(root, video);
  const win = {
    addEventListener: (name, f) => { (winListeners[name] = winListeners[name] || []).push(f); },
    removeEventListener: (name, f) => { winListeners[name] = (winListeners[name] || []).filter((x) => x !== f); },
    postMessage: (data, origin) => posted.push({ data: plain(data), origin }),
  };
  // site.js's default Netflix seeker posts on globalThis.window of the module realm (this process).
  globalThis.window = win;
  const document = {
    head: fakeEl('head'), documentElement: fakeEl('html'),
    querySelector: (q) => sel[q] || null,
    querySelectorAll: (q) => (q === 'video' && player ? [player.video] : []),
    getElementById: (id) => (id === 'movie_player' ? root : null),
    createElement: (t) => fakeEl(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    addEventListener: (name, f) => { (docListeners[name] = docListeners[name] || []).push(f); },
  };
  let onMessage = null;
  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => 'chrome-extension://x/' + p,
      onMessage: { addListener: (f) => { onMessage = f; } },
      sendMessage: (msg, cb) => {
        (msg.type === 'ytlearn:notes' ? notesMsgs : sentMsgs).push(plain(msg));
        const r = typeof replies[msg.type] === 'function' ? replies[msg.type](msg) : replies[msg.type];
        if (hold.includes(msg.type)) held.push(() => cb(r));
        else setImmediate(() => cb(r));
      },
    },
  };
  const base = new URL('../../extension/', import.meta.url);
  const clock = fakeClock();
  const location = { hostname: u.hostname, href };
  let siteMod = null;
  const ctx = {
    chrome, document, window: win, location,
    console: { log: (...a) => logs.push(a.slice(1)) },
    __imp: (f) => import(new URL(f, base).href + (f === 'site.js' ? '?n=' + n : '')).then((m) => {
      if (f !== 'site.js') return m;
      siteMod = m;
      // adapt: hand the engine a modified adapter (e.g. a broken Netflix seek) to test the engine's own guards
      return adapt ? { ...m, siteFor: (h) => { const a = m.siteFor(h); return a && adapt(a); } } : m;
    }),
    setInterval: clock.setInterval, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, clearInterval: clock.clearInterval,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => { },
    MutationObserver: class { observe() { } disconnect() { } },
    ResizeObserver: class { observe() { } disconnect() { } },
    getComputedStyle: () => ({ position, lineHeight: '20' }),
    fetch: async () => ({ text: async () => '/* css */' }),
    AbortController, Promise, Map, Set, Number, String, Math, Object, Array, JSON, Error,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(ENGINE, ctx);
  await flush();
  const toggle = (type = 'ytlearn:toggle', extra = {}) => new Promise((resolve) => {
    const ret = onMessage({ type, ...(type === 'ytlearn:mount' && !('videoId' in extra) ? { videoId: lessonOf(location.href) } : {}), ...extra }, {}, (r) => resolve(plain(r)));
    assert.equal(ret, true, 'toggle answers asynchronously');
  });
  const message = (msg) => onMessage(msg, {}, () => { throw new Error('site-off must not be answered'); });
  const key = (code) => {
    const ev = { code, preventDefault() { }, stopImmediatePropagation() { }, composedPath: () => [] };
    for (const f of winListeners.keydown || []) f(ev);
  };
  const cleanup = () => { if (siteMod) siteMod.netflix.cancelSeek(); };
  booted.push({ cleanup });
  const tick = async (ms) => { clock.tick(ms); await flush(); };
  const setReply = (type, r) => { replies[type] = r; };
  const swapPlayer = (gone = false) => {
    if (gone) { player = null; return null; }
    const r = fakeEl('div');
    const v = fakeVideo();
    r.querySelector = (q) => (q === 'video' ? v : null);
    player = hello(r, v);
    return player;
  };
  return { setReply, clock, tick, location, cleanup, video, root, swapPlayer, posted, sentMsgs, notesMsgs, held, logs, toggle, message, key, winListeners, docListeners, win };
}

const lessonOf = (href) => { const m = /\/watch\/([0-9]+)/.exec(href); return m ? 'netflix.' + m[1] : new URL(href).searchParams.get('v'); };
const nfOff = (b) => b.posted.filter((p) => p.data.type === 'ytlearn:nf-off');
const overlayHost = (b, root = b.root) => root.children.find((c) => c.id === 'ytlearn-overlay');

test('engine on Netflix: toggle mounts the lesson; R seeks through the hook (nf-seek), never video.currentTime', async () => {
  const b = await boot(NURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('netflix.81234567') } } });
  assert.deepEqual(await b.toggle(), { handled: true });
  await flush();
  assert.deepEqual(b.sentMsgs, [{ type: 'ytlearn:lesson', videoId: 'netflix.81234567' }]);
  assert.ok(overlayHost(b), 'mounted inside .watch-video--player-view');
  assert.equal(b.root.style.position, '', 'an absolute root is left alone (no posFix)');
  b.video.currentTime = 11; // the test moves the clock (recorded, then cleared)
  b.video.sets.length = 0;
  b.key('KeyR'); // replay the current cue: 10 s
  const seeks = b.posted.filter((p) => p.data.type === 'ytlearn:nf-seek');
  assert.equal(seeks.length, 1);
  assert.equal(seeks[0].origin, NF);
  assert.deepEqual({ ...seeks[0].data, requestId: 'x' }, { type: 'ytlearn:nf-seek', requestId: 'x', expectedMovieId: '81234567', ms: 10000, play: true });
  assert.deepEqual(b.video.sets, [], 'video.currentTime is never written on Netflix');
  assert.equal(b.video.plays, 0, 'play is the hook\'s job (play:true in the request)');
  b.key('BracketLeft'); // previous cue: 2 s; the pending request is superseded
  const seeks2 = b.posted.filter((p) => p.data.type === 'ytlearn:nf-seek');
  assert.equal(seeks2.length, 2);
  assert.equal(seeks2[1].data.ms, 2000);
  assert.equal((b.winListeners.message || []).length, 1, 'one pending ack listener at a time');
  assert.deepEqual(b.video.sets, []);
});

test('engine on YouTube: R still writes video.currentTime and resumes a paused video (unchanged)', async () => {
  const b = await boot(YURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('puh91fohvTA') } } });
  assert.deepEqual(await b.toggle(), { handled: true });
  await flush();
  b.video.currentTime = 11;
  b.video.sets.length = 0;
  b.key('KeyR');
  assert.deepEqual(b.video.sets, [10]);
  assert.equal(b.video.plays, 1);
  assert.equal(b.posted.length, 0, 'no postMessage on YouTube');
});

test('engine on Netflix: ytlearn:site-off -> overlay gone, nf-off to the hook, pending seek dropped; toggle -> {handled:true}, nothing sent', async () => {
  const b = await boot(NURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('netflix.81234567') } } });
  await b.toggle();
  await flush();
  b.video.currentTime = 11;
  b.key('KeyR');
  assert.equal((b.winListeners.message || []).length, 1);
  assert.equal(b.message({ type: 'ytlearn:site-off', site: 'netflix' }), false, 'no reply to site-off');
  await flush();
  assert.equal(overlayHost(b), undefined, 'overlay removed');
  assert.equal(b.root.classList.contains('ytlearn-on'), false);
  assert.deepEqual(nfOff(b), [{ data: { type: 'ytlearn:nf-off' }, origin: NF }]);
  assert.equal((b.winListeners.message || []).length, 0, 'the pending seek listener is gone');
  const before = b.sentMsgs.length;
  assert.deepEqual(await b.toggle(), { handled: true });
  await flush();
  assert.equal(b.sentMsgs.length, before, 'a disabled page sends nothing');
  b.key('KeyR');
  assert.equal(b.posted.filter((p) => p.data.type === 'ytlearn:nf-seek').length, 1, 'no keys after disable');
  // popstate (episode change) does nothing either
  for (const f of b.winListeners.popstate || []) f({});
  await flush();
  assert.equal(b.sentMsgs.length, before);
  b.message({ type: 'ytlearn:site-off', site: 'netflix' });
  await flush();
  assert.equal(nfOff(b).length, 1, 'disable is idempotent');
});

test('engine on YouTube / Udemy / HelloInterview: a Netflix site-off is ignored', async () => {
  for (const href of [YURL, 'https://www.udemy.com/course/x/learn/lecture/5800738', HURL]) {
    const id = href === YURL ? 'puh91fohvTA' : href === HURL ? HID : 'udemy.5800738';
    const b = await boot(href, { replies: { 'ytlearn:lesson': { lesson: LESSON(id) } } });
    await b.toggle();
    await flush();
    b.message({ type: 'ytlearn:site-off', site: 'netflix' });
    await flush();
    assert.ok(overlayHost(b), href + ': still mounted');
    assert.deepEqual(b.posted, [], href);
    assert.deepEqual(await b.toggle(), { handled: true });
    await flush();
    assert.equal(overlayHost(b), undefined, href + ': the toggle still turns it off');
  }
});

test('engine on Netflix: a {disabled:true} lesson reply disables the page before the caller sees it', async () => {
  const b = await boot(NURL, { replies: { 'ytlearn:lesson': { disabled: true } } });
  assert.deepEqual(await b.toggle(), { handled: true });
  await flush();
  assert.deepEqual(nfOff(b).length, 1);
  assert.equal(overlayHost(b), undefined);
  assert.equal(b.root.children.length, 0, 'no error pill either');
  assert.deepEqual(await b.toggle(), { handled: true });
  await flush();
  assert.equal(b.sentMsgs.length, 1, 'only the first lesson request was ever sent');
});

test('engine on Netflix: a {disabled:true} build reply (switched off while capturing) disables the page', async () => {
  const b = await boot(NURL, { replies: { 'ytlearn:lesson': { missing: true }, 'ytlearn:build': { ok: false, disabled: true, error: 'Netflix 尚未啟用' } } });
  await b.toggle();
  await flush();
  assert.deepEqual(b.sentMsgs.map((m) => m.type), ['ytlearn:lesson', 'ytlearn:build']);
  assert.equal(nfOff(b).length, 1);
  assert.equal(b.root.children.length, 0, 'the pill is removed, not turned into an error');
});

test('engine: navEvents bind on their target (Netflix popstate on window, YouTube yt-navigate-finish on document)', async () => {
  const n = await boot(NURL);
  assert.equal((n.winListeners.popstate || []).length, 1);
  assert.deepEqual(Object.keys(n.docListeners), []);
  const y = await boot(YURL);
  assert.equal((y.docListeners['yt-navigate-finish'] || []).length, 1);
  assert.equal((y.winListeners.popstate || []).length, 0);
});

test('engine: a lesson reply that arrives after the page was torn down never mounts (toggle-off, site-off)', async () => {
  const off = await boot(NURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('netflix.81234567') } }, hold: ['ytlearn:lesson'] });
  await off.toggle();
  await flush();
  assert.deepEqual(await off.toggle(), { handled: true }, 'building: the second click turns it off');
  off.held.forEach((f) => f());
  await flush();
  assert.equal(overlayHost(off), undefined);
  const so = await boot(NURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('netflix.81234567') } }, hold: ['ytlearn:lesson'] });
  await so.toggle();
  await flush();
  so.message({ type: 'ytlearn:site-off', site: 'netflix' });
  await flush();
  so.held.forEach((f) => f());
  await flush();
  assert.equal(overlayHost(so), undefined);
  assert.equal(so.root.children.length, 0);
});

/* ---------- with the clock: job poll, pushState episode change, posFix ---------- */

test('engine on Netflix: a job poll answered {disabled:true} disables the page; no poll fires afterwards', async () => {
  const b = await boot(NURL, { replies: { 'ytlearn:lesson': { missing: true }, 'ytlearn:build': { ok: true, inProgress: true },
    'ytlearn:job': { job: { videoId: 'netflix.81234567', state: 'capturing', attempt: 1, message: '' } } } });
  const replies = (t) => b.sentMsgs.filter((m) => m.type === t).length;
  await b.toggle();
  await flush();
  assert.deepEqual(b.sentMsgs.map((m) => m.type), ['ytlearn:lesson', 'ytlearn:build']);
  assert.ok(b.root.children.some((c) => c.id === 'ytlearn-pill'), 'pill shown while building');
  b.sentMsgs.length = 0;
  await b.tick(1999);
  assert.equal(replies('ytlearn:job'), 0, 'not before POLL_MS');
  await b.tick(1);
  assert.equal(replies('ytlearn:job'), 1);
  // the reply table is read at send time: the next poll is answered {disabled:true}
  b.setReply('ytlearn:job', { disabled: true });
  await b.tick(2000);
  assert.equal(replies('ytlearn:job'), 2);
  assert.equal(nfOff(b).length, 1, 'disabled by the poll reply');
  assert.equal(b.root.children.length, 0, 'pill gone');
  await b.tick(20000);
  assert.equal(replies('ytlearn:job'), 2, 'no poll after the disable');
  assert.equal(replies('ytlearn:lesson'), 0);
});

test('engine on Netflix: pushState episode change (href changes, no event) -> within 1 s the old overlay is torn down and the new id is routed', async () => {
  const b = await boot(NURL, { replies: { 'ytlearn:lesson': (msg) => (msg.videoId === 'netflix.81234567' ? { lesson: LESSON('netflix.81234567') } : { missing: true }) } });
  await b.toggle();
  await flush();
  assert.ok(overlayHost(b));
  b.location.href = NF + '/watch/81234568';
  await b.tick(999);
  assert.ok(overlayHost(b), 'not yet: the route poll runs every 1000 ms');
  await b.tick(1);
  assert.equal(overlayHost(b), undefined, 'old overlay torn down');
  assert.deepEqual(b.sentMsgs.at(-1), { type: 'ytlearn:lesson', videoId: 'netflix.81234568' }, 'the new episode is routed (autoload, no capture)');
  assert.ok(!b.sentMsgs.some((m) => m.type === 'ytlearn:build'), 'a missing lesson does not start a capture on its own');
  assert.equal(b.root.children.length, 0, 'no pill for a silent autoload miss');
});

test('engine on HelloInterview: pushState lesson change with a new {root, video} -> old overlay torn down, new id routed and remounted when a lesson exists', async () => {
  const NID = 'hello.system-design.patterns.other-pattern';
  const b = await boot(HURL, { replies: { 'ytlearn:lesson': (msg) => ({ lesson: LESSON(msg.videoId) }) } });
  assert.equal((b.winListeners.popstate || []).length, 1, 'popstate bound on window');
  assert.deepEqual(Object.keys(b.docListeners), []);
  assert.deepEqual(await b.toggle(), { handled: true });
  await flush();
  assert.deepEqual(b.sentMsgs, [{ type: 'ytlearn:lesson', videoId: HID }]);
  assert.ok(overlayHost(b), 'mounted inside the [data-media-player] root');
  assert.ok(b.root.classList.contains('ytlearn-on'));
  // the site pushes a new URL and rebuilds the player: no event fires, the 1 s poll catches it
  b.location.href = HI + 'system-design/patterns/other-pattern';
  const next = b.swapPlayer();
  await b.tick(999);
  assert.ok(overlayHost(b), 'not yet: the route poll runs every 1000 ms');
  await b.tick(1);
  assert.equal(overlayHost(b), undefined, 'old overlay torn down');
  assert.equal(b.root.classList.contains('ytlearn-on'), false, 'old root released');
  assert.deepEqual(b.sentMsgs.at(-1), { type: 'ytlearn:lesson', videoId: NID }, 'the new lesson is routed (autoload)');
  assert.ok(overlayHost(b, next.root), 'remounted on the new player root');
  assert.ok(next.root.classList.contains('ytlearn-on'));
  assert.ok(!b.sentMsgs.some((m) => m.type === 'ytlearn:build'), 'autoload never starts a capture');
  // back: popstate routes at once (no wait for the poll), onto yet another rebuilt player
  b.location.href = HURL;
  const back = b.swapPlayer();
  for (const f of b.winListeners.popstate) f({});
  await flush();
  assert.equal(overlayHost(b, next.root), undefined);
  assert.deepEqual(b.sentMsgs.at(-1), { type: 'ytlearn:lesson', videoId: HID });
  assert.ok(overlayHost(b, back.root), 'remounted after popstate');
  // seeking: the engine writes video.currentTime itself on HelloInterview (no adapter seek)
  back.video.currentTime = 11;
  back.video.sets.length = 0;
  b.key('KeyR');
  assert.deepEqual(back.video.sets, [10]);
  assert.deepEqual(b.posted, [], 'nothing posted to the page');
});

test('engine on HelloInterview: pushState lesson change with a new {root, video} -> collapses when the new lesson has none', async () => {
  const b = await boot(HURL, { replies: { 'ytlearn:lesson': (msg) => (msg.videoId === HID ? { lesson: LESSON(HID) } : { missing: true }) } });
  await b.toggle();
  await flush();
  assert.ok(overlayHost(b));
  b.location.href = HI + 'system-design/patterns/other-pattern';
  const next = b.swapPlayer();
  await b.tick(1000);
  assert.equal(overlayHost(b), undefined, 'old overlay torn down');
  assert.deepEqual(b.sentMsgs.at(-1), { type: 'ytlearn:lesson', videoId: 'hello.system-design.patterns.other-pattern' });
  assert.equal(overlayHost(b, next.root), undefined, 'nothing mounted on the new player');
  assert.equal(next.root.children.length, 0, 'no pill for a silent autoload miss');
  assert.ok(!b.sentMsgs.some((m) => m.type === 'ytlearn:build'));
  // an article page (a learn URL, but the player is gone): still collapsed, never a capture
  const sent = b.sentMsgs.length;
  b.location.href = HI + 'courses/system-design';
  b.swapPlayer(true);
  await b.tick(1000);
  assert.ok(!b.sentMsgs.slice(sent).some((m) => m.type === 'ytlearn:build'));
  assert.deepEqual(b.sentMsgs.at(-1), { type: 'ytlearn:lesson', videoId: 'hello.courses.system-design' });
  assert.equal(next.root.children.length, 0);
  assert.equal(overlayHost(b), undefined);
});

test('engine on YouTube: a static player root gets position:relative while mounted and its old value back on teardown', async () => {
  const b = await boot(YURL, { position: 'static', replies: { 'ytlearn:lesson': { lesson: LESSON('puh91fohvTA') } } });
  b.root.style.position = '';
  await b.toggle();
  await flush();
  assert.ok(overlayHost(b));
  assert.equal(b.root.style.position, 'relative');
  await b.toggle();
  await flush();
  assert.equal(overlayHost(b), undefined);
  assert.equal(b.root.style.position, '', 'restored');
});

test('engine on Netflix: defense in depth — even an adapter whose seek returns false (or is missing) never gets video.currentTime written', async () => {
  for (const adapt of [(a) => ({ ...a, seek: () => false }), (a) => { const { seek, ...rest } = a; void seek; return rest; }]) {
    const b = await boot(NURL, { adapt, replies: { 'ytlearn:lesson': { lesson: LESSON('netflix.81234567') } } });
    await b.toggle();
    await flush();
    assert.ok(overlayHost(b));
    b.video.currentTime = 11;
    b.video.sets.length = 0;
    b.key('KeyR');
    b.key('BracketRight');
    assert.deepEqual(b.video.sets, [], 'no currentTime write on Netflix');
    assert.equal(b.video.plays, 0);
  }
  // the same broken adapter on YouTube still seeks by currentTime (the guard is Netflix-only)
  const y = await boot(YURL, { adapt: (a) => ({ ...a, seek: () => false }), replies: { 'ytlearn:lesson': { lesson: LESSON('puh91fohvTA') } } });
  await y.toggle();
  await flush();
  y.video.currentTime = 11;
  y.video.sets.length = 0;
  y.key('KeyR');
  assert.deepEqual(y.video.sets, [10]);
});

test('engine: ytlearn:mount leaves a mounted or building overlay on, turns an off one on, and is a no-op once disabled', async () => {
  const b = await boot(NURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('netflix.81234567') } } });
  await b.toggle();
  await flush();
  const host = overlayHost(b);
  assert.ok(host);
  assert.deepEqual(await b.toggle('ytlearn:mount'), { handled: true });
  await flush();
  assert.equal(overlayHost(b), host, 'same overlay, still mounted (a toggle would have removed it)');
  assert.equal(b.sentMsgs.length, 1, 'no new lesson request');
  // building: the pending build is kept
  const k = await boot(NURL, { replies: { 'ytlearn:lesson': { missing: true }, 'ytlearn:build': { ok: true, inProgress: true } }, hold: ['ytlearn:build'] });
  await k.toggle();
  await flush();
  assert.ok(k.root.children.some((c) => c.id === 'ytlearn-pill'));
  assert.deepEqual(await k.toggle('ytlearn:mount'), { handled: true });
  await flush();
  assert.ok(k.root.children.some((c) => c.id === 'ytlearn-pill'), 'pill (build) still there');
  assert.deepEqual(k.sentMsgs.map((m) => m.type), ['ytlearn:lesson', 'ytlearn:build']);
  // off (turned off by the user) -> mount turns it on like a toggle
  await b.toggle();
  await flush();
  assert.equal(overlayHost(b), undefined);
  assert.deepEqual(await b.toggle('ytlearn:mount'), { handled: true });
  await flush();
  assert.ok(overlayHost(b), 'mounted again');
  // disabled -> handled, nothing happens
  b.message({ type: 'ytlearn:site-off', site: 'netflix' });
  await flush();
  const sent = b.sentMsgs.length;
  assert.deepEqual(await b.toggle('ytlearn:mount'), { handled: true });
  await flush();
  assert.equal(b.sentMsgs.length, sent);
  assert.equal(overlayHost(b), undefined);
});

test('engine: ytlearn:mount for another episode (the tab moved on) -> {handled:true}, nothing loaded or built', async () => {
  const b = await boot(NF + '/watch/81234568', { replies: { 'ytlearn:lesson': { missing: true }, 'ytlearn:build': { ok: true } } });
  assert.deepEqual(await b.toggle('ytlearn:mount', { videoId: 'netflix.81234567' }), { handled: true });
  await flush();
  assert.deepEqual(b.sentMsgs, [], 'no lesson request, no build for an episode nobody asked for');
  assert.equal(b.root.children.length, 0);
  for (const extra of [{ videoId: undefined }, { videoId: 81234568 }]) {
    assert.deepEqual(await b.toggle('ytlearn:mount', extra), { handled: true });
    await flush();
    assert.deepEqual(b.sentMsgs, [], JSON.stringify(extra));
  }
  // the matching id mounts as before
  assert.deepEqual(await b.toggle('ytlearn:mount', { videoId: 'netflix.81234568' }), { handled: true });
  await flush();
  assert.deepEqual(b.sentMsgs.map((m) => m.type), ['ytlearn:lesson', 'ytlearn:build']);
});

/* ---------- phrase notes (我的片語): loaded on mount, a note row seeks without playing and opens its card ---------- */

const findCls = (n, cls) => descendants(n).filter((k) => k.classList && k.classList.contains(cls));
const shadowOf = (b) => overlayHost(b).shadow;
const NOTE1 = { phrase: 'world', cueEn: 'world', cue: 1, a: 1, b: 1, result: { meaningZh: '世界', whyHere: 'w', pattern: 'p', examples: [{ en: 'e', zh: 'z' }], alternatives: [] }, ts: 't' };
const notesReply = { status: 200, json: { ok: true, notes: { '1-1': NOTE1 } } };
const evt = () => ({ stopPropagation() { }, preventDefault() { } });

test('engine: mount asks ytlearn:notes for the lesson; a note fills the 我的片語 list and opens the panel tab', async () => {
  const b = await boot(YURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('puh91fohvTA') }, 'ytlearn:notes': notesReply } });
  await b.toggle();
  await flush();
  assert.deepEqual(b.notesMsgs, [{ type: 'ytlearn:notes', videoId: 'puh91fohvTA' }]);
  const root = shadowOf(b);
  const rows = findCls(root, 'nrow');
  assert.equal(rows.length, 1);
  assert.deepEqual(descendants(rows[0]).map((k) => k.textContent), ['world', '世界']);
  const tab = findCls(root, 'ptab')[0];
  assert.equal(tab.hidden, false);
  assert.equal(findCls(root, 'panel')[0].hidden, false, 'notes keep the panel up even with no vocab');
  assert.equal(findCls(root, 'pnotes')[0].hidden, false, 'no vocab: the notes list is the panel');
  // the subtitle: one .w per token with its global index
  const words = findCls(root, 'w');
  assert.deepEqual(words.map((w) => [w.textContent, w.dataset.i]), [['hello', '0']]);
});

test('engine on Netflix: a note row pauses and seeks through the hook with play:false (never currentTime), draws the cue, opens the card; Esc closes it', async () => {
  const b = await boot(NURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('netflix.81234567') }, 'ytlearn:notes': notesReply } });
  await b.toggle();
  await flush();
  const root = shadowOf(b);
  b.video.sets.length = 0;
  const pauses = b.video.pauses;
  findCls(root, 'nrow')[0].listeners.click[0](evt());
  const seeks = b.posted.filter((p) => p.data.type === 'ytlearn:nf-seek');
  assert.equal(seeks.length, 1);
  assert.equal(seeks[0].data.play, false);
  assert.equal(seeks[0].data.ms, 10050);
  assert.deepEqual(b.video.sets, [], 'video.currentTime is never written on Netflix');
  assert.equal(b.video.plays, 0);
  assert.ok(b.video.pauses > pauses);
  const w = findCls(root, 'w');
  assert.deepEqual(w.map((x) => [x.textContent, x.dataset.i, x.classList.contains('noted'), x.classList.contains('sel')]), [['world', '1', true, true]]);
  const card = findCls(root, 'ph-card')[0];
  assert.equal(card.hidden, false);
  assert.ok(descendants(card).some((k) => k.textContent === '世界'));
  assert.equal(b.sentMsgs.filter((m) => m.type === 'ytlearn:explain').length, 0, 'a saved note never asks the AI');
  b.key('Escape');
  assert.equal(card.hidden, true);
  assert.equal(findCls(root, 'w')[0].classList.contains('sel'), false);
});

test('engine on YouTube: a note row seeks with video.currentTime and does not play; playing closes the card', async () => {
  const b = await boot(YURL, { replies: { 'ytlearn:lesson': { lesson: LESSON('puh91fohvTA') }, 'ytlearn:notes': notesReply } });
  await b.toggle();
  await flush();
  const root = shadowOf(b);
  b.video.sets.length = 0;
  findCls(root, 'nrow')[0].listeners.click[0](evt());
  assert.deepEqual(b.video.sets, [10.05]);
  assert.equal(b.video.plays, 0);
  const card = findCls(root, 'ph-card')[0];
  assert.equal(card.hidden, false);
  for (const f of b.video.listeners.play || []) f({});
  assert.equal(card.hidden, true);
});

test('overlay source: phrase.js imported, explain messages, no HTML sinks', () => {
  assert.ok(SRC.includes("import(url('phrase.js'))"));
  for (const t of ["type: 'ytlearn:explain'", "type: 'ytlearn:explain-poll'", "type: 'ytlearn:notes'"]) assert.ok(SRC.includes(t), t);
  assert.ok(!/\.(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\(/.test(SRC), 'only the header comment names the sinks');
  assert.ok(SRC.includes('elementFromPoint'), 'hit testing through the shadow root');
});
