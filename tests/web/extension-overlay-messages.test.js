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
// nf: the Netflix side of the fake — { local: storage.local contents, perm: site permission granted,
//     registered: [content scripts already registered], tabs: what tabs.query({url}|{}) returns,
//     request: (opts) => boolean|Promise (permissions.request), registerFails, unregisterFails,
//     tabUrls: {tabId: url} for tabs.get, onLocalSet: (o, local) => void (runs after each storage.local.set) }
function load(routes = {}, { toggleReply, executeScript, windows, nf = {} } = {}) {
  const calls = { fetched: [], created: [], sent: [], removed: [], sessionSets: [], bodies: {}, menus: [], menuOps: [],
    winCreated: [], winUpdated: [], tabQueries: [], tabUpdates: [], localSets: [], permOps: [], scriptOps: [],
    menuUpdates: [], reloaded: [], order: [] };
  const local = JSON.parse(JSON.stringify(nf.local || {}));
  const perm = { granted: nf.perm === true };
  const registered = new Map((nf.registered || []).map((r) => [r.id, JSON.parse(JSON.stringify(r))]));
  let nextWin = 500;
  const listeners = {};
  const on = (name) => ({ addListener: (f) => { listeners[name] = f; } });
  const store = {};
  const chrome = {
    runtime: { id: EXT, getManifest: () => ({ version: '1.3.1' }), onMessage: on('message'), onMessageExternal: on('external'),
               onInstalled: on('installed'), lastError: undefined, getURL: (p) => 'chrome-extension://' + EXT + '/' + p },
    permissions: {
      onRemoved: on('permRemoved'),
      contains: async (o) => { calls.permOps.push('contains'); return perm.granted && o.origins[0] === 'https://www.netflix.com/*'; },
      request: (o) => {
        calls.permOps.push('request');
        const r = nf.request ? nf.request(o) : true;
        return Promise.resolve(r).then((g) => { if (g) perm.granted = true; return g; });
      },
      remove: async (o) => { calls.permOps.push('remove'); calls.order.push('permissions.remove'); perm.granted = false; return true; },
    },
    contextMenus: {
      onClicked: on('menuClicked'),
      removeAll: (cb) => { calls.menuOps.push('removeAll'); calls.menus.length = 0; if (cb) cb(); return Promise.resolve(); },
      create: (o, cb) => {
        calls.menuOps.push('create:' + o.id);
        if (calls.menus.some((m) => m.id === o.id)) throw new Error('duplicate id ' + o.id);
        calls.menus.push(o);
        if (cb) cb();
        return o.id;
      },
      update: (id, o, cb) => { calls.menuUpdates.push([id, o.checked]); if (cb) cb(); },
    },
    tabs: {
      onUpdated: on('updated'), onRemoved: on('removed'),
      create: async (o) => { calls.created.push(o); return { id: 99 }; },
      remove: async (id) => { calls.removed.push(id); },
      get: async (id) => (nf.tabUrls && nf.tabUrls[id] ? { id, url: nf.tabUrls[id] } : { id }),
      update: async (id, o) => { calls.tabUpdates.push([id, o]); },
      reload: async (id) => { calls.reloaded.push(id); },
      query: async (q) => {
        calls.tabQueries.push(q);
        if (!('windowId' in q)) return nf.tabs || [];
        return windows && windows.query ? windows.query(q) : [{ id: q.windowId * 10 }];
      },
      sendMessage: async (tabId, msg) => {
        calls.sent.push({ tabId, msg });
        if (msg.type === 'ytlearn:site-off') { calls.order.push('site-off:' + tabId); if (nf.offFails && nf.offFails.includes(tabId)) throw new Error('no receiver'); return undefined; }
        const r = Array.isArray(toggleReply) ? toggleReply[Math.min(calls.sent.length - 1, toggleReply.length - 1)] : toggleReply;
        if (r instanceof Error) throw r;
        return r;
      },
    },
    action: { onClicked: on('clicked'), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    storage: {
      session: { get: async (k) => ({ [k]: store[k] }), set: async (o) => { calls.sessionSets.push(JSON.stringify(o)); Object.assign(store, o); } },
      local: {
        get: async (k) => (k in local ? { [k]: JSON.parse(JSON.stringify(local[k])) } : {}),
        set: async (o) => {
          calls.localSets.push(JSON.parse(JSON.stringify(o)));
          if (o.netflix) calls.order.push('local:' + JSON.stringify(o.netflix));
          Object.assign(local, JSON.parse(JSON.stringify(o)));
          if (nf.onLocalSet) nf.onLocalSet(o, local);
        },
      },
    },
    scripting: {
      executeScript: executeScript || (async () => { throw new Error('not in tests'); }),
      getRegisteredContentScripts: async (f) => [...registered.values()].filter((r) => !f || !f.ids || f.ids.includes(r.id))
        .map((r) => JSON.parse(JSON.stringify(r))),
      registerContentScripts: async (list) => {
        calls.scriptOps.push('register:' + list.map((r) => r.id).join(','));
        if (nf.registerFails) throw new Error('register failed');
        for (const r of list) if (registered.has(r.id)) throw new Error('Duplicate script ID ' + r.id);
        for (const r of list) registered.set(r.id, JSON.parse(JSON.stringify(r)));
      },
      unregisterContentScripts: async (f) => {
        calls.scriptOps.push('unregister:' + f.ids.join(','));
        calls.order.push('unregister');
        if (nf.unregisterFails) throw new Error('unregister failed');
        for (const id of f.ids) if (!registered.has(id)) throw new Error('Nonexistent script ID ' + id);
        for (const id of f.ids) registered.delete(id);
      },
    },
    windows: {
      onRemoved: on('winRemoved'),
      create: async (o) => { calls.winCreated.push(o); return { id: nextWin++ }; },
      update: async (id, o) => { calls.winUpdated.push([id, o]); if (windows && windows.update) return windows.update(id, o); return { id }; },
    },
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
  return { ctx, calls, listeners, store, local, perm, registered };
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
  assert.equal(r.version, '1.3.1');
});

test('install builds the action menu items (two links + the Netflix checkbox) after removeAll, and reinstall does not duplicate them', () => {
  const w = load();
  w.listeners.installed({ reason: 'install' });
  w.listeners.installed({ reason: 'update' });
  assert.deepEqual(w.calls.menuOps, ['removeAll', 'create:ytlearn-home', 'create:ytlearn-settings', 'create:ytlearn-netflix',
    'removeAll', 'create:ytlearn-home', 'create:ytlearn-settings', 'create:ytlearn-netflix']);
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.menus)), [
    { id: 'ytlearn-home', title: '打開 yt-learn 首頁', contexts: ['action'] },
    { id: 'ytlearn-settings', title: '設定', contexts: ['action'] },
    { id: 'ytlearn-netflix', title: '在 Netflix 啟用（開關後請重新整理頁面）', type: 'checkbox', checked: false, contexts: ['action'] },
  ]);
});

