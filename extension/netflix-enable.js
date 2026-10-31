/* extension/netflix-enable.html: the Netflix opt-in page (an extension page, so it has chrome.permissions).
   ?tab=<id>: the Netflix watch tab the user came from (reloaded after enabling; the target of 診斷).
   #probe: show the last diagnostic (storage.session.netflixProbe, written by the worker).
   permissions.request is called directly inside the button's click handler (user gesture).
   DOM text only via textContent / createElement (no HTML-string sinks). */
(() => {
  const ORIGIN = 'https://www.netflix.com/*';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const tabParam = Number(params.get('tab'));
  const tabId = Number.isSafeInteger(tabParam) && tabParam >= 0 && params.get('tab') !== null ? tabParam : null;
  const status = $('status');
  const enableBtn = $('enable');
  const probeBtn = $('probe-btn');

  const say = (text) => { status.textContent = text; };
  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(reply || { ok: false, error: '擴充功能沒有回應' });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });

  $('tab-note').textContent = tabId === null
    ? '沒有指定分頁：請從 Netflix 播放頁按工具列圖示打開這一頁，「診斷」與自動重新載入才有對象。'
    : '對象分頁：#' + tabId;
  if (tabId === null) probeBtn.disabled = true;
  enableBtn.textContent = tabId === null ? '啟用' : '啟用並重新載入這個分頁';

  function showState(st) {
    if (!st || st.error) { say('讀不到目前狀態：' + ((st && st.error) || '未知')); return; }
    if (st.enabled) say('目前狀態：已啟用。');
    else if (st.desired) say('目前狀態：已授權，但鉤子註冊失敗，稍後會自動重試。');
    else say('目前狀態：未啟用。');
    enableBtn.hidden = !!st.enabled;
  }

  // Must stay synchronous up to permissions.request: the click is the user gesture.
  enableBtn.addEventListener('click', () => {
    enableBtn.disabled = true;
    let asked;
    try {
      asked = chrome.permissions.request({ origins: [ORIGIN] });
    } catch (e) {
      say('無法要求權限：' + String((e && e.message) || e));
      enableBtn.disabled = false;
      return;
    }
    Promise.resolve(asked).then(async (granted) => {
      if (!granted) {
        say('你沒有授權 Netflix 的網站權限，所以沒有啟用。要啟用請再按一次並選「允許」。');
        return;
      }
      say('已授權，正在啟用…');
      const r = await send({ type: 'ytlearn:netflix-set', desired: true, tab: tabId === null ? undefined : tabId });
      if (r && r.ok) {
        say(tabId === null ? '已啟用。請重新整理 Netflix 播放頁。' : '已啟用，分頁已重新載入。這一頁即將關閉。');
        enableBtn.hidden = true;
        if (tabId !== null) setTimeout(() => window.close(), 1500);
      } else if (r && r.error === 'needPermission') {
        say('權限剛剛被收回了（可能是關閉還在進行中），請再按一次啟用。');
      } else {
        say('啟用失敗：' + ((r && r.error) || '未知'));
      }
    }).catch((e) => say('啟用失敗：' + String((e && e.message) || e)))
      .finally(() => { enableBtn.disabled = false; });
  });

  probeBtn.addEventListener('click', async () => {
    if (tabId === null) return;
    probeBtn.disabled = true;
    showProbeView();
    renderProbe({ state: 'running', tabId, at: Date.now() });
    const r = await send({ type: 'ytlearn:netflix-probe', tab: tabId });
    probeBtn.disabled = false;
    if (r && r.disabled) renderProbe({ state: 'done', ok: false, tabId, at: Date.now(), error: 'Netflix 尚未啟用' });
    else if (r && r.ok === false && !('result' in r) && r.error) renderProbe({ state: 'done', ok: false, tabId, at: Date.now(), error: r.error });
    // success: the worker wrote storage.session.netflixProbe; onChanged renders it
  });

  /* ---------- #probe view ---------- */

  function showProbeView() {
    $('probe-view').hidden = false;
  }

  const yes = (b) => (b ? '✓' : '✗');

  function summaryLines(res) {
    const lines = [];
    const h = res.hook || {};
    lines.push(yes(h.summarized >= 1) + ' 鉤子摘要到 manifest：summarized = ' + h.summarized + '（parsed ' + h.parsed + '、suspected ' + h.suspected
      + '、unknownShape ' + h.unknownShape + '）');
    lines.push(yes(h.skippedReviver === 0) + ' 帶 reviver 的 JSON.parse：skippedReviver = ' + h.skippedReviver);
    lines.push('片名：' + (res.title || '（無）') + (res.show ? ' — ' + res.show : '') + '　movieId ' + res.movieId);
    const en = (res.tracks || []).filter((t) => /^en([_-]|$)/i.test(t.lang));
    lines.push(yes(en.length > 0) + ' 英文軌：' + (en.map((t) => t.lang + ' ' + t.type + (t.forced ? '（forced）' : '') + ' [' + t.formats.join(', ') + ']').join('；') || '（無）'));
    const f = res.enFetch || {};
    if (f.error) lines.push('✗ 抓英文字幕檔：' + f.error);
    else lines.push(yes(f.status === 200 && /<tt[\s>]/.test(f.head || '')) + ' 抓英文字幕檔（' + f.format + '）：HTTP ' + f.status + '、' + f.bytes + ' bytes、開頭「' + f.head + '」');
    const s = res.seek || {};
    lines.push(yes(s.ok) + ' seek（ms = ' + s.ms + '，play:false）：' + (s.ok ? 'ok（請確認畫面沒有出現 M7375 錯誤）' : s.error));
    return lines;
  }

  function renderProbe(rec) {
    const out = $('probe-out');
    if (!rec) { out.textContent = '還沒有診斷結果。'; return; }
    const when = new Date(rec.at || Date.now()).toLocaleString();
    if (rec.state === 'running') { out.textContent = '診斷中…（分頁 #' + rec.tabId + '，' + when + '）'; return; }
    const head = '分頁 #' + rec.tabId + '　' + when + (rec.url ? '\n' + rec.url : '');
    if (!rec.ok) { out.textContent = head + '\n\n✗ ' + rec.error; return; }
    out.textContent = head + '\n\n' + summaryLines(rec.result).join('\n') + '\n\n原始結果：\n' + JSON.stringify(rec.result, null, 2);
  }

  function loadProbe() {
    chrome.storage.session.get('netflixProbe').then((got) => renderProbe(got.netflixProbe), (e) => say('讀不到診斷結果：' + e.message));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.netflixProbe) {
      showProbeView();
      renderProbe(changes.netflixProbe.newValue);
    }
  });

  if (location.hash === '#probe') {
    showProbeView();
    loadProbe();
  }
  send({ type: 'ytlearn:netflix-state' }).then(showState);
})();
