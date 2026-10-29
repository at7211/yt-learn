// Runs extension/background.js in a vm context with a fake chrome + fake fetch (the capture.test.js
// technique) and checks the overlay's message types and the icon's watch-page toggle branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const YTID = readFileSync(new URL('../../extension/ytid.js', import.meta.url), 'utf8');
const EXT = 'ext-id';
const VID = 'puh91fohvTA';
const LESSON = { videoId: VID, cues: [], words: [], vocab: [] };

// routes: { 'GET /path': {status, json} | 'down' }
function load(routes = {}, { toggleReply, executeScript } = {}) {
  const calls = { fetched: [], created: [], sent: [], removed: [], sessionSets: [], bodies: {} };
  const listeners = {};
  const on = (name) => ({ addListener: (f) => { listeners[name] = f; } });
  const store = {};
  const chrome = {
    runtime: { id: EXT, getManifest: () => ({ version: '1.2.0' }), onMessage: on('message'), onMessageExternal: on('external') },
    tabs: {
      onUpdated: on('updated'), onRemoved: on('removed'),
      create: async (o) => { calls.created.push(o); return { id: 99 }; },
      remove: async (id) => { calls.removed.push(id); }, update: async () => {}, get: async (id) => ({ id }),
      sendMessage: async (tabId, msg) => {
        calls.sent.push({ tabId, msg });
        const r = Array.isArray(toggleReply) ? toggleReply[Math.min(calls.sent.length - 1, toggleReply.length - 1)] : toggleReply;
        if (r instanceof Error) throw r;
        return r;
      },
    },
    action: { onClicked: on('clicked'), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    storage: { session: { get: async (k) => ({ [k]: store[k] }), set: async (o) => { calls.sessionSets.push(JSON.stringify(o)); Object.assign(store, o); } } },
    scripting: { executeScript: executeScript || (async () => { throw new Error('not in tests'); }) },
  };
  const ctx = {
    chrome, URL, Promise, Date, JSON, Error, console: { log() {} }, setTimeout, clearTimeout,
    AbortSignal: { timeout: () => undefined },
    fetch: async (url, init) => {
      const path = url.replace('http://127.0.0.1:8765', '');
      const key = (init.method || 'GET') + ' ' + path;
      calls.fetched.push(key);
      if (init.body) calls.bodies[key] = JSON.parse(init.body);
      const r = routes[key];
      if (r === undefined || r === 'down') throw new TypeError('fetch failed');
      return { status: r.status, json: async () => { if (r.json === undefined) throw new SyntaxError('not json'); return r.json; } };
    },
  };
  ctx.globalThis = ctx;
  ctx.importScripts = () => vm.runInContext(YTID, ctx);
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, calls, listeners };
}

// sendResponse may be called synchronously (validation errors) or later (fetches): normalise both.
function ask(w, msg, sender) {
  return new Promise((resolve) => {
    let ret;
    let got = false;
    ret = w.listeners.message(msg, sender || { id: EXT, tab: { id: 7 } }, (r) => { got = true; resolve({ r, ret: () => ret }); });
    if (!got && ret !== true) resolve({ r: undefined, ret: () => ret });
  }).then(({ r, ret }) => ({ r, ret: ret() }));
}

test('ytlearn:lesson: ok -> {lesson}, async (returns true)', async () => {
  const w = load({ ['GET /data/lessons/' + VID + '.json']: { status: 200, json: LESSON } });
  const { r, ret } = await ask(w, { type: 'ytlearn:lesson', videoId: VID });
  assert.equal(ret, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { lesson: LESSON });
  assert.deepEqual(w.calls.fetched, ['GET /data/lessons/' + VID + '.json']);
});

test('ytlearn:lesson: 404 -> {missing:true}', async () => {
  const w = load({ ['GET /data/lessons/' + VID + '.json']: { status: 404 } });
  const { r } = await ask(w, { type: 'ytlearn:lesson', videoId: VID });
  assert.deepEqual({ ...r }, { missing: true });
});