test('menu clicks open the home page and the settings section', async () => {
  const w = load();
  w.listeners.menuClicked({ menuItemId: 'ytlearn-home' });
  w.listeners.menuClicked({ menuItemId: 'ytlearn-settings' });
  w.listeners.menuClicked({ menuItemId: 'something-else' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.created)), [
    { url: 'http://127.0.0.1:8765/index.html', active: true },
    { url: 'http://127.0.0.1:8765/index.html#settings', active: true },
  ]);
});

test('manifest asks for contextMenus and is version 1.6.0', () => {
  const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(m.permissions.includes('contextMenus'));
  assert.equal(m.version, '1.6.0');
  // tab.url comes from host permissions (youtube.com, udemy.com, the local server) and activeTab on icon click
  assert.ok(!m.permissions.includes('tabs') && m.permissions.includes('activeTab'));
});

test('manifest: udemy.com gets the host permission, the overlay content script and the overlay resources (site.js)', () => {
  const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  const U = 'https://www.udemy.com/*';
  assert.ok(m.host_permissions.includes(U));
  const overlay = m.content_scripts.find((c) => c.js.includes('overlay.js'));
  assert.deepEqual(overlay.matches, ['https://www.youtube.com/*', U]);
  const war = m.web_accessible_resources[0];
  assert.ok(war.matches.includes(U));
  assert.ok(war.resources.includes('site.js'));
  const src = readFileSync(new URL('../../extension/overlay.js', import.meta.url), 'utf8');
  assert.ok(src.includes("import(url('site.js'))"));
});

test('overlay and pill shadow roots are closed', () => {
  const src = readFileSync(new URL('../../extension/overlay.js', import.meta.url), 'utf8');
  assert.equal((src.match(/attachShadow\(\{ mode: 'closed' \}\)/g) || []).length, 2);
  assert.ok(!/mode: 'open'/.test(src));
});

/* ---------- ytlearn:dict: one reusable popup window for the Cambridge dictionary ---------- */

const DICT = 'https://dictionary.cambridge.org/dictionary/english-chinese-traditional/';
const plain = (x) => JSON.parse(JSON.stringify(x));

test('ytlearn:dict: first lookup creates a popup beside the video and remembers it; the next one reuses it', async () => {
  const w = load();
  const a = await ask(w, { type: 'ytlearn:dict', url: DICT + 'concepts', screen: { left: 0, width: 1920 } });
  assert.equal(a.ret, true);
  assert.equal(a.r.ok, true);
  assert.deepEqual(plain(w.calls.winCreated), [{ url: DICT + 'concepts', type: 'popup', width: 520, height: 760, focused: true, left: 1380 }]);
  assert.equal(w.store.dictWindowId, 500);
  const b = await ask(w, { type: 'ytlearn:dict', url: DICT + 'sci-fi' });
  assert.equal(b.r.ok, true);
  assert.equal(w.calls.winCreated.length, 1, 'no second window');
  assert.deepEqual(plain(w.calls.tabQueries), [{ windowId: 500 }]);
  assert.deepEqual(plain(w.calls.tabUpdates), [[5000, { url: DICT + 'sci-fi' }]]);
  assert.deepEqual(plain(w.calls.winUpdated), [[500, { focused: true }]]);
});

test('ytlearn:dict: no screen info -> no left; window update rejects (closed) -> a new window', async () => {
  const w = load({}, { windows: { update: async () => { throw new Error('No window with id: 500.'); } } });
  await ask(w, { type: 'ytlearn:dict', url: DICT + 'a' });
  assert.equal('left' in w.calls.winCreated[0], false);
  const r = (await ask(w, { type: 'ytlearn:dict', url: DICT + 'b' })).r;
  assert.equal(r.ok, true);
  assert.equal(w.calls.winCreated.length, 2);
  assert.equal(w.calls.winCreated[1].url, DICT + 'b');
  assert.equal(w.store.dictWindowId, 501);
});

test('ytlearn:dict: the window has no tabs left -> a new window', async () => {
  const w = load({}, { windows: { query: async () => [] } });
  await ask(w, { type: 'ytlearn:dict', url: DICT + 'a' });
  await ask(w, { type: 'ytlearn:dict', url: DICT + 'b' });
  assert.equal(w.calls.winCreated.length, 2);
  assert.deepEqual(w.calls.tabUpdates, []);
});

