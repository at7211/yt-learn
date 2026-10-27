const SERVER = 'http://127.0.0.1:8765';
const TEST_ID = 'GqD0rhajhr0';
const log = (...a) => console.log('[yt-learn]', ...a);
const waiters = new Map();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const w = waiters.get(tabId);
  if (w && info.status === 'complete' && isYt(tab)) w(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'probe') {
    probe(msg.videoId).then(sendResponse, (e) => sendResponse({ ok: false, stage: 'internal', error: String(e && e.message || e) }));
    return true;
  }
  return false;
});

/* Spike only: let the local yt-learn page (externally_connectable) trigger a probe and receive the result. */
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'probe' && typeof msg.videoId === 'string') {
    probe(msg.videoId).then(sendResponse, (e) => sendResponse({ ok: false, stage: 'internal', error: String(e && e.message || e) }));
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener(() => {
  probe(TEST_ID);
});

(async () => {
  try {
    const got = await chrome.storage.session.get('ownedTabs');
    for (const id of got.ownedTabs || []) {
      await chrome.tabs.remove(id).catch(() => {});
    }
    await chrome.storage.session.set({ ownedTabs: [] });
    log('startup: cleaned stale tabs', got.ownedTabs || []);
  } catch (e) {
    log('startup cleanup failed', String(e && e.message || e));
  }
})();

function isYt(tab) {
  return !!tab && typeof tab.url === 'string' && tab.url.startsWith('https://www.youtube.com/');
}

function waitComplete(tabId, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(tabId);
      reject(new Error('導航逾時'));
    }, ms);
    waiters.set(tabId, (tab) => {
      clearTimeout(timer);
      waiters.delete(tabId);
      resolve(tab);
    });
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete' && isYt(tab)) waiters.get(tabId)?.(tab);
    }, (e) => {
      clearTimeout(timer);
      waiters.delete(tabId);
      reject(e);
    });
  });
}

async function probe(videoId) {
  const t0 = Date.now();
  const ms = { nav: 0, capture: 0, post: 0, total: 0 };
  let tabId = null;
  let stage = 'create';
  const result = { ok: false, stage, ms };
  try {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    tabId = tab.id;
    log('tab created', tabId);
    await chrome.tabs.update(tabId, { muted: true });
    await chrome.storage.session.set({ ownedTabs: [tabId] });
    stage = 'nav';
    await chrome.tabs.update(tabId, { url: 'https://www.youtube.com/watch?v=' + videoId });
    await waitComplete(tabId, 15000);
    ms.nav = Date.now() - t0;
    log('nav complete', ms.nav, 'ms');

    stage = 'capture';
    const t1 = Date.now();
    await chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js'], world: 'MAIN' });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (opts) => ytLearnCapture(opts).then((raw) => ({ ok: true, raw }), (e) => ({ ok: false, error: String(e && e.message || e) })),
      args: [{ expectVideoId: videoId, timeoutMs: 25000 }],
    });
    ms.capture = Date.now() - t1;
    const r = results && results[0] && results[0].result;
    log('capture result', r && r.ok, r && r.error, ms.capture, 'ms');
    if (!r || !r.ok) throw new Error((r && r.error) || '沒有回傳結果');
    result.events = r.raw.events.length;

    stage = 'post';
    const t2 = Date.now();
    const res = await fetch(SERVER + '/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r.raw),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    ms.post = Date.now() - t2;
    result.ingest = { status: res.status, body };
    log('ingest', res.status, body, ms.post, 'ms');
    if (!res.ok) throw new Error('server 回應 ' + res.status);
    result.ok = true;
    stage = 'done';
  } catch (e) {
    result.error = String(e && e.message || e);
    log('probe failed at', stage, result.error);
  } finally {
    if (tabId !== null) {
      await chrome.tabs.remove(tabId).catch(() => {});
      await chrome.storage.session.set({ ownedTabs: [] }).catch(() => {});
    }
    ms.total = Date.now() - t0;
    result.stage = stage;
    log('probe result', JSON.stringify(result));
  }
  return result;
}
