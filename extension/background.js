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
const NETFLIX_OFF = 'Netflix 尚未啟用';

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
// Checkbox mirroring "Netflix effectively enabled" (reconcileInner keeps it in sync).
const NF_MENU = { id: 'ytlearn-netflix', title: '在 Netflix 啟用（開關後請重新整理頁面）' };

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: onInstalled also fires on update/reload, and a duplicate id is an error.
  chrome.contextMenus.removeAll(() => {
    const created = (id) => () => {
      if (chrome.runtime.lastError) log('menu:create-failed', id, chrome.runtime.lastError.message);
    };
    for (const m of MENU) chrome.contextMenus.create({ id: m.id, title: m.title, contexts: ['action'] }, created(m.id));
    chrome.contextMenus.create({ id: NF_MENU.id, title: NF_MENU.title, type: 'checkbox', checked: false, contexts: ['action'] }, created(NF_MENU.id));
    reconcileNetflix().catch((e) => log('netflix:reconcile-failed', errMsg(e)));
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === NF_MENU.id) {
    onNetflixMenu(info);
    return;
  }
  const m = MENU.find((x) => x.id === info.menuItemId);
  if (!m) return;
  chrome.tabs.create({ url: m.url, active: true }).catch((e) => log('menu:open-failed', errMsg(e)));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return false;
  if (msg.type.startsWith('ytlearn:netflix-')) return onEnablePageMessage(msg, sender, sendResponse);
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
  if ((msg.type === 'ytlearn:lesson' || msg.type === 'ytlearn:job' || msg.type === 'ytlearn:build') && isNetflixId(msg.videoId)) {
    // TODO(step 3): ytLearnParseLessonId will know netflix.<id>; until then an enabled Netflix is still unknown here.
    netflixEnabled().then((on) => sendResponse(on ? { error: '無法辨識的影片 id' } : { disabled: true }),
      (e) => sendResponse({ error: errMsg(e) }));
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

// Site permission revoked from chrome://extensions → converge (desired && no permission → off). The intent is
// also re-applied at the end of this file on every worker start (not only onStartup).
chrome.permissions.onRemoved.addListener(() => {
  reconcileNetflix().catch((e) => log('netflix:reconcile-failed', errMsg(e)));
});

const startup = cleanupOwnedTabs();

/* ---------- 入口 ---------- */

// 'youtube' for a www.youtube.com watch page, 'udemy' for a www.udemy.com lecture page, 'netflix' for a
// www.netflix.com/watch/<digits> page, else null. Pages where the capture happens in place.
function siteOfUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith('https://www.youtube.com/watch')) return 'youtube';
  if (ytLearnParseUdemyUrl(url)) return 'udemy';
  if (netflixMovieIdOfUrl(url)) return 'netflix';
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
  if (site === 'netflix' && typeof tab.id === 'number') return onNetflixIcon(tab);
  if (site === 'netflix' || url.startsWith(NF_HOST)) {
    // Netflix has no background mode: only a watch page in a real tab. Other Netflix pages → home.
    await chrome.tabs.create({ url: SERVER + '/index.html', active: true });
    return;
  }
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
  if (isNetflixId(videoId) && !(await netflixEnabled())) return { disabled: true };
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
  if (requested.site === 'netflix' || isNetflixId(requested.id)) {
    // Checked before /add: a turned-off Netflix never reaches the server.
    if (!(await netflixEnabled())) return { ok: false, disabled: true, error: NETFLIX_OFF };
    return { ok: false, error: 'Netflix 擷取尚未實作' }; // TODO(step 4/5): /add → captureInPlace → gen check → /ingest
  }
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

/* ---------- Netflix (opt-in; chrome.storage.local.netflix = {desired, gen, cleanup}) ----------
   desired: the user's intent; gen: +1 on every user switch (async work records it and re-checks after each
   await); cleanup: a disable whose clean-up has not finished. reconcileInner() makes reality (site permission,
   the two registered content scripts, the menu checkbox) match the intent; every state change runs as ONE task
   on nfQueue (the dictQueue pattern) and calls only the inner, unqueued helpers. Captures and probes never
   run on the queue (a long capture must not hold up a disable). There is deliberately no permissions.onAdded
   listener: the enable flow sends its own set, and listening would race it. */

const NF_HOST = 'https://www.netflix.com/';
const NF_ORIGIN = 'https://www.netflix.com/*';
const NF_HOOK_ID = 'ytlearn-netflix-hook';
const NF_OVERLAY_ID = 'ytlearn-netflix-overlay';
const NF_SCRIPTS = [
  { id: NF_HOOK_ID, js: ['netflix-manifest.js', 'netflix-hook.js'], matches: [NF_ORIGIN], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true },
  { id: NF_OVERLAY_ID, js: ['overlay.js'], matches: [NF_ORIGIN], runAt: 'document_idle', world: 'ISOLATED', allFrames: false, persistAcrossSessions: true },
];
const NF_SCRIPT_KEYS = ['js', 'matches', 'runAt', 'world', 'allFrames', 'persistAcrossSessions'];
// Isolated world, both phases. TODO(step 4): 'ttml.js' goes between netflix-manifest.js and netflix-capture.js.
const NF_CAPTURE = { files: ['netflix-manifest.js', 'netflix-capture.js'], world: 'ISOLATED', fn: 'ytLearnNetflixCapture' };
const NF_ID_RE = /^netflix\.[0-9]{1,12}$/; // TODO(step 3): use ytLearnParseLessonId / ytLearnLessonSource
const NF_WATCH_RE = /^https:\/\/www\.netflix\.com\/watch\/([0-9]{1,12})\/?(?:[?#]\S*)?$/;
const NF_ENABLE_PAGE = 'netflix-enable.html';

let nfQueue = Promise.resolve();

function nfEnqueue(fn) {
  const run = nfQueue.then(fn);
  nfQueue = run.catch(() => { });
  return run;
}

function isNetflixId(id) {
  return typeof id === 'string' && NF_ID_RE.test(id.trim());
}

function netflixMovieIdOfUrl(url) {
  const m = typeof url === 'string' ? NF_WATCH_RE.exec(url) : null;
  return m ? m[1] : null;
}

async function readNetflix() {
  const got = await chrome.storage.local.get('netflix');
  const n = got && got.netflix;
  const o = n && typeof n === 'object' ? n : {};
  return { desired: o.desired === true, gen: Number.isSafeInteger(o.gen) && o.gen >= 0 ? o.gen : 0, cleanup: o.cleanup === true };
}

async function writeNetflix(s) {
  await chrome.storage.local.set({ netflix: { desired: s.desired, gen: s.gen, cleanup: s.cleanup } });
}

async function hasNetflixPermission() {
  try {
    return (await chrome.permissions.contains({ origins: [NF_ORIGIN] })) === true;
  } catch (e) {
    log('netflix:contains-failed', errMsg(e));
    return false;
  }
}

// Chrome may omit fields left at their default when it reports a registration; compare with defaults filled in.
const NF_SCRIPT_DEFAULTS = { runAt: 'document_idle', world: 'ISOLATED', allFrames: false, persistAcrossSessions: true };

function sameScript(got, want) {
  const val = (o, k) => (o[k] === undefined ? NF_SCRIPT_DEFAULTS[k] : o[k]);
  return NF_SCRIPT_KEYS.every((k) => JSON.stringify(val(got, k)) === JSON.stringify(val(want, k)));
}

// Both scripts registered with exactly NF_SCRIPTS' settings; a mismatch is unregistered and registered again.
// Set when a re-registration did not make Chrome report the wanted config: from then on (this worker's
// lifetime) a mismatching-but-present registration is left alone, so reconciles never loop through
// unregister/register (each round leaves a document_start gap).
let nfReregisterStuck = false;

async function ensureNetflixRegistered() {
  const ids = NF_SCRIPTS.map((s) => s.id);
  const want = new Map(NF_SCRIPTS.map((s) => [s.id, s]));
  const mismatched = (list) => list.filter((g) => want.has(g.id) && !sameScript(g, want.get(g.id))).map((g) => g.id);
  const got = await chrome.scripting.getRegisteredContentScripts({ ids });
  const wrong = nfReregisterStuck ? [] : mismatched(got);
  if (wrong.length) {
    log('netflix:reregister', JSON.stringify(wrong));
    await chrome.scripting.unregisterContentScripts({ ids: wrong });
  }
  const ok = new Set(got.map((g) => g.id).filter((id) => !wrong.includes(id)));
  const missing = NF_SCRIPTS.filter((s) => !ok.has(s.id));
  if (missing.length) {
    await chrome.scripting.registerContentScripts(missing.map((s) => ({ ...s, js: s.js.slice(), matches: s.matches.slice() })));
    log('netflix:registered', JSON.stringify(missing.map((s) => s.id)));
  }
  if (wrong.length) {
    const still = mismatched(await chrome.scripting.getRegisteredContentScripts({ ids }));
    if (still.length) {
      nfReregisterStuck = true;
      log('netflix:reregister-stuck', JSON.stringify(still));
    }
  }
}

async function ensureNetflixUnregistered() {
  const got = await chrome.scripting.getRegisteredContentScripts({ ids: NF_SCRIPTS.map((s) => s.id) });
  if (got.length) {
    await chrome.scripting.unregisterContentScripts({ ids: got.map((g) => g.id) });
    log('netflix:unregistered', JSON.stringify(got.map((g) => g.id)));
  }
}

function setNetflixMenu(checked) {
  try {
    chrome.contextMenus.update(NF_MENU.id, { checked }, () => { void chrome.runtime.lastError; });
  } catch (e) {
    log('menu:update-failed', errMsg(e));
  }
}

// Tell the overlays to stand down. With the site permission, only Netflix tabs; without it (revoked from
// chrome://extensions) every tab — overlays on other sites ignore it (site:'netflix'). Errors per tab ignored.
async function broadcastNetflixOff(perm) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query(perm ? { url: NF_ORIGIN } : {});
  } catch (e) {
    log('netflix:off-query-failed', errMsg(e));
  }
  const msg = { type: 'ytlearn:site-off', site: 'netflix' };
  await Promise.all((tabs || []).filter((t) => t && typeof t.id === 'number')
    .map((t) => chrome.tabs.sendMessage(t.id, msg).catch(() => { })));
  log('netflix:site-off', (tabs || []).length, 'tabs');
}

// -> {enabled, desired, permission, registered}. Not queued: callers are queue tasks.
async function reconcileInner() {
  let s = await readNetflix();
  const perm = await hasNetflixPermission();
  if (s.desired && !perm) {
    // Permission taken away outside the extension: same path as a disable, minus permissions.remove.
    s = { desired: false, gen: s.gen + 1, cleanup: true };
    await writeNetflix(s);
    log('netflix:permission-gone', s.gen);
  }
  if (s.desired) {
    let registered = false;
    try {
      await ensureNetflixRegistered();
      registered = true;
    } catch (e) {
      // Intent kept: the next reconcile retries; entry points refuse while unregistered.
      log('netflix:register-failed', errMsg(e));
    }
    setNetflixMenu(registered);
    return { enabled: registered, desired: true, permission: true, registered };
  }
  // !desired: never permissions.remove here (only an explicit disable revokes).
  if (s.cleanup) await broadcastNetflixOff(perm);
  try {
    await ensureNetflixUnregistered();
    if (s.cleanup) await writeNetflix({ desired: false, gen: s.gen, cleanup: false });
  } catch (e) {
    log('netflix:unregister-failed', errMsg(e));
  }
  setNetflixMenu(false);
  return { enabled: false, desired: false, permission: perm, registered: false };
}

function reconcileNetflix() {
  return nfEnqueue(reconcileInner);
}

// Entry-point check: reconcile first, then "desired && permission && registered".
async function netflixEnabled() {
  const st = await reconcileNetflix();
  return st.enabled === true;
}

// Queued. desired:true needs the permission already granted (the caller asked for it in its user gesture).
function setNetflix(desired, reloadTabId) {
  if (!desired) return nfEnqueue(disableNetflixInner);
  return nfEnqueue(async () => {
    if (!(await hasNetflixPermission())) return { ok: false, error: 'needPermission' };
    const s = await readNetflix();
    await writeNetflix({ desired: true, gen: s.gen + 1, cleanup: false });
    const st = await reconcileInner();
    if (!st.registered) return { ok: false, error: '註冊失敗，稍後會自動重試' };
    let reloaded = false;
    if (typeof reloadTabId === 'number') {
      // Only a tab that is (still) on Netflix: the ?tab id may have navigated away or been reused.
      const tab = await chrome.tabs.get(reloadTabId).catch(() => null);
      if (tab && typeof tab.url === 'string' && tab.url.startsWith(NF_HOST)) {
        await chrome.tabs.reload(reloadTabId).then(() => { reloaded = true; }, (e) => log('netflix:reload-failed', errMsg(e)));
      } else {
        log('netflix:reload-skipped', reloadTabId, tab && tab.url);
      }
    }
    log('netflix:enabled', s.gen + 1);
    return { ok: true, reloaded };
  });
}

// (1) intent off + cleanup flag, (2) site-off broadcast, (3) unregister, (4) cleanup done, (5) re-read gen and
// only then revoke the site permission. Killed after any step → the next reconcile resumes from (2).
async function disableNetflixInner() {
  const s0 = await readNetflix();
  const gen = s0.gen + 1;
  await writeNetflix({ desired: false, gen, cleanup: true });
  await broadcastNetflixOff(await hasNetflixPermission());
  let unregistered = false;
  try {
    await ensureNetflixUnregistered();
    unregistered = true;
  } catch (e) {
    log('netflix:unregister-failed', errMsg(e)); // cleanup stays true; reconcile retries
  }
  if (unregistered) await writeNetflix({ desired: false, gen, cleanup: false });
  setNetflixMenu(false);
  const now = await readNetflix();
  if (now.gen === gen) {
    try {
      await chrome.permissions.remove({ origins: [NF_ORIGIN] });
    } catch (e) {
      log('netflix:remove-failed', errMsg(e));
    }
  } else {
    log('netflix:keep-permission', gen, now.gen);
  }
  log('netflix:disabled', gen);
  return { ok: true };
}

// Menu checkbox. permissions.request must be called right here, inside the click's user gesture.
function onNetflixMenu(info) {
  const done = (r) => {
    log('netflix:menu', JSON.stringify(r));
    // Whatever happened, make the checkbox show the real state again.
    return reconcileNetflix();
  };
  const fail = (e) => {
    log('netflix:menu-failed', errMsg(e));
    reconcileNetflix().catch(() => { });
  };
  if (info.checked) {
    let asked;
    try {
      asked = chrome.permissions.request({ origins: [NF_ORIGIN] });
    } catch (e) {
      fail(e);
      return;
    }
    Promise.resolve(asked)
      .then(async (granted) => {
        if (!granted) return { ok: false, error: 'denied' }; // the user said no: nothing to explain
        const r = await setNetflix(true, null);
        // needPermission, registration failure, anything else: the enable page explains and offers a retry
        if (!r || !r.ok) await openNetflixEnablePage(null, '', (r && r.error) || 'unknown');
        return r;
      })
      .then(done).catch(fail);
  } else {
    setNetflix(false).then(done).catch(fail);
  }
}

function openNetflixEnablePage(tabId, hash, reason) {
  const q = [];
  if (typeof tabId === 'number') q.push('tab=' + tabId);
  if (reason) q.push('reason=' + encodeURIComponent(reason));
  const url = chrome.runtime.getURL(NF_ENABLE_PAGE) + (q.length ? '?' + q.join('&') : '') + (hash || '');
  return chrome.tabs.create({ url, active: true });
}

async function onNetflixIcon(tab) {
  if (!(await netflixEnabled())) {
    log('icon:netflix-off', tab.id);
    await openNetflixEnablePage(tab.id);
    return;
  }
  // TODO(step 5): ask the overlay first; TODO(step 4): /add → capture instead of the probe.
  await chrome.storage.session.set({ netflixProbe: { state: 'running', tabId: tab.id, at: Date.now() } });
  await openNetflixEnablePage(tab.id, '#probe');
  await runNetflixProbe(tab.id);
}

// Diagnostic probe in a Netflix watch tab. Result (or error) lands in storage.session.netflixProbe, where the
// enable page's #probe view reads it. Not on nfQueue; discarded if the user switched Netflix meanwhile.
async function runNetflixProbe(tabId) {
  const started = await readNetflix();
  const save = async (r) => {
    const rec = { state: 'done', tabId, at: Date.now(), ...r };
    await chrome.storage.session.set({ netflixProbe: rec });
    return r;
  };
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return save({ ok: false, error: TAB_CLOSED });
  }
  const movieId = netflixMovieIdOfUrl(tab && tab.url);
  if (!movieId) return save({ ok: false, error: '這個分頁不是 Netflix 播放頁' });
  log('netflix:probe', tabId, movieId);
  try {
    const result = await injectCapture(tabId, { probe: true, expectLessonId: 'netflix.' + movieId, timeoutMs: CAPTURE_TIMEOUT_MS }, NF_CAPTURE);
    if ((await readNetflix()).gen !== started.gen) return save({ ok: false, error: NETFLIX_OFF });
    log('netflix:probe-result', JSON.stringify(result));
    return save({ ok: true, url: tab.url, result });
  } catch (e) {
    log('netflix:probe-failed', errMsg(e));
    return save({ ok: false, url: tab.url, error: errMsg(e) });
  }
}