test('ytlearn:dict: windows.onRemoved for the popup forgets it -> next lookup creates', async () => {
  const w = load();
  await ask(w, { type: 'ytlearn:dict', url: DICT + 'a' });
  w.listeners.winRemoved(123); // some other window: kept
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.store.dictWindowId, 500);
  w.listeners.winRemoved(500);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.store.dictWindowId, null);
  await ask(w, { type: 'ytlearn:dict', url: DICT + 'b' });
  assert.equal(w.calls.winCreated.length, 2);
  assert.deepEqual(w.calls.tabQueries, []);
});

test('ytlearn:dict: two quick lookups open one window', async () => {
  const w = load();
  await Promise.all([ask(w, { type: 'ytlearn:dict', url: DICT + 'a' }), ask(w, { type: 'ytlearn:dict', url: DICT + 'b' })]);
  assert.equal(w.calls.winCreated.length, 1);
  assert.deepEqual(plain(w.calls.tabUpdates), [[5000, { url: DICT + 'b' }]]);
});

test('ytlearn:dict: anything but a Cambridge dictionary URL is ignored', async () => {
  const w = load();
  for (const url of ['https://evil.example/', 'http://dictionary.cambridge.org/x', 'https://dictionary.cambridge.org.evil.example/',
    'javascript:alert(1)', '', undefined, 42]) {
    const { r, ret } = await ask(w, { type: 'ytlearn:dict', url });
    assert.equal(ret, false);
    assert.equal(r.ok, false);
  }
  const foreign = await ask(w, { type: 'ytlearn:dict', url: DICT + 'a' }, { id: 'someone-else', tab: { id: 1 } });
  assert.equal(foreign.r, undefined);
  assert.deepEqual(w.calls.winCreated, []);
  assert.deepEqual(w.calls.tabQueries, []);
  assert.deepEqual(w.calls.tabUpdates, []);
});

test('overlay can import dict.js (web-accessible) and sends ytlearn:dict on a word click', () => {
  const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(m.web_accessible_resources[0].resources.includes('dict.js'));
  const src = readFileSync(new URL('../../extension/overlay.js', import.meta.url), 'utf8');
  assert.ok(src.includes("import(url('dict.js'))"));
  assert.ok(src.includes("type: 'ytlearn:dict'"));
  assert.ok(src.includes('m.video.pause()'));
});

/* ---------- Udemy lecture pages + the requested-id contract ---------- */

const LID = 'udemy.5800738';
const LURL = 'https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738?start=0#overview';
const udemyRoutes = (extra = {}) => ({
  'POST /add': { status: 200, json: { job: { videoId: LID, state: 'queued', attempt: 1, message: '' } } },
  ['POST /jobs/' + LID + '/claim']: { status: 200, json: { attempt: 1 } },
  'POST /ingest?attempt=1': { status: 200, json: { ok: true, job: { videoId: LID, state: 'captured', attempt: 1, message: '' } } },
  ['POST /jobs/' + LID + '/fail']: { status: 200, json: { ok: true } },
  ...extra,
});
const captureScript = (raw, log) => async (o) => {
  log.push(o);
  if (o.files) return [{ result: undefined }];
  return [{ result: { ok: true, raw } }];
};

test('icon on a Udemy lecture: overlay not handled -> /add with the tab url -> claim -> udemy capture (ISOLATED, vtt.js + udemy-capture.js) -> /ingest', async () => {
  const raw = { videoId: LID, source: 'udemy', events: [{ t: 0, d: 1000, segs: [[null, 'hi']] }] };
  const injected = [];
  const w = load(udemyRoutes(), { toggleReply: { handled: false }, executeScript: captureScript(raw, injected) });
  await w.ctx.onIconClicked({ id: 7, url: LURL });
  assert.deepEqual(plain(w.calls.sent), [{ tabId: 7, msg: { type: 'ytlearn:toggle' } }]);
  assert.deepEqual(w.calls.fetched, ['POST /add', 'POST /jobs/' + LID + '/claim', 'POST /ingest?attempt=1']);
  assert.deepEqual(plain(w.calls.bodies['POST /add']), { url: LURL });
  assert.equal(injected.length, 2);
  assert.deepEqual(plain(injected[0]), { target: { tabId: 7 }, files: ['vtt.js', 'udemy-capture.js'], world: 'ISOLATED' });
  assert.equal(injected[1].world, 'ISOLATED', 'both phases in the same world');
  assert.deepEqual(plain(injected[1].args), ['ytLearnUdemyCapture', { expectLessonId: LID, timeoutMs: 25000 }]);
  // the injected func calls the named global with the options
  const seen = [];
  const fake = { ytLearnUdemyCapture: async (o) => { seen.push(o); return raw; } };
  const r = await vm.runInNewContext('(' + injected[1].func.toString() + ')', { globalThis: fake })(...injected[1].args);
  assert.deepEqual(plain(r), { ok: true, raw });
  assert.deepEqual(plain(seen), [{ expectLessonId: LID, timeoutMs: 25000 }]);
  assert.deepEqual(plain(w.calls.bodies['POST /ingest?attempt=1']), raw);
  assert.deepEqual(plain(w.calls.created), [{ url: 'http://127.0.0.1:8765/index.html?v=' + LID, active: true }]);
});

test('icon on a Udemy lecture: overlay handled -> nothing else', async () => {
  const w = load({}, { toggleReply: { handled: true } });
  await w.ctx.onIconClicked({ id: 7, url: LURL });
  assert.equal(w.calls.sent.length, 1);
  assert.deepEqual(w.calls.fetched, []);
  assert.deepEqual(w.calls.created, []);
});

test('icon on a non-lecture Udemy page opens the home page (no background mode for Udemy)', async () => {
  for (const url of ['https://www.udemy.com/course/30-days-of-python/', 'https://www.udemy.com/', 'https://www.udemy.com/course/x/learn/quiz/5800738']) {
    const w = load({}, { toggleReply: { handled: true } });
    await w.ctx.onIconClicked({ id: 7, url });
    assert.deepEqual(w.calls.sent, [], url);
    assert.deepEqual(w.calls.fetched, [], url);
    assert.deepEqual(plain(w.calls.created), [{ url: 'http://127.0.0.1:8765/index.html', active: true }], url);
  }
});

