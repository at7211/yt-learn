importScripts('ytid.js');

const SERVER = 'http://127.0.0.1:8765';
const NAV_TIMEOUT_MS = 15000;
const CAPTURE_TIMEOUT_MS = 25000;
const FETCH_TIMEOUT_MS = 5000;
const SERVER_DOWN = '本機 server 沒有回應（請確認 python3 server.py 正在執行）';
const BUSY = '已有一支影片在處理中';
const SWITCHED = '換課了，請回到原講座再試';
const TAB_CLOSED = '擷取用的分頁已被關閉';
const DEFAULT_TITLE = 'yt-learn：把這支影片變成課程';
const DICT_ORIGIN = 'https://dictionary.cambridge.org/';
const DICT_W = 520;
const DICT_H = 760;

const log = (stage, ...a) => console.log('[yt-learn]', stage, ...a);
const errMsg = (e) => String((e && e.message) || e);
const navWaiters = new Map();
let busy = null;

/* ---------- 頂層 listener ---------- */

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const w = navWaiters.get(tabId);
  if (w) w.check(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const w = navWaiters.get(tabId);
  if (w) w.fail(new Error(TAB_CLOSED));
});

chrome.action.onClicked.addListener((tab) => {
  onIconClicked(tab).catch((e) => log('icon:error', errMsg(e)));
});

/* ---------- 圖示右鍵選單：首頁、設定（設定存在本機 server，所以不用 options_ui） ---------- */

const MENU = [
  { id: 'ytlearn-home', title: '打開 yt-learn 首頁', url: SERVER + '/index.html' },
  { id: 'ytlearn-settings', title: '設定', url: SERVER + '/index.html#settings' },
];

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: onInstalled also fires on update/reload, and a duplicate id is an error.
  chrome.contextMenus.removeAll(() => {
    for (const m of MENU) {
      chrome.contextMenus.create({ id: m.id, title: m.title, contexts: ['action'] }, () => {
        if (chrome.runtime.lastError) log('menu:create-failed', m.id, chrome.runtime.lastError.message);
      });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const m = MENU.find((x) => x.id === info.menuItemId);
  if (!m) return;
  chrome.tabs.create({ url: m.url, active: true }).catch((e) => log('menu:open-failed', errMsg(e)));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'ytlearn:ping') {
    log('bridge:ping', sender.tab && sender.tab.id);
    sendResponse({ type: 'ytlearn:ack', version: chrome.runtime.getManifest().version });
    return false;
  }
  if (msg.type === 'ytlearn:capture') {
    const tabId = sender.tab && sender.tab.id;
    const videoId = ytLearnParseVideoId(typeof msg.videoId === 'string' ? msg.videoId : '');
    if (!videoId) {
      const error = '無法辨識的影片 id';
      sendResponse({ type: 'ytlearn:accepted', accepted: false, videoId: msg.videoId, error });
      sendStatus(tabId, { videoId: msg.videoId, state: 'error', message: error });
      return false;
    }
    log('bridge:capture', videoId, 'from tab', tabId);
    sendResponse({ type: 'ytlearn:accepted', accepted: true, videoId });
    onPageCapture(videoId, tabId).catch((e) => log('bridge:error', errMsg(e)));
    return false;
  }
  if (msg.type === 'ytlearn:dict') {
    const url = typeof msg.url === 'string' ? msg.url : '';
    if (!url.startsWith(DICT_ORIGIN)) {
      log('dict:rejected', url);
      sendResponse({ ok: false, error: '不是劍橋字典的網址' });
      return false;
    }
    openDict(url, msg.screen).then(sendResponse, (e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  if (msg.type === 'ytlearn:lesson' || msg.type === 'ytlearn:job' || msg.type === 'ytlearn:build') {
    const videoId = ytLearnParseLessonId(typeof msg.videoId === 'string' ? msg.videoId : '');
    if (!videoId) {
      sendResponse({ error: '無法辨識的影片 id' });
      return false;
    }
    if (msg.type === 'ytlearn:build') {
      const tabId = sender.tab && sender.tab.id;
      if (typeof tabId !== 'number') {
        sendResponse({ ok: false, error: '沒有可擷取的分頁' });
        return false;
      }
      // Overlay on a lesson page: capture in that tab, no onAdded, no new tab, no ownedTabs entry.
      // The overlay sends the page URL it saw; it must name the same lesson. (No url: a YouTube id
      // stands for its canonical watch URL, as before.)
      let requested;
      if (typeof msg.url === 'string') {
        const site = siteOfUrl(msg.url);
        if (!site || ytLearnParseLessonId(msg.url) !== videoId) {
          sendResponse({ ok: false, error: SWITCHED });
          return false;
        }
        requested = { id: videoId, url: msg.url, site };
      } else if (ytLearnLessonSource(videoId) === 'youtube') {
        requested = { id: videoId, url: ytLearnCanonicalUrl(videoId), site: 'youtube' };
      } else {
        sendResponse({ ok: false, error: '缺少講座網址' });
        return false;
      }
      log('overlay:build', videoId, 'tab', tabId);
      runJob(requested, { mode: 'inplace', tabId }).then(sendResponse, (e) => sendResponse({ ok: false, error: errMsg(e) }));
      return true;
    }
    overlayFetch(msg.type, videoId).then(sendResponse);
    return true;
  }
  return false;
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const fromLocal = sender.origin === SERVER || (typeof sender.url === 'string' && sender.url.startsWith(SERVER + '/'));
  if (!fromLocal) {
    log('external:rejected', sender.origin, sender.url);
    return false;
  }
  if (msg && (msg.type === 'probe' || msg.type === 'ytlearn:capture') && typeof msg.videoId === 'string') {
    const videoId = ytLearnParseVideoId(msg.videoId);
    if (!videoId) {
      sendResponse({ ok: false, error: '無法辨識的影片 id' });
      return false;
    }
    log('external:capture', videoId);
    runJob(youtubeRequest(videoId), { mode: 'background' }).then(sendResponse, (e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  return false;
});

chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.session.get('dictWindowId').then((got) => {
    if (got.dictWindowId === windowId) return chrome.storage.session.set({ dictWindowId: null });
  }).catch((e) => log('dict:forget-failed', errMsg(e)));
});

const startup = cleanupOwnedTabs();

/* ---------- 入口 ---------- */

// 'youtube' for a www.youtube.com watch page, 'udemy' for a www.udemy.com lecture page, else null.
// Both are pages where the overlay content script runs and the capture happens in place.
function siteOfUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('https://www.youtube.com/watch')) return 'youtube';
  if (ytLearnParseUdemyUrl(url)) return 'udemy';
  return null;
}

// A YouTube id that came without a page URL (local page, bridge): its canonical watch URL stands in.
function youtubeRequest(videoId) {
  return { id: videoId, url: ytLearnCanonicalUrl(videoId), site: 'youtube' };
}

// Toggle the overlay in a watch tab. A tab opened before the extension was (re)loaded has no content
// script, so on "no receiver" inject overlay.js once (it guards against double loading) and ask again.
async function askOverlay(tabId) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'ytlearn:toggle' });
  try {
    return await ask();
  } catch (e) {
    log('icon:no-overlay', errMsg(e));
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    return await ask();
  } catch (e) {
    log('icon:inject-failed', errMsg(e));
    return null;
  }
}