// Messages from extension/netflix-enable.html only (an extension page: it has chrome.permissions).
function onEnablePageMessage(msg, sender, sendResponse) {
  const page = chrome.runtime.getURL(NF_ENABLE_PAGE);
  if (typeof sender.url !== 'string' || !sender.url.startsWith(page)) {
    log('netflix:rejected', msg.type, sender.url);
    return false;
  }
  const reply = (p) => {
    p.then(sendResponse, (e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  };
  const tabId = Number.isSafeInteger(msg.tab) && msg.tab >= 0 ? msg.tab : null;
  if (msg.type === 'ytlearn:netflix-state') return reply(reconcileNetflix());
  if (msg.type === 'ytlearn:netflix-set') {
    if (typeof msg.desired !== 'boolean') {
      sendResponse({ ok: false, error: 'desired 必須是 true 或 false' });
      return false;
    }
    return reply(setNetflix(msg.desired, tabId));
  }
  if (msg.type === 'ytlearn:netflix-probe') {
    if (tabId === null) {
      sendResponse({ ok: false, error: '沒有指定分頁' });
      return false;
    }
    return reply(netflixEnabled().then(async (on) => {
      if (!on) return { disabled: true };
      await chrome.storage.session.set({ netflixProbe: { state: 'running', tabId, at: Date.now() } });
      return runNetflixProbe(tabId);
    }));
  }
  return false;
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

// Last line on purpose: everything it uses (nfQueue, NF_*) is initialised by now. Runs on every worker start.
reconcileNetflix().catch((e) => log('netflix:reconcile-failed', errMsg(e)));