test('YouTube watch page: /add gets the tab url; capture stays capture.js in MAIN (both phases)', async () => {
  const raw = { videoId: VID, events: [{ t: 0, d: 1000, segs: [[0, 'hi']] }] };
  const injected = [];
  const url = 'https://www.youtube.com/watch?v=' + VID + '&t=42s';
  const w = load({
    'POST /add': { status: 200, json: { job: { videoId: VID, state: 'queued', attempt: 1, message: '' } } },
    ['POST /jobs/' + VID + '/claim']: { status: 200, json: { attempt: 1 } },
    'POST /ingest?attempt=1': { status: 200, json: { ok: true, job: { videoId: VID, state: 'captured', attempt: 1, message: '' } } },
  }, { toggleReply: { handled: false }, executeScript: captureScript(raw, injected) });
  await w.ctx.onIconClicked({ id: 7, url });
  assert.deepEqual(plain(w.calls.bodies['POST /add']), { url });
  assert.deepEqual(plain(injected[0]), { target: { tabId: 7 }, files: ['capture.js'], world: 'MAIN' });
  assert.equal(injected[1].world, 'MAIN');
  assert.deepEqual(plain(injected[1].args), ['ytLearnCapture', { expectVideoId: VID, timeoutMs: 25000, inPlace: true }]);
  assert.deepEqual(w.calls.fetched, ['POST /add', 'POST /jobs/' + VID + '/claim', 'POST /ingest?attempt=1']);
});

test('/add answers with a different id -> abort before claim/capture', async () => {
  const injected = [];
  const w = load(udemyRoutes({ 'POST /add': { status: 200, json: { job: { videoId: 'udemy.1', state: 'queued', attempt: 1, message: '' } } } }),
    { toggleReply: { handled: false }, executeScript: captureScript({}, injected) });
  const r = await w.ctx.runJob({ id: LID, url: LURL, site: 'udemy' }, { mode: 'inplace', tabId: 7 });
  assert.equal(r.ok, false);
  assert.match(r.error, /不符/);
  assert.deepEqual(w.calls.fetched, ['POST /add']);
  assert.deepEqual(injected, []);
});

test('capture returns another lesson (raw.videoId mismatch) -> /fail with 換課了, no /ingest', async () => {
  const injected = [];
  const w = load(udemyRoutes(), { executeScript: captureScript({ videoId: 'udemy.42', events: [] }, injected) });
  const r = await w.ctx.runJob({ id: LID, url: LURL, site: 'udemy' }, { mode: 'inplace', tabId: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.error, '換課了，請回到原講座再試');
  assert.deepEqual(w.calls.fetched, ['POST /add', 'POST /jobs/' + LID + '/claim', 'POST /jobs/' + LID + '/fail']);
  assert.deepEqual(plain(w.calls.bodies['POST /jobs/' + LID + '/fail']), { attempt: 1, message: '換課了，請回到原講座再試' });
});

test('Udemy never runs in background mode', async () => {
  const w = load(udemyRoutes());
  const r = await w.ctx.runJob({ id: LID, url: LURL, site: 'udemy' }, { mode: 'background' });
  assert.equal(r.ok, false);
  assert.deepEqual(w.calls.fetched, []);
});

test('ytlearn:build from a Udemy overlay carries the page url; a url naming another lecture is refused', async () => {
  const raw = { videoId: LID, events: [{ t: 0, d: 1000, segs: [[null, 'hi']] }] };
  const injected = [];
  const w = load(udemyRoutes(), { executeScript: captureScript(raw, injected) });
  const { r, ret } = await ask(w, { type: 'ytlearn:build', videoId: LID, url: LURL }, { id: EXT, tab: { id: 42 } });
  assert.equal(ret, true);
  assert.equal(r.ok, true);
  assert.deepEqual(plain(w.calls.bodies['POST /add']), { url: LURL });
  assert.equal(injected[0].world, 'ISOLATED');
  const other = load(udemyRoutes());
  const bad = await ask(other, { type: 'ytlearn:build', videoId: LID, url: 'https://www.udemy.com/course/x/learn/lecture/1' });
  assert.equal(bad.ret, false);
  assert.deepEqual({ ...bad.r }, { ok: false, error: '換課了，請回到原講座再試' });
  const noUrl = await ask(other, { type: 'ytlearn:build', videoId: LID });
  assert.equal(noUrl.r.ok, false);
  assert.deepEqual(other.calls.fetched, []);
});

test('ytlearn:lesson / ytlearn:job accept udemy ids', async () => {
  const w = load({ ['GET /data/lessons/' + LID + '.json']: { status: 200, json: { videoId: LID } }, ['GET /jobs/' + LID]: { status: 404 } });
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:lesson', videoId: LID })).r), { lesson: { videoId: LID } });
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:job', videoId: LID })).r), { missing: true });
});

test('siteOfUrl', () => {
  const w = load();
  assert.equal(w.ctx.siteOfUrl('https://www.youtube.com/watch?v=' + VID), 'youtube');
  assert.equal(w.ctx.siteOfUrl(LURL), 'udemy');
  for (const u of ['https://www.youtube.com/shorts/' + VID, 'https://www.udemy.com/course/x/', 'http://www.udemy.com/course/x/learn/lecture/1',
    'https://mycompany.udemy.com/course/x/learn/lecture/1', '', undefined]) assert.equal(w.ctx.siteOfUrl(u), null, String(u));
});

/* ---------- Netflix: opt-in state machine, entry points, probe ---------- */

const NF = 'https://www.netflix.com/*';
const NURL = 'https://www.netflix.com/watch/81234567?trackId=14277281';
const NID = 'netflix.81234567';
const ENABLE_PAGE = 'chrome-extension://' + EXT + '/netflix-enable.html';
const PAGE_SENDER = { id: EXT, url: ENABLE_PAGE + '?tab=7', tab: { id: 3 } };
const settle = () => new Promise((r) => setTimeout(r, 15));
const HOOK_REG = { id: 'ytlearn-netflix-hook', js: ['netflix-manifest.js', 'netflix-hook.js'], matches: [NF], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true };
const OVERLAY_REG = { id: 'ytlearn-netflix-overlay', js: ['overlay.js'], matches: [NF], runAt: 'document_idle', world: 'ISOLATED', allFrames: false, persistAcrossSessions: true };
const regs = (w) => plain([...w.registered.values()].sort((a, b) => a.id.localeCompare(b.id)));
const ON = { desired: true, gen: 3, cleanup: false };

test('siteOfUrl: netflix watch pages (optional slash, query, hash); anything else on netflix is not a lesson page', () => {
  const w = load();
  for (const u of ['https://www.netflix.com/watch/81234567', 'https://www.netflix.com/watch/81234567/', NURL,
    'https://www.netflix.com/watch/81234567#x', 'https://www.netflix.com/watch/81234567/?a=1#b']) assert.equal(w.ctx.siteOfUrl(u), 'netflix', u);
  for (const u of ['https://www.netflix.com/watch/123abc', 'https://www.netflix.com/browse', 'https://www.netflix.com/title/81234567',
    'http://www.netflix.com/watch/81234567', 'https://netflix.com/watch/81234567', 'https://www.netflix.com/watch/',
    'https://www.netflix.com/watch/1234567890123', 'https://www.netflix.com.evil.example/watch/1']) assert.equal(w.ctx.siteOfUrl(u), null, u);
});

test('worker start: nothing stored -> nothing registered, menu unchecked, no permission call besides contains', async () => {
  const w = load();
  await settle();
  assert.deepEqual(w.calls.scriptOps, []);
  assert.deepEqual(plain(w.calls.menuUpdates), [['ytlearn-netflix', false]]);
  assert.deepEqual(w.calls.permOps, ['contains']);
  assert.deepEqual(w.calls.localSets, []);
});

test('reconcile: desired + permission + nothing registered -> registers both scripts with the exact config; menu checked', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true } });
  await settle();
  assert.deepEqual(regs(w), [HOOK_REG, OVERLAY_REG]);
  assert.deepEqual(w.calls.scriptOps, ['register:ytlearn-netflix-hook,ytlearn-netflix-overlay']);
  assert.deepEqual(plain(w.calls.menuUpdates).at(-1), ['ytlearn-netflix', true]);
  assert.deepEqual(plain(w.local.netflix), ON, 'intent untouched');
  // a second reconcile is a no-op
  await w.ctx.reconcileNetflix();
  assert.equal(w.calls.scriptOps.length, 1);
});