test('ytlearn:lesson: server unreachable -> {error}', async () => {
  const w = load({});
  const { r } = await ask(w, { type: 'ytlearn:lesson', videoId: VID });
  assert.match(r.error, /本機 server 沒有回應/);
  assert.equal(r.lesson, undefined);
});

test('ytlearn:lesson: other HTTP errors -> {error}', async () => {
  const w = load({ ['GET /data/lessons/' + VID + '.json']: { status: 500, json: { error: 'boom' } } });
  const { r } = await ask(w, { type: 'ytlearn:lesson', videoId: VID });
  assert.deepEqual({ ...r }, { error: 'boom' });
});

test('ytlearn:job: ok -> {job}; 404 -> {missing:true}; unreachable -> {error}', async () => {
  const job = { videoId: VID, state: 'building', attempt: 1, message: '', progress: { phase: 'segment', done: 2, total: 6 } };
  const ok = load({ ['GET /jobs/' + VID]: { status: 200, json: { job } } });
  const a = await ask(ok, { type: 'ytlearn:job', videoId: VID });
  assert.equal(a.ret, true);
  assert.deepEqual(JSON.parse(JSON.stringify(a.r)), { job });
  const missing = load({ ['GET /jobs/' + VID]: { status: 404, json: { ok: false, error: 'no such job' } } });
  assert.deepEqual({ ...(await ask(missing, { type: 'ytlearn:job', videoId: VID })).r }, { missing: true });
  const down = load({});
  assert.match((await ask(down, { type: 'ytlearn:job', videoId: VID })).r.error, /本機 server/);
});

test('overlay messages validate the video id and the sender', async () => {
  const w = load({});
  for (const type of ['ytlearn:lesson', 'ytlearn:job', 'ytlearn:build']) {
    const { r, ret } = await ask(w, { type, videoId: '../../etc' });
    assert.equal(ret, false);
    assert.deepEqual({ ...r }, { error: '無法辨識的影片 id' });
  }
  const foreign = await ask(w, { type: 'ytlearn:lesson', videoId: VID }, { id: 'someone-else', tab: { id: 1 } });
  assert.equal(foreign.ret, false);
  assert.equal(foreign.r, undefined);
  assert.deepEqual(w.calls.fetched, []);
});

test('ytlearn:build: runs the job in the sender tab without opening a tab', async () => {
  const w = load({ 'POST /add': { status: 200, json: { job: { videoId: VID, state: 'done', attempt: 1, message: '完成' } } } });
  const { r, ret } = await ask(w, { type: 'ytlearn:build', videoId: VID });
  assert.equal(ret, true);
  assert.equal(r.ok, true);
  assert.equal(r.done, true);
  assert.deepEqual(w.calls.fetched, ['POST /add']);
  assert.deepEqual(w.calls.created, [], 'no player tab, no background capture tab');
});

test('ytlearn:build: queued -> claim -> capture in the sender tab -> ingest; no tab created/removed, ownedTabs untouched', async () => {
  const targets = [];
  const raw = { videoId: VID, events: [{ t: 0, d: 1000, segs: [[0, 'hi']] }] };
  const executeScript = async (o) => {
    targets.push(o.target.tabId);
    return o.files ? [{ result: undefined }] : [{ result: { ok: true, raw } }];
  };
  const w = load({
    'POST /add': { status: 200, json: { job: { videoId: VID, state: 'queued', attempt: 1, message: '' } } },
    ['POST /jobs/' + VID + '/claim']: { status: 200, json: { attempt: 1 } },
    'POST /ingest?attempt=1': { status: 200, json: { ok: true, job: { videoId: VID, state: 'captured', attempt: 1, message: '' } } },
  }, { executeScript });
  await new Promise((r) => setTimeout(r, 10)); // let the startup ownedTabs cleanup finish
  const setsAtStartup = w.calls.sessionSets.length;
  const { r, ret } = await ask(w, { type: 'ytlearn:build', videoId: VID }, { id: EXT, tab: { id: 42 } });
  assert.equal(ret, true);
  assert.equal(r.ok, true);
  assert.equal(r.job.state, 'captured');
  assert.deepEqual(w.calls.fetched, ['POST /add', 'POST /jobs/' + VID + '/claim', 'POST /ingest?attempt=1']);
  assert.deepEqual(targets, [42, 42], 'capture injected into the sender tab only');
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.bodies['POST /ingest?attempt=1'])), raw);
  assert.deepEqual(w.calls.created, []);
  assert.deepEqual(w.calls.removed, []);
  assert.equal(w.calls.sessionSets.length, setsAtStartup, 'ownedTabs never written by the overlay build');
});

