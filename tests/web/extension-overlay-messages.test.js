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
    menuUpdates: [], reloaded: [], order: [], titles: [] };
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
    action: { onClicked: on('clicked'), setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async (o) => { calls.titles.push(o.title); } },
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
        .map((r) => JSON.parse(JSON.stringify(nf.report ? nf.report(r) : r))),
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

test('install builds the action menu items (two links + the Netflix checkbox + the probe item) after removeAll, and reinstall does not duplicate them', () => {
  const w = load();
  w.listeners.installed({ reason: 'install' });
  w.listeners.installed({ reason: 'update' });
  assert.deepEqual(w.calls.menuOps, ['removeAll', 'create:ytlearn-home', 'create:ytlearn-settings', 'create:ytlearn-netflix', 'create:ytlearn-netflix-probe',
    'removeAll', 'create:ytlearn-home', 'create:ytlearn-settings', 'create:ytlearn-netflix', 'create:ytlearn-netflix-probe']);
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.menus)), [
    { id: 'ytlearn-home', title: '打開 yt-learn 首頁', contexts: ['action'] },
    { id: 'ytlearn-settings', title: '設定', contexts: ['action'] },
    { id: 'ytlearn-netflix', title: '在 Netflix 啟用（開關後請重新整理頁面）', type: 'checkbox', checked: false, contexts: ['action'] },
    { id: 'ytlearn-netflix-probe', title: '診斷目前的 Netflix 分頁', contexts: ['action'] },
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

test('manifest asks for contextMenus and is version 1.8.0', () => {
  const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(m.permissions.includes('contextMenus'));
  assert.equal(m.version, '1.8.0');
  // tab.url comes from host permissions (youtube.com, udemy.com, the local server) and activeTab on icon click
  assert.ok(!m.permissions.includes('tabs') && m.permissions.includes('activeTab'));
});

test('manifest: udemy.com gets the host permission, the overlay content script and the overlay resources (site.js)', () => {
  const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  const U = 'https://www.udemy.com/*';
  assert.ok(m.host_permissions.includes(U));
  const overlay = m.content_scripts.find((c) => c.js.includes('overlay.js'));
  assert.deepEqual(overlay.matches, ['https://www.youtube.com/*', U, 'https://www.hellointerview.com/*']);
  const war = m.web_accessible_resources[0];
  assert.ok(war.matches.includes(U));
  assert.ok(war.resources.includes('site.js'));
  const src = readFileSync(new URL('../../extension/overlay.js', import.meta.url), 'utf8');
  assert.ok(src.includes("import(url('site.js'))"));
});

test('manifest: hellointerview.com gets the host permission, the overlay content script and the overlay resources', () => {
  const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
  const H = 'https://www.hellointerview.com/*';
  assert.ok(m.host_permissions.includes(H), 'static host permission (not optional, unlike Netflix)');
  assert.ok(!(m.optional_host_permissions || []).includes(H));
  const overlay = m.content_scripts.find((c) => c.js.includes('overlay.js'));
  assert.ok(overlay.matches.includes(H));
  assert.equal(m.web_accessible_resources.length, 1);
  const war = m.web_accessible_resources[0];
  assert.ok(war.matches.includes(H));
  assert.ok(war.resources.includes('site.js'));
  // the capture scripts are injected by scripting.executeScript, never web-accessible
  for (const f of ['vtt.js', 'hellointerview-capture.js']) assert.ok(!war.resources.includes(f), f);
  // only the exact host: no wildcard subdomains
  const all = JSON.stringify(m);
  assert.ok(!all.includes('*.hellointerview.com'));
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
  assert.ok(m.web_accessible_resources[0].resources.includes('phrase.js'), 'the phrase helpers are imported the same way');
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

/* ---------- HelloInterview learn pages (in place only) ---------- */

const HID = 'hello.system-design.patterns.dealing-with-contention';
const HURL = 'https://www.hellointerview.com/learn/system-design/patterns/dealing-with-contention?x=1#y';
const HELLO_ONLY_PAGE = 'HelloInterview 課程只能在課程頁上擷取';
const helloRoutes = (extra = {}) => ({
  'POST /add': { status: 200, json: { job: { videoId: HID, state: 'queued', attempt: 1, message: '' } } },
  ['POST /jobs/' + HID + '/claim']: { status: 200, json: { attempt: 1 } },
  'POST /ingest?attempt=1': { status: 200, json: { ok: true, job: { videoId: HID, state: 'captured', attempt: 1, message: '' } } },
  ['POST /jobs/' + HID + '/fail']: { status: 200, json: { ok: true } },
  ...extra,
});
const helloRaw = { videoId: HID, source: 'hellointerview', sourceUrl: 'https://www.hellointerview.com/learn/system-design/patterns/dealing-with-contention',
  events: [{ t: 0, d: 1000, segs: [[null, 'hi']] }] };

test('icon on a HelloInterview learn page: overlay not handled -> /add with the tab url -> claim -> hello capture (ISOLATED, vtt.js + hellointerview-capture.js) -> /ingest', async () => {
  const injected = [];
  const w = load(helloRoutes(), { toggleReply: { handled: false }, executeScript: captureScript(helloRaw, injected) });
  await w.ctx.onIconClicked({ id: 7, url: HURL });
  assert.deepEqual(plain(w.calls.sent), [{ tabId: 7, msg: { type: 'ytlearn:toggle' } }]);
  assert.deepEqual(w.calls.fetched, ['POST /add', 'POST /jobs/' + HID + '/claim', 'POST /ingest?attempt=1']);
  assert.deepEqual(plain(w.calls.bodies['POST /add']), { url: HURL });
  assert.equal(injected.length, 2);
  assert.deepEqual(plain(injected[0]), { target: { tabId: 7 }, files: ['vtt.js', 'hellointerview-capture.js'], world: 'ISOLATED' });
  assert.equal(injected[1].world, 'ISOLATED', 'both phases in the same world');
  assert.deepEqual(plain(injected[1].args), ['ytLearnHelloCapture', { expectLessonId: HID, timeoutMs: 25000 }]);
  const seen = [];
  const fake = { ytLearnHelloCapture: async (o) => { seen.push(o); return helloRaw; } };
  const r = await vm.runInNewContext('(' + injected[1].func.toString() + ')', { globalThis: fake })(...injected[1].args);
  assert.deepEqual(plain(r), { ok: true, raw: helloRaw });
  assert.deepEqual(plain(seen), [{ expectLessonId: HID, timeoutMs: 25000 }]);
  assert.deepEqual(plain(w.calls.bodies['POST /ingest?attempt=1']), helloRaw);
  assert.deepEqual(w.calls.removed, [], 'no tab of our own');
  assert.deepEqual(plain(w.calls.created), [{ url: 'http://127.0.0.1:8765/index.html?v=' + HID, active: true }]);
});

test('icon on a HelloInterview learn page: overlay handled -> nothing else', async () => {
  const w = load({}, { toggleReply: { handled: true } });
  await w.ctx.onIconClicked({ id: 7, url: HURL });
  assert.deepEqual(plain(w.calls.sent), [{ tabId: 7, msg: { type: 'ytlearn:toggle' } }]);
  assert.deepEqual(w.calls.fetched, []);
  assert.deepEqual(w.calls.created, []);
});

test('icon on a non-learn HelloInterview page opens the home page', async () => {
  for (const url of ['https://www.hellointerview.com/', 'https://www.hellointerview.com/learn', 'https://www.hellointerview.com/learn/',
    'https://www.hellointerview.com/practice/x', 'https://hellointerview.com/learn/system-design', 'http://www.hellointerview.com/learn/system-design']) {
    const w = load({}, { toggleReply: { handled: true } });
    await w.ctx.onIconClicked({ id: 7, url });
    assert.deepEqual(w.calls.sent, [], url);
    assert.deepEqual(w.calls.fetched, [], url);
    assert.deepEqual(plain(w.calls.created), [{ url: 'http://127.0.0.1:8765/index.html', active: true }], url);
  }
  // a learn page but no tab id: still no background mode
  const w = load({}, { toggleReply: { handled: true } });
  await w.ctx.onIconClicked({ url: HURL });
  assert.deepEqual(w.calls.fetched, []);
  assert.deepEqual(plain(w.calls.created), [{ url: 'http://127.0.0.1:8765/index.html', active: true }]);
});

test('HelloInterview never runs in background mode', async () => {
  for (const requested of [{ id: HID, url: HURL, site: 'hellointerview' }, { id: HID, url: 'x', site: 'youtube' }]) {
    const injected = [];
    const w = load(helloRoutes(), { executeScript: captureScript(helloRaw, injected) });
    const r = await w.ctx.runJob(requested, { mode: 'background' });
    assert.deepEqual(plain(r), { ok: false, error: HELLO_ONLY_PAGE }, requested.site);
    assert.deepEqual(w.calls.fetched, []);
    assert.deepEqual(w.calls.created, []);
    assert.deepEqual(injected, []);
  }
  // the bridge (local page) asks for a background capture: refused, never reaches /add
  const w = load(helloRoutes());
  const reply = await new Promise((resolve) => {
    w.listeners.external({ type: 'ytlearn:capture', videoId: HID }, { origin: 'http://127.0.0.1:8765', tab: { id: 3 } }, resolve);
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.error, '無法辨識的影片 id', 'stopped by the ytLearnParseVideoId guard');
  assert.deepEqual(w.calls.fetched, []);
  assert.deepEqual(w.calls.created, []);
});

test('ytlearn:build from a HelloInterview overlay carries the page url; a url naming another page is refused', async () => {
  const injected = [];
  const w = load(helloRoutes(), { executeScript: captureScript(helloRaw, injected) });
  const { r, ret } = await ask(w, { type: 'ytlearn:build', videoId: HID, url: HURL }, { id: EXT, tab: { id: 42 } });
  assert.equal(ret, true);
  assert.equal(r.ok, true);
  assert.deepEqual(plain(w.calls.bodies['POST /add']), { url: HURL });
  assert.deepEqual(plain(injected[0]), { target: { tabId: 42 }, files: ['vtt.js', 'hellointerview-capture.js'], world: 'ISOLATED' });
  assert.deepEqual(w.calls.created, []);
  const other = load(helloRoutes());
  for (const url of ['https://www.hellointerview.com/learn/system-design/patterns/other', 'https://www.hellointerview.com/practice/x', LURL]) {
    const bad = await ask(other, { type: 'ytlearn:build', videoId: HID, url });
    assert.equal(bad.ret, false, url);
    assert.equal(bad.r.ok, false, url);
  }
  const noUrl = await ask(other, { type: 'ytlearn:build', videoId: HID });
  assert.equal(noUrl.r.ok, false);
  assert.deepEqual(other.calls.fetched, []);
});

test('ytlearn:lesson / ytlearn:job accept hello ids', async () => {
  const w = load({ ['GET /data/lessons/' + HID + '.json']: { status: 200, json: { videoId: HID } }, ['GET /jobs/' + HID]: { status: 404 } });
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:lesson', videoId: HID })).r), { lesson: { videoId: HID } });
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:job', videoId: HID })).r), { missing: true });
  assert.deepEqual(w.calls.fetched, ['GET /data/lessons/' + HID + '.json', 'GET /jobs/' + HID]);
});

test('captureInPlace never falls back to capture.js for a hello id', async () => {
  // even when the request is mislabelled with another site, the id decides
  for (const site of ['hellointerview', 'youtube', undefined]) {
    const injected = [];
    const w = load({}, { executeScript: captureScript(helloRaw, injected) });
    await w.ctx.captureInPlace(7, { id: HID, url: HURL, site });
    assert.deepEqual(plain(injected[0].files), ['vtt.js', 'hellointerview-capture.js'], String(site));
    assert.ok(!injected[0].files.includes('capture.js'));
    assert.ok(injected.every((x) => x.world === 'ISOLATED'));
    assert.equal(injected[1].args[0], 'ytLearnHelloCapture');
  }
  const src = SRC.slice(SRC.indexOf('async function captureInPlace'), SRC.indexOf('async function captureInBackground'));
  assert.ok(src.indexOf("'hellointerview-capture.js'") < src.lastIndexOf('expectVideoId'), 'hello branch comes before the YouTube default');
});

test('siteOfUrl: HelloInterview learn pages only', () => {
  const w = load();
  for (const u of [HURL, 'https://www.hellointerview.com/learn/system-design', 'https://www.hellointerview.com/learn/system-design/']) {
    assert.equal(w.ctx.siteOfUrl(u), 'hellointerview', u);
  }
  for (const u of ['https://www.hellointerview.com/', 'https://www.hellointerview.com/learn/', 'https://www.hellointerview.com/practice/x',
    'https://app.hellointerview.com/learn/x', 'https://www.hellointerview.com:444/learn/x', HID]) assert.equal(w.ctx.siteOfUrl(u), null, u);
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

test('reconcile: a registration reported without its default fields (world/runAt/allFrames/persist omitted) counts as matching', async () => {
  const { world, runAt, allFrames, persistAcrossSessions, ...bare } = OVERLAY_REG;
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, registered: [HOOK_REG, bare] } });
  await settle();
  assert.deepEqual(w.calls.scriptOps, []);
  const v = load({}, { nf: { local: { netflix: ON }, perm: true, registered: [{ ...HOOK_REG, world: undefined }, OVERLAY_REG] } });
  await settle();
  assert.deepEqual(v.calls.scriptOps, ['unregister:ytlearn-netflix-hook', 'register:ytlearn-netflix-hook'], 'the hook must be MAIN');
});

test('reconcile: re-registering does not fix what Chrome reports -> logged once as stuck, no further unregister/register in this worker', async () => {
  const report = (r) => ({ ...r, matches: [...r.matches, 'https://www.netflix.com/watch/*'] }); // Chrome reports it differently
  const w = load({}, { nf: { local: { netflix: ON }, perm: true, registered: [HOOK_REG, OVERLAY_REG], report } });
  await settle();
  assert.deepEqual(w.calls.scriptOps, ['unregister:ytlearn-netflix-hook,ytlearn-netflix-overlay', 'register:ytlearn-netflix-hook,ytlearn-netflix-overlay']);
  const st = plain(await w.ctx.reconcileNetflix());
  await w.ctx.reconcileNetflix();
  assert.equal(w.calls.scriptOps.length, 2, 'no loop');
  assert.equal(st.enabled, true, 'present-but-mismatching registrations still count as registered');
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
  const w = load({}, { nf: { local: { netflix: { desired: false, gen: 1, cleanup: false } }, perm: true, tabUrls: { 7: NURL } } });
  await settle();
  const { r } = await ask(w, { type: 'ytlearn:netflix-set', desired: true, tab: 7 }, PAGE_SENDER);
  assert.deepEqual(plain(r), { ok: true, reloaded: true });
  assert.deepEqual(plain(w.local.netflix), { desired: true, gen: 2, cleanup: false });
  assert.deepEqual(regs(w), [HOOK_REG, OVERLAY_REG]);
  assert.deepEqual(w.calls.reloaded, [7]);
});

test('netflix-set true: the ?tab is no longer on Netflix (or gone) -> enabled, no reload, reloaded:false', async () => {
  for (const tabUrls of [{ 7: 'https://www.youtube.com/watch?v=' + VID }, {}]) {
    const w = load({}, { nf: { perm: true, tabUrls } });
    await settle();
    const { r } = await ask(w, { type: 'ytlearn:netflix-set', desired: true, tab: 7 }, PAGE_SENDER);
    assert.deepEqual(plain(r), { ok: true, reloaded: false });
    assert.deepEqual(w.calls.reloaded, []);
    assert.equal(w.registered.size, 2);
  }
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
  assert.deepEqual(plain(again.r), { ok: true, reloaded: false }, 'tab 7 has no Netflix url in this fake: not reloaded');
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

test('menu checkbox: granted but set true answers needPermission -> the enable page opens with ?reason=needPermission', async () => {
  const w = load({}, { nf: { perm: false } });
  await settle();
  w.ctx.chrome.permissions.request = async () => true; // prompt says yes, but the permission is gone again by the time set runs
  w.listeners.menuClicked({ menuItemId: 'ytlearn-netflix', checked: true });
  await settle();
  assert.deepEqual(plain(w.calls.created), [{ url: ENABLE_PAGE + '?reason=needPermission', active: true }]);
  assert.deepEqual(w.calls.localSets, []);
  assert.deepEqual(plain(w.calls.menuUpdates).at(-1), ['ytlearn-netflix', false]);
});

test('menu checkbox: registration fails -> the enable page opens with the reason; a denied prompt opens nothing', async () => {
  const w = load({}, { nf: { perm: false, registerFails: true } });
  await settle();
  w.listeners.menuClicked({ menuItemId: 'ytlearn-netflix', checked: true });
  await settle();
  assert.equal(w.calls.created.length, 1);
  assert.ok(w.calls.created[0].url.startsWith(ENABLE_PAGE + '?reason='));
  assert.match(decodeURIComponent(w.calls.created[0].url), /註冊失敗/);
});

test('menu checkbox: permission denied -> nothing written, checkbox back to unchecked', async () => {
  const w = load({}, { nf: { perm: false, request: () => false } });
  await settle();
  w.listeners.menuClicked({ menuItemId: 'ytlearn-netflix', checked: true });
  await settle();
  assert.deepEqual(w.calls.localSets, []);
  assert.deepEqual(w.calls.created, [], 'the user said no: no page');
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

test('entry points while Netflix is on: netflix.<id> is an ordinary lesson id (normal lesson/job/build path)', async () => {
  const w = load({ ['GET /data/lessons/' + NID + '.json']: { status: 404 }, ['GET /jobs/' + NID]: { status: 404 } },
    { nf: { local: { netflix: ON }, perm: true } });
  await settle();
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:lesson', videoId: NID })).r), { missing: true });
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:job', videoId: NID })).r), { missing: true });
  // build: the page URL must name the same lesson; a missing URL is not guessed for a non-YouTube id.
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:build', videoId: NID, url: 'https://www.netflix.com/watch/999' })).r),
    { ok: false, error: '換課了，請回到原講座再試' });
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:build', videoId: NID })).r), { ok: false, error: '缺少講座網址' });
  // build from a message without a tab never reaches /add (no background mode for Netflix)
  const noTab = await ask(w, { type: 'ytlearn:build', videoId: NID, url: NURL }, { id: EXT });
  assert.deepEqual(plain(noTab.r), { ok: false, error: '沒有可擷取的分頁' });
  assert.deepEqual(w.calls.fetched, ['GET /data/lessons/' + NID + '.json', 'GET /jobs/' + NID]);
});

const nfRoutes = (extra = {}) => ({
  'POST /add': { status: 200, json: { job: { videoId: NID, state: 'queued', attempt: 1, message: '' } } },
  ['POST /jobs/' + NID + '/claim']: { status: 200, json: { attempt: 1 } },
  'POST /ingest?attempt=1': { status: 200, json: { ok: true, job: { videoId: NID, state: 'captured', attempt: 1, message: '' } } },
  ['POST /jobs/' + NID + '/fail']: { status: 200, json: { ok: true } },
  ...extra,
});
const nfRaw = { videoId: NID, source: 'netflix', sourceUrl: 'https://www.netflix.com/watch/81234567', title: 'T', channel: 'Netflix', duration: 1500,
  lang: 'en', kind: 'manual', capturedAt: '2026-11-01T00:00:00.000Z', events: [{ t: 0, d: 1000, segs: [[null, 'hi']] }], refStatus: 'missing' };

test('Netflix build (overlay message, on): /add -> claim -> capture (ISOLATED, NF_CAPTURE files, expectLessonId) -> /ingest', async () => {
  const injected = [];
  const w = load(nfRoutes(), { executeScript: captureScript(nfRaw, injected), nf: { local: { netflix: ON }, perm: true } });
  await settle();
  const { r, ret } = await ask(w, { type: 'ytlearn:build', videoId: NID, url: NURL }, { id: EXT, tab: { id: 42 } });
  assert.equal(ret, true);
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls.fetched, ['POST /add', 'POST /jobs/' + NID + '/claim', 'POST /ingest?attempt=1']);
  assert.deepEqual(plain(w.calls.bodies['POST /add']), { url: NURL });
  assert.deepEqual(plain(injected[0]), { target: { tabId: 42 }, files: ['netflix-manifest.js', 'ttml.js', 'netflix-capture.js'], world: 'ISOLATED' });
  assert.equal(injected[1].world, 'ISOLATED');
  assert.deepEqual(plain(injected[1].args), ['ytLearnNetflixCapture', { expectLessonId: NID, timeoutMs: 25000 }]);
  assert.deepEqual(plain(w.calls.bodies['POST /ingest?attempt=1']), nfRaw);
});

test('Netflix job: switched off and on again during the capture (gen changed) -> /fail, {disabled:true}, no /ingest', async () => {
  let w;
  const executeScript = async (o) => {
    if (o.files) return [{}];
    w.local.netflix = { desired: true, gen: ON.gen + 1, cleanup: false };
    return [{ result: { ok: true, raw: nfRaw } }];
  };
  w = load(nfRoutes(), { executeScript, nf: { local: { netflix: ON }, perm: true } });
  await settle();
  const r = plain(await w.ctx.runJob({ id: NID, url: NURL, site: 'netflix' }, { mode: 'inplace', tabId: 7 }));
  assert.equal(r.ok, false);
  assert.equal(r.disabled, true);
  assert.equal(r.error, 'Netflix 尚未啟用');
  assert.deepEqual(w.calls.fetched, ['POST /add', 'POST /jobs/' + NID + '/claim', 'POST /jobs/' + NID + '/fail']);
  assert.deepEqual(plain(w.calls.bodies['POST /jobs/' + NID + '/fail']), { attempt: 1, message: 'Netflix 尚未啟用' });
  // switched off (desired false) during the capture: same
  let v;
  v = load(nfRoutes(), { executeScript: async (o) => { if (o.files) return [{}]; v.local.netflix = { desired: false, gen: ON.gen + 1, cleanup: true }; return [{ result: { ok: true, raw: nfRaw } }]; },
    nf: { local: { netflix: ON }, perm: true } });
  await settle();
  const r2 = plain(await v.ctx.runJob({ id: NID, url: NURL, site: 'netflix' }, { mode: 'inplace', tabId: 7 }));
  assert.deepEqual({ ok: r2.ok, disabled: r2.disabled }, { ok: false, disabled: true });
  assert.ok(!v.calls.fetched.includes('POST /ingest?attempt=1'));
});

test('Netflix job: no tab / background mode -> 「Netflix 沒有背景模式…」 before /add; another movie in raw -> /fail', async () => {
  const w = load(nfRoutes(), { nf: { local: { netflix: ON }, perm: true } });
  await settle();
  for (const opts of [{ mode: 'background' }, { mode: 'inplace' }]) {
    const r = plain(await w.ctx.runJob({ id: NID, url: NURL, site: 'netflix' }, opts));
    assert.deepEqual(r, { ok: false, error: 'Netflix 沒有背景模式，請在 Netflix 播放頁按圖示' });
  }
  assert.deepEqual(w.calls.fetched, []);
  const injected = [];
  const m = load(nfRoutes(), { executeScript: captureScript({ ...nfRaw, videoId: 'netflix.1' }, injected), nf: { local: { netflix: ON }, perm: true } });
  await settle();
  const r = plain(await m.ctx.runJob({ id: NID, url: NURL, site: 'netflix' }, { mode: 'inplace', tabId: 7 }));
  assert.equal(r.ok, false);
  assert.equal(r.disabled, undefined);
  assert.deepEqual(m.calls.fetched, ['POST /add', 'POST /jobs/' + NID + '/claim', 'POST /jobs/' + NID + '/fail']);
});

test('NF_CAPTURE: manifest helpers, TTML parser, then the capture, all in the isolated world', () => {
  const w = load();
  assert.deepEqual(plain(vm.runInContext('NF_CAPTURE', w.ctx)), { files: ['netflix-manifest.js', 'ttml.js', 'netflix-capture.js'], world: 'ISOLATED', fn: 'ytLearnNetflixCapture' });
  assert.equal(vm.runInContext("isNetflixId(' netflix.81234567 ')", w.ctx), true);
  assert.equal(vm.runInContext("isNetflixId('udemy.81234567')", w.ctx), false);
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

test('icon on a Netflix watch page while on: overlay answers {handled:true} -> nothing else (no job, no tab, no probe)', async () => {
  const w = load({}, { toggleReply: { handled: true }, nf: { local: { netflix: ON }, perm: true, tabUrls: { 7: NURL } } });
  await settle();
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.deepEqual(plain(w.calls.sent), [{ tabId: 7, msg: { type: 'ytlearn:toggle' } }]);
  assert.deepEqual(w.calls.fetched, []);
  assert.deepEqual(w.calls.created, []);
  assert.equal(w.store.netflixProbe, undefined, 'the icon no longer runs the probe');
});

const NO_PLAYER = 'yt-learn：找不到 Netflix 播放器，請重新整理頁面';

test('icon on a Netflix watch page while on: overlay not handled -> runJob inplace (NF_CAPTURE); then asks the overlay again; handled -> no badge, no local page', async () => {
  const injected = [];
  const w = load(nfRoutes(), { toggleReply: [{ handled: false }, { handled: true }], executeScript: captureScript(nfRaw, injected), nf: { local: { netflix: ON }, perm: true, tabUrls: { 7: NURL } } });
  await settle();
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.deepEqual(plain(w.calls.sent.map((x) => x.msg)), [{ type: 'ytlearn:toggle' }, { type: 'ytlearn:mount', videoId: NID }], 'asked again after the job, mount-only, for the captured episode');
  assert.deepEqual(w.calls.fetched, ['POST /add', 'POST /jobs/' + NID + '/claim', 'POST /ingest?attempt=1']);
  assert.deepEqual(plain(w.calls.bodies['POST /add']), { url: NURL });
  assert.deepEqual(plain(injected[0]), { target: { tabId: 7 }, files: ['netflix-manifest.js', 'ttml.js', 'netflix-capture.js'], world: 'ISOLATED' });
  assert.deepEqual(plain(injected[1].args), ['ytLearnNetflixCapture', { expectLessonId: NID, timeoutMs: 25000 }]);
  assert.deepEqual(w.calls.created, [], 'Netflix has no local player: no index.html tab');
  assert.ok(!w.calls.titles.includes(NO_PLAYER));
  assert.equal(w.store.netflixProbe, undefined);
});

test('icon on a Netflix watch page while on: job ok but the overlay still declines -> badge 「找不到 Netflix 播放器」', async () => {
  const w = load(nfRoutes(), { toggleReply: { handled: false }, executeScript: captureScript(nfRaw, []), nf: { local: { netflix: ON }, perm: true } });
  await settle();
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.deepEqual(plain(w.calls.sent.map((x) => x.msg.type)), ['ytlearn:toggle', 'ytlearn:mount']);
  assert.ok(w.calls.titles.includes(NO_PLAYER));
  assert.deepEqual(w.calls.created, []);
});

test('icon on a Netflix watch page while on: no receiver (twice) -> job (already done) -> still no receiver -> badge; nothing opened', async () => {
  const injected = [];
  const w = load(nfRoutes({ 'POST /add': { status: 200, json: { job: { videoId: NID, state: 'done', attempt: 1, message: '完成' } } } }),
    { toggleReply: NO_RECEIVER, executeScript: async (o) => { injected.push(o); throw new Error('Cannot access contents of the page'); }, nf: { local: { netflix: ON }, perm: true } });
  await settle();
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.deepEqual(plain(injected), [{ target: { tabId: 7 }, files: ['overlay.js'] }, { target: { tabId: 7 }, files: ['overlay.js'] }]);
  assert.deepEqual(plain(w.calls.sent.map((x) => x.msg.type)), ['ytlearn:toggle', 'ytlearn:mount'], 'injection fails, so each ask is sent once');
  assert.deepEqual(w.calls.fetched, ['POST /add']);
  assert.ok(w.calls.titles.includes(NO_PLAYER));
  assert.deepEqual(w.calls.created, []);
});

test('icon on a Netflix watch page: after a 「找不到 Netflix 播放器」 badge, an overlay-handled click (after the refresh) resets the title', async () => {
  const w = load(nfRoutes(), { toggleReply: [{ handled: false }, { handled: false }, { handled: true }], executeScript: captureScript(nfRaw, []), nf: { local: { netflix: ON }, perm: true } });
  await settle();
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.equal(w.calls.titles.at(-1), NO_PLAYER);
  const fetched = w.calls.fetched.length;
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.equal(w.calls.titles.at(-1), 'yt-learn：把這支影片變成課程', 'DEFAULT_TITLE again');
  assert.equal(w.calls.fetched.length, fetched, 'the overlay took it: no job');
  // the post-job mount handled -> also cleared
  const v = load(nfRoutes(), { toggleReply: [{ handled: false }, { handled: true }], executeScript: captureScript(nfRaw, []), nf: { local: { netflix: ON }, perm: true } });
  await settle();
  await v.ctx.onIconClicked({ id: 7, url: NURL });
  assert.ok(!v.calls.titles.includes(NO_PLAYER));
  assert.equal(v.calls.titles.at(-1), 'yt-learn：把這支影片變成課程');
});

test('icon on a Netflix watch page while on: the job fails -> its own error, the overlay is not asked again', async () => {
  const w = load({}, { toggleReply: { handled: false }, nf: { local: { netflix: ON }, perm: true } });
  await settle();
  await w.ctx.onIconClicked({ id: 7, url: NURL });
  assert.equal(w.calls.sent.length, 1);
  assert.ok(!w.calls.titles.includes(NO_PLAYER));
  assert.deepEqual(w.calls.titles, ['yt-learn：本機 server 沒有回應（請確認 python3 server.py 正在執行）']);
});

test('menu 「診斷目前的 Netflix 分頁」: not a watch page -> enable page without ?tab; off -> ?tab=<id>; on -> probe + #probe', async () => {
  const notWatch = load({}, { nf: { local: { netflix: ON }, perm: true } });
  await settle();
  notWatch.listeners.menuClicked({ menuItemId: 'ytlearn-netflix-probe' }, { id: 7, url: 'https://www.netflix.com/browse' });
  notWatch.listeners.menuClicked({ menuItemId: 'ytlearn-netflix-probe' }, undefined);
  await settle();
  assert.deepEqual(plain(notWatch.calls.created), [{ url: ENABLE_PAGE, active: true }, { url: ENABLE_PAGE, active: true }]);
  const off = load({}, { nf: { perm: false } });
  await settle();
  off.listeners.menuClicked({ menuItemId: 'ytlearn-netflix-probe' }, { id: 7, url: NURL });
  await settle();
  assert.deepEqual(plain(off.calls.created), [{ url: ENABLE_PAGE + '?tab=7', active: true }]);
  assert.equal(off.store.netflixProbe, undefined);
  const injected = [];
  const on = load({}, { executeScript: captureScript(probeResult, injected), nf: { local: { netflix: ON }, perm: true, tabUrls: { 7: NURL } } });
  await settle();
  on.listeners.menuClicked({ menuItemId: 'ytlearn-netflix-probe' }, { id: 7, url: NURL });
  await settle();
  assert.deepEqual(plain(on.calls.created), [{ url: ENABLE_PAGE + '?tab=7#probe', active: true }]);
  assert.ok(on.calls.sessionSets.some((x) => JSON.parse(x).netflixProbe && JSON.parse(x).netflixProbe.state === 'running'));
  assert.deepEqual(plain(injected[0]), { target: { tabId: 7 }, files: ['netflix-manifest.js', 'ttml.js', 'netflix-capture.js'], world: 'ISOLATED' });
  assert.equal(injected[1].world, 'ISOLATED');
  assert.deepEqual(plain(injected[1].args), ['ytLearnNetflixCapture', { probe: true, expectLessonId: NID, timeoutMs: 25000 }]);
  const rec = plain(on.store.netflixProbe);
  assert.deepEqual({ state: rec.state, ok: rec.ok, tabId: rec.tabId }, { state: 'done', ok: true, tabId: 7 });
  assert.deepEqual(rec.result, probeResult);
  assert.deepEqual(on.calls.fetched, [], 'the probe never talks to the server');
});

test('background.js: no TODO(step …) markers left; the icon never starts the probe (enable page + action menu do)', () => {
  assert.ok(!/TODO\(step/.test(SRC));
  const icon = SRC.slice(SRC.indexOf('async function onNetflixIcon'), SRC.indexOf('// Action menu 「診斷目前的 Netflix 分頁」'));
  assert.ok(!/runNetflixProbe\(|#probe/.test(icon), 'the icon flow does not start the probe');
  assert.ok(/ytlearn:netflix-probe/.test(SRC));
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
  assert.deepEqual(plain(injected[0]), { target: { tabId: 7 }, files: ['netflix-manifest.js', 'ttml.js', 'netflix-capture.js'], world: 'ISOLATED' });
  assert.equal(injected[1].world, 'ISOLATED');
  assert.deepEqual(plain(injected[1].target), { tabId: 7 });
  assert.deepEqual(plain(injected[1].args), ['ytLearnNetflixCapture', { probe: true, expectLessonId: NID, timeoutMs: 25000 }]);
  assert.equal(plain(on.store.netflixProbe).state, 'done');
  assert.deepEqual(on.calls.fetched, [], 'the probe never talks to the server');
  const notWatch = plain((await ask(on, { type: 'ytlearn:netflix-probe', tab: 8 }, PAGE_SENDER)).r);
  assert.deepEqual(notWatch, { ok: false, error: '這個分頁不是 Netflix 播放頁' });
  assert.equal(injected.length, 2, 'only the watch tab got the probe');
});

test('netflix-probe: capture error is reported, and a switch during the probe discards the result', async () => {
  const failing = load({}, { executeScript: async (o) => (o.files ? [{}] : [{ result: { ok: false, error: 'Netflix hook 不在（請重新載入頁面）' } }]),
    nf: { local: { netflix: ON }, perm: true, tabUrls: { 7: NURL } } });
  await settle();
  const r = plain((await ask(failing, { type: 'ytlearn:netflix-probe', tab: 7 }, PAGE_SENDER)).r);
  assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'Netflix hook 不在（請重新載入頁面）' });
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
  for (const f of ['netflix-manifest.js', 'netflix-hook.js', 'netflix-capture.js', 'netflix-enable.js', 'background.js', 'ttml.js',
    'hellointerview-capture.js', 'udemy-capture.js', 'vtt.js', 'site.js']) {
    const src = readFileSync(new URL('../../extension/' + f, import.meta.url), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/.test(src), f);
  }
});

/* ---------- phrase explain: ytlearn:explain / ytlearn:explain-poll / ytlearn:notes (one short request each) ---------- */

const KEY = '0123456789abcdef';
const EXPLAIN = { type: 'ytlearn:explain', videoId: VID, cue: 1, a: 4, b: 7, phrase: "wouldn't it be great" };

test('ytlearn:explain: POST /explain with exactly the validated fields; the reply is {status, json} as sent', async () => {
  const w = load({ 'POST /explain': { status: 202, json: { ok: true, state: 'pending', key: KEY } } });
  const { r, ret } = await ask(w, { ...EXPLAIN, extra: 'dropped', override: 'yes' });
  assert.equal(ret, true);
  assert.deepEqual(plain(r), { status: 202, json: { ok: true, state: 'pending', key: KEY } });
  assert.deepEqual(w.calls.fetched, ['POST /explain']);
  assert.deepEqual(plain(w.calls.bodies['POST /explain']), { videoId: VID, cue: 1, a: 4, b: 7, phrase: "wouldn't it be great", override: false });
  const o = load({ 'POST /explain': { status: 200, json: { ok: true, state: 'done', key: KEY, note: {} } } });
  await ask(o, { ...EXPLAIN, override: true });
  assert.equal(o.calls.bodies['POST /explain'].override, true);
});

test('ytlearn:explain: 402 budget / 409 phrase / 429 busy pass through for the overlay to read', async () => {
  for (const [status, code] of [[402, 'budget'], [409, 'phrase'], [429, 'busy']]) {
    const json = { ok: false, error: 'e' + status, code };
    const w = load({ 'POST /explain': { status, json } });
    assert.deepEqual(plain((await ask(w, EXPLAIN)).r), { status, json });
  }
});

test('ytlearn:explain: bad id or range is refused without a request', async () => {
  const w = load({ 'POST /explain': { status: 202, json: {} } });
  const bad = [{ videoId: '../x' }, { cue: -1 }, { a: 1.5 }, { b: '7' }, { a: 8, b: 7 }, { phrase: '' }, { phrase: 3 },
    { phrase: 'x'.repeat(2001) }, { a: true }];
  for (const b of bad) {
    const { r, ret } = await ask(w, { ...EXPLAIN, ...b });
    assert.equal(ret, false, JSON.stringify(b));
    assert.ok(r.error, JSON.stringify(b));
  }
  assert.deepEqual(w.calls.fetched, []);
});

test('ytlearn:explain-poll: GET /explain/<key>; 404 passes through (the overlay re-POSTs); a bad key never reaches the server', async () => {
  const w = load({ ['GET /explain/' + KEY]: { status: 404, json: { ok: false, error: 'no such explain job' } } });
  const { r, ret } = await ask(w, { type: 'ytlearn:explain-poll', key: KEY });
  assert.equal(ret, true);
  assert.deepEqual(plain(r), { status: 404, json: { ok: false, error: 'no such explain job' } });
  for (const key of ['../notes', 'ABCDEF0123456789', KEY + '0', '', undefined, 42]) {
    const bad = await ask(w, { type: 'ytlearn:explain-poll', key });
    assert.equal(bad.ret, false);
    assert.ok(bad.r.error);
  }
  assert.deepEqual(w.calls.fetched, ['GET /explain/' + KEY]);
});

test('ytlearn:notes: GET /notes/<videoId>; server down -> {error}', async () => {
  const notes = { '4-7': { phrase: 'p', cue: 1, a: 4, b: 7, result: {} } };
  const w = load({ ['GET /notes/' + VID]: { status: 200, json: { ok: true, videoId: VID, notes } } });
  assert.deepEqual(plain((await ask(w, { type: 'ytlearn:notes', videoId: VID })).r), { status: 200, json: { ok: true, videoId: VID, notes } });
  const down = load({});
  assert.match((await ask(down, { type: 'ytlearn:notes', videoId: VID })).r.error, /本機 server 沒有回應/);
  assert.match((await ask(down, EXPLAIN)).r.error, /本機 server 沒有回應/);
});

test('phrase messages keep the sender check', async () => {
  const w = load({ 'POST /explain': { status: 202, json: {} }, ['GET /notes/' + VID]: { status: 200, json: {} }, ['GET /explain/' + KEY]: { status: 200, json: {} } });
  for (const msg of [EXPLAIN, { type: 'ytlearn:notes', videoId: VID }, { type: 'ytlearn:explain-poll', key: KEY }]) {
    const foreign = await ask(w, msg, { id: 'someone-else', tab: { id: 1 } });
    assert.equal(foreign.ret, false);
    assert.equal(foreign.r, undefined);
  }
  assert.deepEqual(w.calls.fetched, []);
});

test('phrase messages for a Netflix lesson while Netflix is off -> {disabled:true}, no request; on -> ordinary', async () => {
  const off = load({}, { nf: { perm: true } });
  await settle();
  for (const msg of [{ ...EXPLAIN, videoId: NID }, { type: 'ytlearn:notes', videoId: NID }]) {
    assert.deepEqual(plain((await ask(off, msg)).r), { disabled: true });
  }
  assert.deepEqual(off.calls.fetched, []);
  const on = load({ ['GET /notes/' + NID]: { status: 200, json: { ok: true, notes: {} } } }, { nf: { local: { netflix: ON }, perm: true } });
  await settle();
  assert.deepEqual(plain((await ask(on, { type: 'ytlearn:notes', videoId: NID })).r), { status: 200, json: { ok: true, notes: {} } });
});