test('reconcile: one script registered with a wrong config -> only that one is re-registered', async () => {
  const wrong = { ...HOOK_REG, world: 'ISOLATED' };
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, registered: [wrong, OVERLAY_REG] } });
  await settle();
  assert.deepEqual(w.calls.scriptOps, ['unregister:ytlearn-netflix-hook', 'register:ytlearn-netflix-hook']);
  assert.deepEqual(regs(w), [HOOK_REG, OVERLAY_REG]);
  for (const k of ['js', 'matches', 'runAt', 'allFrames', 'persistAcrossSessions']) {
    const bad = { ...OVERLAY_REG, [k]: k === 'js' ? ['overlay.js', 'x.js'] : k === 'matches' ? ['https://*/*'] : k === 'runAt' ? 'document_end' : !OVERLAY_REG[k] };
    const v = load({}, { nf: { local: { netflix: ON }, perm: true, registered: [HOOK_REG, bad] } });
    await settle();
    assert.deepEqual(v.calls.scriptOps, ['unregister:ytlearn-netflix-overlay', 'register:ytlearn-netflix-overlay'], k);
    assert.deepEqual(regs(v), [HOOK_REG, OVERLAY_REG], k);
  }
});

test('reconcile: desired but the permission was revoked -> desired=false, gen+1, site-off to ALL tabs, unregister, cleanup=false; never permissions.remove', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: false, registered: [HOOK_REG, OVERLAY_REG], tabs: [{ id: 1 }, { id: 2 }], offFails: [1] } });
  await settle();
  assert.deepEqual(plain(w.calls.tabQueries), [{}], 'no site permission: every tab');
  assert.deepEqual(plain(w.calls.sent.map((x) => x.msg)), [{ type: 'ytlearn:site-off', site: 'netflix' }, { type: 'ytlearn:site-off', site: 'netflix' }]);
  assert.deepEqual(w.calls.order, ['local:{"desired":false,"gen":4,"cleanup":true}', 'site-off:1', 'site-off:2', 'unregister',
    'local:{"desired":false,"gen":4,"cleanup":false}']);
  assert.deepEqual(regs(w), []);
  assert.ok(!w.calls.permOps.includes('remove'));
  assert.deepEqual(plain(w.calls.menuUpdates).at(-1), ['ytlearn-netflix', false]);
});

test('permissions.onRemoved -> reconcile converges to off', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true } });
  await settle();
  assert.equal(w.registered.size, 2);
  w.perm.granted = false;
  w.listeners.permRemoved({ origins: [NF] });
  await settle();
  assert.equal(w.registered.size, 0);
  assert.deepEqual(plain(w.local.netflix), { desired: false, gen: 4, cleanup: false });
  assert.equal(w.listeners.permAdded, undefined, 'no permissions.onAdded listener');
});