test('ytlearn:build: job already running -> inProgress, no capture', async () => {
  const w = load({ 'POST /add': { status: 200, json: { job: { videoId: VID, state: 'building', attempt: 1, message: '' } } } });
  const { r } = await ask(w, { type: 'ytlearn:build', videoId: VID });
  assert.equal(r.ok, true);
  assert.equal(r.inProgress, true);
  assert.deepEqual(w.calls.created, []);
});

test('ytlearn:build: server down -> {ok:false, error}', async () => {
  const w = load({});
  const { r } = await ask(w, { type: 'ytlearn:build', videoId: VID });
  assert.equal(r.ok, false);
  assert.match(r.error, /本機 server/);
});

test('icon on a watch page: overlay answers {handled:true} -> nothing else happens', async () => {
  const w = load({}, { toggleReply: { handled: true } });
  await w.ctx.onIconClicked({ id: 7, url: 'https://www.youtube.com/watch?v=' + VID });
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.sent)), [{ tabId: 7, msg: { type: 'ytlearn:toggle' } }]);
  assert.deepEqual(w.calls.fetched, []);
  assert.deepEqual(w.calls.created, []);
});

const NO_RECEIVER = new Error('Could not establish connection. Receiving end does not exist.');

test('icon on a watch page: no content script (tab predates the reload) -> inject overlay.js and ask again', async () => {
  const injected = [];
  const w = load({}, { toggleReply: [NO_RECEIVER, { handled: true }], executeScript: async (o) => { injected.push(o); return [{}]; } });
  await w.ctx.onIconClicked({ id: 7, url: 'https://www.youtube.com/watch?v=' + VID });
  assert.deepEqual(JSON.parse(JSON.stringify(injected)), [{ target: { tabId: 7 }, files: ['overlay.js'] }]);
  assert.equal(w.calls.sent.length, 2);
  assert.deepEqual(w.calls.fetched, []);
  assert.deepEqual(w.calls.created, []);
});

test('icon on a watch page: injection also fails -> original flow opens the player tab', async () => {
  const w = load({ 'POST /add': { status: 200, json: { job: { videoId: VID, state: 'done', attempt: 1, message: '完成' } } } },
    { toggleReply: NO_RECEIVER, executeScript: async () => { throw new Error('Cannot access contents of the page'); } });
  await w.ctx.onIconClicked({ id: 7, url: 'https://www.youtube.com/watch?v=' + VID });
  assert.equal(w.calls.sent.length, 1);
  assert.deepEqual(w.calls.fetched, ['POST /add']);
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.created)), [{ url: 'http://127.0.0.1:8765/index.html?v=' + VID, active: true }]);
});

test('icon on a watch page: overlay declines ({handled:false}) -> original flow', async () => {
  const w = load({ 'POST /add': { status: 200, json: { job: { videoId: VID, state: 'done', attempt: 1, message: '完成' } } } },
    { toggleReply: { handled: false } });
  await w.ctx.onIconClicked({ id: 7, url: 'https://www.youtube.com/watch?v=' + VID });
  assert.equal(w.calls.created.length, 1);
});

test('icon off a watch page never asks the overlay', async () => {
  const w = load({}, { toggleReply: { handled: true } });
  await w.ctx.onIconClicked({ id: 7, url: 'https://www.youtube.com/feed/subscriptions' });
  assert.deepEqual(w.calls.sent, []);
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.created)), [{ url: 'http://127.0.0.1:8765/index.html', active: true }]);
});

test('ping still answered synchronously', async () => {
  const w = load({});
  const { r, ret } = await ask(w, { type: 'ytlearn:ping' });
  assert.equal(ret, false);
  assert.equal(r.type, 'ytlearn:ack');
  assert.equal(r.version, '1.2.0');
});