async function onIconClicked(tab) {
  const url = (tab && tab.url) || '';
  const site = siteOfUrl(url);
  // Frozen at click time: the job, the capture and the ingest must all be about this lesson.
  const videoId = ytLearnParseLessonId(url);
  log('icon', url, videoId, site);
  // Udemy has no background mode: only a lecture page in a real tab can be captured.
  const udemy = ytLearnLessonSource(videoId) === 'udemy';
  if (!videoId || (udemy && (site !== 'udemy' || typeof tab.id !== 'number'))) {
    await chrome.tabs.create({ url: SERVER + '/index.html', active: true });
    return;
  }
  const requested = { id: videoId, url: site ? url : ytLearnCanonicalUrl(videoId), site: site || 'youtube' };
  const inPlace = site !== null && typeof tab.id === 'number';
  if (inPlace) {
    // The overlay content script (overlay.js) takes over on watch/lecture pages. No receiver (a tab opened
    // before the extension was loaded) → fall through to the original flow below.
    const reply = await askOverlay(tab.id);
    if (reply && reply.handled) {
      log('icon:overlay', videoId);
      return;
    }
  }
  const pageUrl = SERVER + '/index.html?v=' + videoId;
  let opened = false;
  const openPage = () => {
    if (opened) return;
    opened = true;
    chrome.tabs.create({ url: pageUrl, active: true }).catch((e) => log('icon:open-failed', errMsg(e)));
  };
  const result = await runJob(requested, inPlace
    ? { mode: 'inplace', tabId: tab.id, onAdded: openPage }
    : { mode: 'background', onAdded: openPage });
  log('icon:result', JSON.stringify(result));
  if (!result.ok && result.attempt === undefined) showBadgeError(result.error);
  openPage();
}

