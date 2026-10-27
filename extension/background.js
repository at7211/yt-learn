importScripts('ytid.js');

const SERVER = 'http://127.0.0.1:8765';
const NAV_TIMEOUT_MS = 15000;
const CAPTURE_TIMEOUT_MS = 25000;
const FETCH_TIMEOUT_MS = 5000;
const SERVER_DOWN = '本機 server 沒有回應（請確認 python3 server.py 正在執行）';
const BUSY = '已有一支影片在處理中';
const TAB_CLOSED = '擷取用的分頁已被關閉';

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
  return false;
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg && (msg.type === 'probe' || msg.type === 'ytlearn:capture') && typeof msg.videoId === 'string') {
    const videoId = ytLearnParseVideoId(msg.videoId);
    if (!videoId) {
      sendResponse({ ok: false, error: '無法辨識的影片 id' });
      return false;
    }
    log('external:capture', videoId);
    runJob(videoId, { mode: 'background' }).then(sendResponse, (e) => sendResponse({ ok: false, error: errMsg(e) }));
    return true;
  }
  return false;
});

const startup = cleanupOwnedTabs();

/* ---------- 入口 ---------- */

async function onIconClicked(tab) {
  const url = (tab && tab.url) || '';
  const videoId = ytLearnParseVideoId(url);
  log('icon', url, videoId);
  if (!videoId) {
    await chrome.tabs.create({ url: SERVER + '/index.html', active: true });
    return;
  }
  const pageUrl = SERVER + '/index.html?v=' + videoId;
  let opened = false;
  const openPage = () => {
    if (opened) return;
    opened = true;
    chrome.tabs.create({ url: pageUrl, active: true }).catch((e) => log('icon:open-failed', errMsg(e)));
  };
  const inPlace = url.startsWith('https://www.youtube.com/watch') && typeof tab.id === 'number';
  const result = await runJob(videoId, inPlace
    ? { mode: 'inplace', tabId: tab.id, onAdded: openPage }
    : { mode: 'background', onAdded: openPage });
  log('icon:result', JSON.stringify(result));
  openPage();
}

async function onPageCapture(videoId, pageTabId) {
  let emitted = false;
  const onStatus = (s) => {
    emitted = true;
    sendStatus(pageTabId, { videoId, ...s });
  };
  const result = await runJob(videoId, { mode: 'background', onStatus });
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

/* ---------- job ---------- */

function runJob(videoId, opts) {
  if (busy) {
    log('busy', videoId);
    return Promise.resolve({ ok: false, error: BUSY });
  }
  busy = runJobInner(videoId, opts || {}).catch((e) => ({ ok: false, error: errMsg(e) })).finally(() => { busy = null; });
  return busy;
}

async function runJobInner(videoId, opts) {
  await startup;
  const mode = opts.mode === 'inplace' ? 'inplace' : 'background';
  const emit = (s) => { try { if (opts.onStatus) opts.onStatus(s); } catch (e) { } };
  const canonical = ytLearnCanonicalUrl(videoId);

  log('add', videoId, mode);
  const add = await api('/add', { method: 'POST', body: { url: canonical } });
  const job = add.json && add.json.job;
  if (add.status !== 200 || !job) return { ok: false, error: '加入工作失敗：' + serverError(add) };
  log('add:job', JSON.stringify(job));
  try { if (opts.onAdded) opts.onAdded(job); } catch (e) { }
  if (job.state === 'done') return { ok: true, done: true, lessonUrl: SERVER + '/index.html?v=' + videoId, job };
  if (job.state !== 'queued') return { ok: true, inProgress: true, job };

  const claim = await api('/jobs/' + videoId + '/claim', { method: 'POST' });
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
      ? await captureInPlace(opts.tabId, videoId)
      : await captureInBackground(videoId, canonical, attempt, ctx);
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

async function captureInPlace(tabId, videoId) {
  if (typeof tabId !== 'number') throw new Error('沒有可擷取的分頁');
  log('capture:inplace', tabId, videoId);
  return injectCapture(tabId, { expectVideoId: videoId, timeoutMs: CAPTURE_TIMEOUT_MS, inPlace: true });
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

async function injectCapture(tabId, args) {
  let results;
  let timer = null;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js'], world: 'MAIN' });
    const run = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (o) => globalThis.ytLearnCapture(o).then(
        (raw) => ({ ok: true, raw }),
        (e) => ({ ok: false, error: String((e && e.message) || e) }),
      ),
      args: [args],
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
  try { json = await res.json(); } catch (e) { }
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