test('reconcile: !desired with cleanup left over (worker killed mid-disable) -> redo site-off, unregister, cleanup=false; permission kept', async () => {
  const w = load({}, { nf: { local: { netflix: { desired: false, gen: 5, cleanup: true } }, perm: true, registered: [OVERLAY_REG], tabs: [{ id: 9 }] } });
  await settle();
  assert.deepEqual(plain(w.calls.tabQueries), [{ url: NF }], 'with the site permission: only Netflix tabs');
  assert.deepEqual(w.calls.order, ['site-off:9', 'unregister', 'local:{"desired":false,"gen":5,"cleanup":false}']);
  assert.ok(!w.calls.permOps.includes('remove'), 'the !desired branch never revokes');
  assert.equal(w.perm.granted, true);
});

test('reconcile: !desired, no cleanup, stray registration -> unregistered silently (no broadcast, no writes)', async () => {
  const w = load({}, { nf: { local: { netflix: { desired: false, gen: 2, cleanup: false } }, perm: true, registered: [HOOK_REG] } });
  await settle();
  assert.deepEqual(w.calls.scriptOps, ['unregister:ytlearn-netflix-hook']);
  assert.deepEqual(w.calls.sent, []);
  assert.deepEqual(w.calls.localSets, []);
});

test('reconcile: registration fails -> desired kept, not enabled, retried next time', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, registerFails: true } });
  await settle();
  assert.deepEqual(plain(w.local.netflix), ON);
  const st = plain(await w.ctx.reconcileNetflix());
  assert.deepEqual(st, { enabled: false, desired: true, permission: true, registered: false });
  assert.equal(w.calls.scriptOps.filter((x) => x.startsWith('register')).length, 2);
});

test('netflix-set true without the permission -> {ok:false, error:needPermission}, nothing written', async () => {
  const w = load({}, { nf: { local: { netflix: { desired: false, gen: 1, cleanup: false } }, perm: false } });
  await settle();
  const { r, ret } = await ask(w, { type: 'ytlearn:netflix-set', desired: true, tab: 7 }, PAGE_SENDER);
  assert.equal(ret, true);
  assert.deepEqual(plain(r), { ok: false, error: 'needPermission' });
  assert.deepEqual(w.calls.localSets, []);
  assert.deepEqual(w.calls.reloaded, []);
});

test('netflix-set true with the permission -> desired=true gen+1, both registered, then the tab reloads', async () => {
  const w = load({}, { nf: { local: { netflix: { desired: false, gen: 1, cleanup: false } }, perm: true } });
  await settle();
  const { r } = await ask(w, { type: 'ytlearn:netflix-set', desired: true, tab: 7 }, PAGE_SENDER);
  assert.deepEqual(plain(r), { ok: true });
  assert.deepEqual(plain(w.local.netflix), { desired: true, gen: 2, cleanup: false });
  assert.deepEqual(regs(w), [HOOK_REG, OVERLAY_REG]);
  assert.deepEqual(w.calls.reloaded, [7]);
});

test('netflix-set true but registration fails -> error, desired stays true, no reload', async () => {
  const w = load({}, { nf: { perm: true, registerFails: true } });
  await settle();
  const { r } = await ask(w, { type: 'ytlearn:netflix-set', desired: true, tab: 7 }, PAGE_SENDER);
  assert.equal(r.ok, false);
  assert.match(r.error, /註冊失敗/);
  assert.equal(w.local.netflix.desired, true);
  assert.deepEqual(w.calls.reloaded, []);
});

test('netflix-* messages are accepted only from the enable page', async () => {
  const w = load({}, { nf: { perm: true } });
  await settle();
  for (const sender of [{ id: EXT, url: 'https://www.netflix.com/watch/1', tab: { id: 7 } }, { id: EXT, tab: { id: 7 } },
    { id: 'other', url: ENABLE_PAGE }, { id: EXT, url: 'chrome-extension://' + EXT + '/other.html' }]) {
    const { r, ret } = await ask(w, { type: 'ytlearn:netflix-set', desired: true, tab: 7 }, sender);
    assert.equal(ret, false);
    assert.equal(r, undefined);
  }
  assert.deepEqual(w.calls.localSets, []);
  const bad = await ask(w, { type: 'ytlearn:netflix-set', desired: 'yes' }, PAGE_SENDER);
  assert.equal(bad.r.ok, false);
});

test('disable: (1) intent off + cleanup, (2) site-off to Netflix tabs, (3) unregister, (4) cleanup done, (5) gen re-read, then permissions.remove', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, tabs: [{ id: 11 }, { id: 12 }] } });
  await settle();
  w.calls.order.length = 0;
  const { r } = await ask(w, { type: 'ytlearn:netflix-set', desired: false }, PAGE_SENDER);
  assert.deepEqual(plain(r), { ok: true });
  assert.deepEqual(w.calls.order, ['local:{"desired":false,"gen":4,"cleanup":true}', 'site-off:11', 'site-off:12', 'unregister',
    'local:{"desired":false,"gen":4,"cleanup":false}', 'permissions.remove']);
  assert.deepEqual(plain(w.calls.tabQueries), [{ url: NF }]);
  assert.deepEqual(plain(w.calls.sent[0].msg), { type: 'ytlearn:site-off', site: 'netflix' });
  assert.equal(w.perm.granted, false);
  assert.equal(w.registered.size, 0);
  assert.deepEqual(plain(w.calls.menuUpdates).at(-1), ['ytlearn-netflix', false]);
});