function showBadgeError(message) {
  chrome.action.setBadgeText({ text: '!' }).catch((e) => log('ignored', errMsg(e)));
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch((e) => log('ignored', errMsg(e)));
  chrome.action.setTitle({ title: 'yt-learn：' + message }).catch((e) => log('ignored', errMsg(e)));
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' }).catch((e) => log('ignored', errMsg(e)));
  chrome.action.setTitle({ title: DEFAULT_TITLE }).catch((e) => log('ignored', errMsg(e)));
}

async function onPageCapture(videoId, pageTabId) {
  let emitted = false;
  const onStatus = (s) => {
    emitted = true;
    sendStatus(pageTabId, { videoId, ...s });
  };
  const result = await runJob(youtubeRequest(videoId), { mode: 'background', onStatus });
  log('bridge:result', JSON.stringify(result));
  if (result.done) sendStatus(pageTabId, { videoId, attempt: result.job && result.job.attempt, state: 'done', message: '完成' });
  else if (result.inProgress) sendStatus(pageTabId, { videoId, attempt: result.job && result.job.attempt, state: (result.job && result.job.state) || 'capturing', message: '已在處理中' });
  else if (!result.ok && !emitted) sendStatus(pageTabId, { videoId, state: 'error', message: result.error });
}

function sendStatus(tabId, s) {
  if (typeof tabId !== 'number') return;
  const msg = { type: 'ytlearn:status', videoId: s.videoId, attempt: s.attempt, state: s.state, message: s.message || '' };
  log('status', tabId, JSON.stringify(msg));
  chrome.tabs.sendMessage(tabId, msg).catch((e) => log('status:undelivered', errMsg(e)));
}

/* ---------- overlay (overlay.js asks; one GET each, never touches `busy`) ---------- */

// -> {lesson} | {job} | {missing:true} (404) | {error} (server down or bad response)
async function overlayFetch(type, videoId) {
  const path = type === 'ytlearn:lesson' ? '/data/lessons/' + videoId + '.json' : '/jobs/' + videoId;
  try {
    const r = await api(path);
    if (r.status === 404) return { missing: true };
    if (r.status !== 200 || !r.json) return { error: serverError(r) };
    if (type === 'ytlearn:lesson') return { lesson: r.json };
    return r.json.job ? { job: r.json.job } : { missing: true };
  } catch (e) {
    return { error: errMsg(e) };
  }
}

/* ---------- dictionary popup (overlay.js: click a subtitle word → ytlearn:dict) ---------- */

// One small popup window beside the video, reused for later lookups: its id lives in storage.session
// (dictWindowId) so it survives the worker going to sleep. Lookups are queued so two quick clicks
// never open two windows.
let dictQueue = Promise.resolve();

function openDict(url, screen) {
  const run = dictQueue.then(() => openDictInner(url, screen));
  dictQueue = run.catch(() => { });
  return run;
}

async function openDictInner(url, screen) {
  const got = await chrome.storage.session.get('dictWindowId');
  const id = got.dictWindowId;
  if (typeof id === 'number') {
    try {
      const tabs = await chrome.tabs.query({ windowId: id });
      const tab = tabs && tabs[0];
      if (tab && typeof tab.id === 'number') {
        await chrome.tabs.update(tab.id, { url });
        await chrome.windows.update(id, { focused: true });
        log('dict:reuse', id, url);
        return { ok: true, windowId: id };
      }
    } catch (e) {
      log('dict:window-gone', id, errMsg(e));
    }
  }
  // A service worker has no `screen`: the content script sends its screen's available area.
  const s = screen && typeof screen === 'object' ? screen : {};
  const opts = { url, type: 'popup', width: DICT_W, height: DICT_H, focused: true };
  if (Number.isFinite(s.width) && s.width > DICT_W) opts.left = Math.round((Number.isFinite(s.left) ? s.left : 0) + s.width - DICT_W - 20);
  const win = await chrome.windows.create(opts);
  await chrome.storage.session.set({ dictWindowId: win && typeof win.id === 'number' ? win.id : null });
  log('dict:create', win && win.id, url);
  return { ok: true, windowId: win && win.id };
}

/* ---------- job ---------- */

// requested = {id, url, site}: the lesson the user asked for, frozen when they asked.
function runJob(requested, opts) {
  if (busy) {
    log('busy', requested.id);
    return Promise.resolve({ ok: false, error: BUSY });
  }
  busy = runJobInner(requested, opts || {})
    .catch((e) => ({ ok: false, error: errMsg(e) }))
    .then((result) => {
      if (result.ok) clearBadge();
      return result;
    })
    .finally(() => { busy = null; });
  return busy;
}

