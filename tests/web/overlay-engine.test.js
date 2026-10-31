// extension/overlay.js (the engine) in a vm context with a fake DOM / chrome / window. Its dynamic imports
// (import(url('x.js'))) are rewritten to a loader that hands back the real extension modules, so the
// engine runs against the real site.js / overlay-state.js / timing.js. Covers what only the engine can show:
// persistent disable (site-off, {disabled:true} replies), toggle after disable, seek routing (Netflix never
// writes video.currentTime), and the navEvents {target, name} binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/overlay.js', import.meta.url), 'utf8');
const ENGINE = SRC.replace(/import\(url\('([a-z-]+\.js)'\)\)/g, "__imp('$1')");
const NF = 'https://www.netflix.com';
const NURL = NF + '/watch/81234567?trackId=1';
const YURL = 'https://www.youtube.com/watch?v=puh91fohvTA';
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const plain = (x) => JSON.parse(JSON.stringify(x));
let modSeq = 0;

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
    attachShadow: () => fakeEl('#shadow'),
    querySelector: () => null,
    getClientRects: () => [],
    getBoundingClientRect: () => ({ height: 0 }),
    getAttribute: () => null,
  };
  return e;
}

function fakeVideo() {
  const v = fakeEl('video');
  v.paused = true;
  v.ended = false;
  v.sets = [];
  v.plays = 0;
  let t = 3;
  Object.defineProperty(v, 'currentTime', { get: () => t, set: (x) => { v.sets.push(x); t = x; } });
  v.play = () => { v.plays++; return Promise.resolve(); };
  v.pause = () => { };
  return v;
}

// lesson: two cues at 2 s and 10 s
const LESSON = (id) => ({
  videoId: id, vocab: [],
  words: [{ t: 2, e: 4 }, { t: 10, e: 12 }],
  cues: [{ a: 0, b: 0, tokens: ['hello'], zh: '哈囉' }, { a: 1, b: 1, tokens: ['world'], zh: '世界' }],
});

async function boot(href, { replies = {}, hold = [] } = {}) {
  const u = new URL(href);
  const n = ++modSeq;
  const winListeners = {};
  const docListeners = {};
  const posted = [];
  const sentMsgs = [];
  const held = [];
  const logs = [];
  const video = fakeVideo();
  const root = fakeEl('div');
  root.querySelector = (q) => (q === 'video' || q === 'video.html5-main-video' ? video : null);
  const sel = { '.watch-video--player-view': root, '[data-purpose="shaka-video-player"]': root };
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
        sentMsgs.push(plain(msg));
        const r = replies[msg.type];
        if (hold.includes(msg.type)) held.push(() => cb(r));
        else setImmediate(() => cb(r));
      },
    },
  };
  const base = new URL('../../extension/', import.meta.url);
  const ctx = {
    chrome, document, window: win, location: { hostname: u.hostname, href },
    console: { log: (...a) => logs.push(a.slice(1)) },
    __imp: (f) => import(new URL(f, base).href + (f === 'site.js' ? '?n=' + n : '')),
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => { },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => { },
    MutationObserver: class { observe() { } disconnect() { } },
    ResizeObserver: class { observe() { } disconnect() { } },
    getComputedStyle: () => ({ position: 'absolute', lineHeight: '20' }),
    fetch: async () => ({ text: async () => '/* css */' }),
    AbortController, Promise, Map, Set, Number, String, Math, Object, Array, JSON, Error,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(ENGINE, ctx);
  await flush();
  const toggle = () => new Promise((resolve) => {
    const ret = onMessage({ type: 'ytlearn:toggle' }, {}, (r) => resolve(plain(r)));
    assert.equal(ret, true, 'toggle answers asynchronously');
  });
  const message = (msg) => onMessage(msg, {}, () => { throw new Error('site-off must not be answered'); });
  const key = (code) => {
    const ev = { code, preventDefault() { }, stopImmediatePropagation() { }, composedPath: () => [] };
    for (const f of winListeners.keydown || []) f(ev);
  };
  return { video, root, posted, sentMsgs, held, logs, toggle, message, key, winListeners, docListeners, win };
}

const nfOff = (b) => b.posted.filter((p) => p.data.type === 'ytlearn:nf-off');
const overlayHost = (b) => b.root.children.find((c) => c.id === 'ytlearn-overlay');

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

test('engine on YouTube / Udemy: a Netflix site-off is ignored', async () => {
  for (const href of [YURL, 'https://www.udemy.com/course/x/learn/lecture/5800738']) {
    const id = href === YURL ? 'puh91fohvTA' : 'udemy.5800738';
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