test('disable: gen changed before step (5) (the user enabled again) -> the permission is kept', async () => {
  let bumped = false;
  const onLocalSet = (o, local) => {
    // right after step (4) another writer bumps gen (a re-enable that landed in between)
    if (!bumped && o.netflix && o.netflix.cleanup === false && o.netflix.desired === false) {
      bumped = true;
      local.netflix = { desired: true, gen: o.netflix.gen + 1, cleanup: false };
    }
  };
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, onLocalSet } });
  await settle();
  await w.ctx.setNetflix(false);
  assert.ok(bumped);
  assert.ok(!w.calls.permOps.includes('remove'));
  assert.equal(w.perm.granted, true);
});

test('set true sent while a disable is running -> serialized after it: the disable revoked the permission, so needPermission (no half state)', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, tabs: [{ id: 11 }] } });
  await settle();
  const off = ask(w, { type: 'ytlearn:netflix-set', desired: false }, PAGE_SENDER);
  const on = ask(w, { type: 'ytlearn:netflix-set', desired: true, tab: 7 }, PAGE_SENDER);
  assert.deepEqual(plain((await off).r), { ok: true });
  assert.deepEqual(plain((await on).r), { ok: false, error: 'needPermission' });
  assert.deepEqual(plain(w.local.netflix), { desired: false, gen: 4, cleanup: false });
  assert.equal(w.registered.size, 0);
  // the user grants again (the page asks in its click handler) -> set true now succeeds
  w.perm.granted = true;
  const again = await ask(w, { type: 'ytlearn:netflix-set', desired: true, tab: 7 }, PAGE_SENDER);
  assert.deepEqual(plain(again.r), { ok: true });
  assert.equal(w.registered.size, 2);
});

test('disable: unregister fails -> cleanup stays true (reconcile redoes it), permission still revoked', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, unregisterFails: true } });
  await settle();
  await w.ctx.setNetflix(false);
  assert.deepEqual(plain(w.local.netflix), { desired: false, gen: 4, cleanup: true });
  assert.equal(w.perm.granted, false);
});

test('menu checkbox: checked -> permissions.request inside the click, then set true; unchecked -> disable', async () => {
  const w = load({}, { nf: { perm: false } });
  await settle();
  w.listeners.menuClicked({ menuItemId: 'ytlearn-netflix', checked: true });
  assert.equal(w.calls.permOps.at(-1), 'request', 'request is the synchronous first call');
  await settle();
  assert.equal(w.local.netflix.desired, true);
  assert.equal(w.registered.size, 2);
  assert.deepEqual(plain(w.calls.menuUpdates).at(-1), ['ytlearn-netflix', true]);
  w.listeners.menuClicked({ menuItemId: 'ytlearn-netflix', checked: false });
  await settle();
  assert.equal(w.local.netflix.desired, false);
  assert.equal(w.registered.size, 0);
  assert.equal(w.perm.granted, false);
  assert.deepEqual(plain(w.calls.menuUpdates).at(-1), ['ytlearn-netflix', false]);
});

test('menu checkbox: permission denied -> nothing written, checkbox back to unchecked', async () => {
  const w = load({}, { nf: { perm: false, request: () => false } });
  await settle();
  w.listeners.menuClicked({ menuItemId: 'ytlearn-netflix', checked: true });
  await settle();
  assert.deepEqual(w.calls.localSets, []);
  assert.deepEqual(plain(w.calls.menuUpdates).at(-1), ['ytlearn-netflix', false]);
});

test('entry points while Netflix is off reply {disabled:true} and never reach the server', async () => {
  const w = load({ 'POST /add': { status: 200, json: { job: { videoId: NID, state: 'queued', attempt: 1, message: '' } } } }, { nf: { perm: true } });
  await settle();
  for (const type of ['ytlearn:lesson', 'ytlearn:job', 'ytlearn:build']) {
    const { r, ret } = await ask(w, { type, videoId: NID, url: NURL });
    assert.equal(ret, true, type);
    assert.deepEqual(plain(r), { disabled: true }, type);
  }
  assert.deepEqual(plain(await w.ctx.overlayFetch('ytlearn:lesson', NID)), { disabled: true });
  const job = plain(await w.ctx.runJob({ id: NID, url: NURL, site: 'netflix' }, { mode: 'inplace', tabId: 7 }));
  assert.equal(job.ok, false);
  assert.equal(job.disabled, true);
  assert.equal(job.error, 'Netflix 尚未啟用');
  assert.deepEqual(w.calls.fetched, []);
});

test('desired + permission but unregistered (registration failing) still counts as off for the entry points', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, registerFails: true } });
  await settle();
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:lesson', videoId: NID })).r), { disabled: true });
});

test('entry points while Netflix is on: still not a known lesson id in this step', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true } });
  await settle();
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:lesson', videoId: NID })).r), { error: '無法辨識的影片 id' });
  const job = await w.ctx.runJob({ id: NID, url: NURL, site: 'netflix' }, { mode: 'inplace', tabId: 7 });
  assert.equal(job.ok, false);
  assert.equal(job.disabled, undefined);
  assert.deepEqual(w.calls.fetched, []);
});

test('icon on a Netflix watch page while off -> opens netflix-enable.html?tab=<id>; no overlay toggle, no server', async () => {
  const w = load({}, { toggleReply: { handled: true }, nf: { perm: false } });
  await settle();
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.deepEqual(plain(w.calls.created), [{ url: ENABLE_PAGE + '?tab=7', active: true }]);
  assert.deepEqual(w.calls.sent, []);
  assert.deepEqual(w.calls.fetched, []);
});