async function runJobInner(requested, opts) {
  await startup;
  const videoId = requested.id;
  const mode = opts.mode === 'inplace' ? 'inplace' : 'background';
  const emit = (s) => { try { if (opts.onStatus) opts.onStatus(s); } catch (e) { log('ignored', errMsg(e)); } };
  if (requested.site === 'udemy' && mode !== 'inplace') return { ok: false, error: 'Udemy 講座只能在講座頁上擷取' };
  const canonical = requested.site === 'youtube' ? ytLearnCanonicalUrl(videoId) : null;

  log('add', videoId, mode, requested.url);
  const add = await api('/add', { method: 'POST', body: { url: requested.url } });
  const job = add.json && add.json.job;
  if (add.status !== 200 || !job) return { ok: false, error: '加入工作失敗：' + serverError(add) };
  log('add:job', JSON.stringify(job));
  if (job.videoId !== videoId) {
    log('add:id-mismatch', videoId, job.videoId);
    return { ok: false, error: '伺服器回傳的課程 id（' + job.videoId + '）與這一頁（' + videoId + '）不符' };
  }
  try { if (opts.onAdded) opts.onAdded(job); } catch (e) { log('ignored', errMsg(e)); }
  if (job.state === 'done') return { ok: true, done: true, lessonUrl: SERVER + '/index.html?v=' + videoId, job };
  if (job.state !== 'queued') return { ok: true, inProgress: true, job };

  const claim = await api('/jobs/' + videoId + '/claim', { method: 'POST', body: {} }); // a body sets Content-Type: application/json, which the server requires
  if (claim.status === 409) {
    log('claim:conflict', videoId);
    return { ok: true, inProgress: true, job };
  }
  const attempt = claim.json && claim.json.attempt;
  if (claim.status !== 200 || typeof attempt !== 'number') return { ok: false, error: '無法開始擷取：' + serverError(claim) };
  log('claim', videoId, 'attempt', attempt);
  emit({ attempt, state: 'capturing', message: '' });

  const ctx = { tabId: null, owned: false };
  const t0 = Date.now();
  try {
    const raw = mode === 'inplace'
      ? await captureInPlace(opts.tabId, requested)
      : await captureInBackground(videoId, canonical, attempt, ctx);
    if (!raw || raw.videoId !== videoId) {
      log('capture:id-mismatch', videoId, raw && raw.videoId);
      throw new Error(SWITCHED);
    }
    log('capture:ok', videoId, raw.events.length, 'events', Date.now() - t0, 'ms');

    const ing = await api('/ingest?attempt=' + attempt, { method: 'POST', body: raw });
    log('ingest', ing.status, JSON.stringify(ing.json));
    if (ing.status !== 200) throw new Error('送出字幕失敗：' + serverError(ing));
    emit({ attempt, state: 'captured', message: '' });
    return { ok: true, job: (ing.json && ing.json.job) || null };
  } catch (e) {
    const message = errMsg(e);
    log('capture:failed', videoId, message, Date.now() - t0, 'ms');
    try {
      const f = await api('/jobs/' + videoId + '/fail', { method: 'POST', body: { attempt, message } });
      log('fail', f.status);
    } catch (e2) {
      log('fail:unreachable', errMsg(e2));
    }
    emit({ attempt, state: 'error', message });
    return { ok: false, error: message, attempt };
  } finally {
    if (ctx.owned && ctx.tabId !== null) {
      await chrome.tabs.remove(ctx.tabId).catch(() => { });
      await forgetOwnedTab(ctx.tabId).catch((e) => log('ownedTabs:error', errMsg(e)));
      log('tab:closed', ctx.tabId);
    }
  }
}

async function captureInPlace(tabId, requested) {
  if (typeof tabId !== 'number') throw new Error('沒有可擷取的分頁');
  log('capture:inplace', tabId, requested.id, requested.site);
  if (requested.site === 'udemy') {
    // Isolated world for both phases: udemy-capture.js needs vtt.js's global in the same world.
    return injectCapture(tabId, { expectLessonId: requested.id, timeoutMs: CAPTURE_TIMEOUT_MS },
      { files: ['vtt.js', 'udemy-capture.js'], world: 'ISOLATED', fn: 'ytLearnUdemyCapture' });
  }
  return injectCapture(tabId, { expectVideoId: requested.id, timeoutMs: CAPTURE_TIMEOUT_MS, inPlace: true });
}

