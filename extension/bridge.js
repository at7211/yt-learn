/* 本機首頁的 content script：頁面 ⇄ worker 的橋。只轉送 ytlearn:ping / ytlearn:capture，回覆與 status 原樣丟回頁面。 */
(() => {
  const ORIGIN = 'http://127.0.0.1:8765';
  const UNREACHABLE = '擴充功能未回應，請重新載入擴充功能與本頁';
  let version = '';
  try { version = chrome.runtime.getManifest().version; } catch (e) { }

  const mark = () => {
    if (!document.documentElement) return false;
    document.documentElement.dataset.ytlearnExt = version;
    return true;
  };
  if (!mark()) document.addEventListener('readystatechange', mark, { once: true });

  const post = (msg) => window.postMessage(msg, ORIGIN);
  const unreachable = (videoId) => post({
    type: 'ytlearn:status',
    videoId: typeof videoId === 'string' ? videoId : undefined,
    state: 'error',
    message: UNREACHABLE,
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('ytlearn:')) return;
    let msg;
    if (data.type === 'ytlearn:ping') msg = { type: 'ytlearn:ping' };
    else if (data.type === 'ytlearn:capture') msg = { type: 'ytlearn:capture', videoId: typeof data.videoId === 'string' ? data.videoId : '' };
    else return;
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        if (chrome.runtime.lastError || !reply) {
          unreachable(msg.videoId);
          return;
        }
        post(reply);
      });
    } catch (e) {
      unreachable(msg.videoId);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ytlearn:status') post(msg);
    return false;
  });
})();