test('icon on other Netflix pages -> home page, like Udemy non-lecture pages', async () => {
  for (const url of ['https://www.netflix.com/browse', 'https://www.netflix.com/watch/123abc', 'https://www.netflix.com/title/81234567']) {
    const w = load({}, { toggleReply: { handled: true }, nf: { local: { netflix: ON }, perm: true } });
    await settle();
    await w.ctx.onIconClicked({ id: 7, url });
    assert.deepEqual(plain(w.calls.created), [{ url: 'http://127.0.0.1:8765/index.html', active: true }], url);
    assert.deepEqual(w.calls.sent, [], url);
  }
});

const probeResult = { movieId: '81234567', hook: { parsed: 9, suspected: 1, summarized: 1, unknownShape: 0, skippedReviver: 0 }, state: 'found',
  tracks: [{ lang: 'en', type: 'PRIMARY', forced: false, formats: ['imsc1.1'] }], enFetch: { status: 200, bytes: 1234, head: '<?xml' }, seek: { ok: true } };

test('icon on a Netflix watch page while on -> probe (ISOLATED, netflix-manifest.js + netflix-capture.js) and #probe page; result in storage.session', async () => {
  const injected = [];
  const w = load({}, { executeScript: captureScript(probeResult, injected), nf: { local: { netflix: ON }, perm: true, tabUrls: { 7: NURL } } });
  await settle();
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.deepEqual(plain(w.calls.created), [{ url: ENABLE_PAGE + '?tab=7#probe', active: true }]);
  assert.deepEqual(plain(injected[0]), { target: { tabId: 7 }, files: ['netflix-manifest.js', 'netflix-capture.js'], world: 'ISOLATED' });
  assert.equal(injected[1].world, 'ISOLATED');
  assert.deepEqual(plain(injected[1].args), ['ytLearnNetflixCapture', { probe: true, expectLessonId: NID, timeoutMs: 25000 }]);
  const rec = plain(w.store.netflixProbe);
  assert.equal(rec.state, 'done');
  assert.equal(rec.ok, true);
  assert.equal(rec.tabId, 7);
  assert.deepEqual(rec.result, probeResult);
  assert.deepEqual(w.calls.fetched, [], 'the probe never talks to the server');
});

test('netflix-probe from the enable page: off -> {disabled:true}; on -> result; not a watch tab -> error', async () => {
  const off = load({}, { nf: { perm: false } });
  await settle();
  assert.deepEqual(plain((await ask(off, { type: 'ytlearn:netflix-probe', tab: 7 }, PAGE_SENDER)).r), { disabled: true });
  const injected = [];
  const on = load({}, { executeScript: captureScript(probeResult, injected), nf: { local: { netflix: ON }, perm: true, tabUrls: { 7: NURL, 8: 'https://www.netflix.com/browse' } } });
  await settle();
  const r = plain((await ask(on, { type: 'ytlearn:netflix-probe', tab: 7 }, PAGE_SENDER)).r);
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, probeResult);
  const notWatch = plain((await ask(on, { type: 'ytlearn:netflix-probe', tab: 8 }, PAGE_SENDER)).r);
  assert.deepEqual(notWatch, { ok: false, error: '這個分頁不是 Netflix 播放頁' });
  assert.equal(injected.length, 2, 'only the watch tab got the probe');
});

test('netflix-probe: capture error is reported, and a switch during the probe discards the result', async () => {
  const failing = load({}, { executeScript: async (o) => (o.files ? [{}] : [{ result: { ok: false, error: 'Netflix 鉤子不在（請重新載入頁面）' } }]),
    nf: { local: { netflix: ON }, perm: true, tabUrls: { 7: NURL } } });
  await settle();
  const r = plain((await ask(failing, { type: 'ytlearn:netflix-probe', tab: 7 }, PAGE_SENDER)).r);
  assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'Netflix 鉤子不在（請重新載入頁面）' });
  let w;
  const executeScript = async (o) => {
    if (o.files) return [{}];
    w.local.netflix = { desired: false, gen: 99, cleanup: false }; // user switched off mid-probe
    return [{ result: { ok: true, raw: probeResult } }];
  };
  w = load({}, { executeScript, nf: { local: { netflix: ON }, perm: true, tabUrls: { 7: NURL } } });
  await settle();
  const r2 = plain((await ask(w, { type: 'ytlearn:netflix-probe', tab: 7 }, PAGE_SENDER)).r);
  assert.deepEqual(r2, { ok: false, error: 'Netflix 尚未啟用' });
});

test('netflix-state reports the reconciled state', async () => {
  const w = load({}, { nf: { local: { netflix: ON }, perm: true } });
  const { r } = await ask(w, { type: 'ytlearn:netflix-state' }, PAGE_SENDER);
  assert.deepEqual(plain(r), { enabled: true, desired: true, permission: true, registered: true });
});

test('manifest: Netflix is optional (optional_host_permissions), never static; netflix-manifest.js web-accessible on netflix.com', () => {
  const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(m.optional_host_permissions, [NF]);
  assert.ok(!m.host_permissions.includes(NF));
  assert.ok(m.content_scripts.every((c) => !c.matches.includes(NF)));
  assert.deepEqual(m.permissions, ['scripting', 'activeTab', 'storage', 'contextMenus']);
  const war = m.web_accessible_resources[0];
  assert.ok(war.resources.includes('netflix-manifest.js'));
  assert.ok(war.matches.includes(NF));
  for (const f of ['netflix-manifest.js', 'netflix-hook.js', 'netflix-capture.js', 'netflix-enable.html', 'netflix-enable.js', 'overlay.js']) {
    assert.ok(readFileSync(new URL('../../extension/' + f, import.meta.url), 'utf8').length > 0, f);
  }
});

test('extension code never uses innerHTML (netflix files included)', () => {
  for (const f of ['netflix-manifest.js', 'netflix-hook.js', 'netflix-capture.js', 'netflix-enable.js', 'background.js']) {
    const src = readFileSync(new URL('../../extension/' + f, import.meta.url), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src), f);
  }
});