async function captureInBackground(videoId, canonical, attempt, ctx) {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  ctx.tabId = tab.id;
  ctx.owned = true;
  await chrome.tabs.update(tab.id, { muted: true });
  await rememberOwnedTab(tab.id, { videoId, attempt, createdAt: Date.now() });
  log('tab:created', tab.id);
  const t0 = Date.now();
  await chrome.tabs.update(tab.id, { url: canonical });
  await waitForWatchPage(tab.id, NAV_TIMEOUT_MS);
  log('nav:complete', tab.id, Date.now() - t0, 'ms');
  return injectCapture(tab.id, { expectVideoId: videoId, timeoutMs: CAPTURE_TIMEOUT_MS, inPlace: false });
}

function waitForWatchPage(tabId, ms) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = (fn, v) => {
      if (navWaiters.get(tabId) !== w) return;
      navWaiters.delete(tabId);
      clearTimeout(timer);
      fn(v);
    };
    const w = {
      check: (tab) => {
        if (tab && tab.status === 'complete' && typeof tab.url === 'string' && tab.url.startsWith('https://www.youtube.com/watch')) done(resolve, tab);
      },
      fail: (e) => done(reject, e),
    };
    navWaiters.set(tabId, w);
    timer = setTimeout(() => w.fail(new Error('導航逾時：' + ms / 1000 + ' 秒內沒有載入影片頁')), ms);
    chrome.tabs.get(tabId).then(w.check, () => w.fail(new Error(TAB_CLOSED)));
  });
}

// script: which files to inject and which global to call, both in `world` (default: YouTube's capture.js in MAIN).
async function injectCapture(tabId, args, script) {
  const { files, world, fn } = script || { files: ['capture.js'], world: 'MAIN', fn: 'ytLearnCapture' };
  let results;
  let timer = null;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files, world });
    const run = chrome.scripting.executeScript({
      target: { tabId },
      world,
      func: (name, o) => globalThis[name](o).then(
        (raw) => ({ ok: true, raw }),
        (e) => ({ ok: false, error: String((e && e.message) || e) }),
      ),
      args: [fn, args],
    });
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('逾時：' + args.timeoutMs / 1000 + ' 秒內沒有取得字幕')), args.timeoutMs + 5000);
    });
    results = await Promise.race([run, guard]);
  } catch (e) {
    const alive = await chrome.tabs.get(tabId).then(() => true, () => false);
    if (!alive) throw new Error(TAB_CLOSED);
    if (errMsg(e).startsWith('逾時')) throw e;
    throw new Error('無法注入擷取腳本：' + errMsg(e));
  } finally {
    clearTimeout(timer);
  }
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('擷取腳本沒有回傳結果');
  if (!r.ok) throw new Error(r.error);
  return r.raw;
}

/* ---------- server ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(SERVER + path, init);
  } catch (e) {
    log('api:unreachable', method, path, errMsg(e));
    throw new Error(SERVER_DOWN);
  }
  let json = null;
  try { json = await res.json(); } catch (e) { log('api:non-json', method, path, res.status); }
  return { status: res.status, json };
}

function serverError(r) {
  const j = r.json || {};
  if (typeof j.error === 'string' && j.error) return j.error;
  if (Array.isArray(j.errors) && j.errors.length) return j.errors.join('；');
  return 'HTTP ' + r.status;
}

/* ---------- ownedTabs（storage.session：{tabId: {videoId, attempt, createdAt}}） ---------- */

async function readOwnedTabs() {
  const got = await chrome.storage.session.get('ownedTabs');
  const m = got.ownedTabs;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

async function rememberOwnedTab(tabId, info) {
  const m = await readOwnedTabs();
  m[String(tabId)] = info;
  await chrome.storage.session.set({ ownedTabs: m });
}

async function forgetOwnedTab(tabId) {
  const m = await readOwnedTabs();
  delete m[String(tabId)];
  await chrome.storage.session.set({ ownedTabs: m });
}

async function cleanupOwnedTabs() {
  try {
    const got = await chrome.storage.session.get('ownedTabs');
    const m = got.ownedTabs;
    const ids = Array.isArray(m) ? m : Object.keys(m && typeof m === 'object' ? m : {});
    for (const id of ids) await chrome.tabs.remove(Number(id)).catch(() => { });
    await chrome.storage.session.set({ ownedTabs: {} });
    log('startup:cleaned', JSON.stringify(ids));
  } catch (e) {
    log('startup:cleanup-failed', errMsg(e));
  }
}
