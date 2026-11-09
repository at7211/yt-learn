// yt-learn player. Sections: util, home, load, player, render subtitle,
// render panel, review, lists, controls & keyboard, boot.
import { cueIndexAt, flattenHits, activeHitAt, panelState, seenCount } from './timing.js';
import { parseLessonId } from './ytid.js';
import { externalSite, listRowSite, listRowSourceLink, canBuildHere } from './lesson-source.js';
import { waitForAck, shouldApplyLiveStatus } from './handshake.js';
import { introRows } from './intro.js';
import { dictWord, dictUrl, clickWord } from './dict.js';
import { barState, costText } from './progress.js';
import { DEFAULTS, EFFORTS, PRESETS, PROVIDERS, normalize, presetOf, summary, shortModel, modelsFor, fmtUsd, budgetText, parseBudget } from './settings.js';

// ---------------------------------------------------------------- util
const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
const PANEL_LEAD = 1.0; // seconds before the first vocab word that the panel fades in
const INTRO_SECONDS = 10; // how long the 前情提要 card stays after the first play
const HINT_SECONDS = 8; // how long the shortcut strip at the top stays after the first play
const PER_PAGE = 18; // review: 3 columns × 6 rows

const S = {
  lesson: null,
  flat: [],
  vocabById: new Map(),
  player: null,
  ready: false,
  t: 0,
  showZh: true,
  showEn: true,
  showVocab: true,
  showShade: true,
  started: false, // true after the first PLAYING; subtitles and the panel stay hidden until then
  review: false,
  page: 0,
  keys: { sub: null, panel: null, cue: null, count: null },
};

// ---------------------------------------------------------------- home (no ?v)
function initHome(showList) {
  $('home').hidden = false;
  $('lesson-list').hidden = !showList;
  $('settings').hidden = !showList; // settings live on the real home page only, not under 「尚未產課」
  const result = $('result');
  const show = (nodes) => result.replaceChildren(...nodes);
  $('url-form').onsubmit = (e) => {
    e.preventDefault();
    const err = $('url-err');
    const id = parseLessonId($('url-input').value);
    if (!id) { err.textContent = '無法辨識的 YouTube、Udemy、Netflix 或 HelloInterview 網址'; err.hidden = false; return; }
    const site = externalSite(id);
    if (site) { err.textContent = site.buildMsg; err.hidden = false; return; } // a pasted Udemy/Netflix/HelloInterview URL is never submitted
    err.hidden = true;
    startJob(id, $('card-home'));
  };
  $('go').onclick = async () => {
    const text = $('import').value.trim();
    if (!text) { show([el('p', '請先貼上 JSON。', 'err')]); return; }
    try {
      const res = await fetch('/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      const out = await res.json();
      if (out.ok) {
        if (out.job) {
          show([el('p', '已匯入 ' + out.videoId + '（' + out.events + ' 個事件）。')]);
          showJob(out.job, $('card-home'));
        } else {
          show([el('p', '已匯入 ' + out.videoId + '（' + out.events + ' 個事件）。請在終端機執行：'),
                el('pre', out.next), el('p', '產課完成後重新整理此頁。')]);
        }
      } else {
        show([el('p', '匯入失敗：', 'err'), ...(out.errors || ['未知錯誤']).map((m) => el('p', m, 'err'))]);
      }
    } catch (e) {
      show([el('p', '無法連線到 server：' + e.message, 'err')]);
    }
  };
  if (showList) {
    const listed = loadLessonList();
    initSettings(listed);
  }
}

// ---------------------------------------------------------------- settings (home only)
const EFFORT_TEXT = { default: '預設（不指定）' };
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
const VENDOR_NAME = { anthropic: 'Anthropic', openai: 'OpenAI' };
const PRESET_PROVIDERS = ['claude-cli', 'anthropic-api']; // the presets name Claude models
const SOURCE_NOTE = {
  'claude-cli': '用本機已登入的 claude 指令產課，走訂閱額度。',
  'codex-cli': '用本機已登入的 codex 指令產課，走訂閱額度：模型照 Codex 自己的設定，effort 最高到 high。',
  'anthropic-api': '直接呼叫 Anthropic API，依 token 計費。測試連線後模型清單會多出帳號可用的其他 Claude 模型。',
  'openai-api': '直接呼叫 OpenAI API，依 token 計費。要先測試連線取得模型清單，才能選模型。',
};
// What the page knows besides the form: masked keys and cached model lists from GET /settings, and
// the last settings the server accepted (null until it answers).
const SET = { keys: {}, models: {}, saved: null, changingKey: false };

// A 「無法儲存：…」 from an earlier save no longer applies once the source or the key changed;
// a settings-file warning from GET /settings stays.
function clearSaveError() {
  const w = $('set-warning');
  if (w.textContent.startsWith('無法儲存')) { w.textContent = ''; w.hidden = true; }
}

function currentProvider() {
  const r = document.querySelector('#set-providers input[name="provider"]:checked');
  return r ? r.value : DEFAULTS.provider;
}

function readBudget() {
  const input = $('set-budget');
  return parseBudget(input.value, Boolean(input.validity && input.validity.badInput));
}

function readSettingsForm() {
  const budget = readBudget();
  return { provider: currentProvider(), model: $('set-model').value, effort: $('set-effort').value,
           workers: Number($('set-workers').value), budgetUsd: budget.error ? NaN : budget.value };
}

// The model <select> for `provider`, selecting `model`. codex-cli keeps the stored model as the one
// (disabled) option so it round-trips unchanged; an API source with no list says to test first.
function fillModelOptions(provider, model) {
  const sel = $('set-model');
  const opt = (value, text) => { const o = el('option', text); o.value = value; return o; };
  const list = modelsFor(provider, SET.models);
  if (provider === 'codex-cli') {
    sel.replaceChildren(opt(model || DEFAULTS.model, '照 Codex 自己的設定'));
  } else if (!list.length) {
    sel.replaceChildren(opt('', '請先測試連線取得模型清單'));
  } else {
    sel.replaceChildren(...list.map((m) => opt(m, shortModel(m))));
  }
  sel.value = sel.options[0].value;
  if ([...sel.options].some((o) => o.value === model)) sel.value = model;
  sel.disabled = provider === 'codex-cli' || !list.length;
}

function fillSettingsForm(s) {
  for (const r of document.querySelectorAll('#set-providers input[name="provider"]')) r.checked = r.value === s.provider;
  fillModelOptions(s.provider, s.model);
  $('set-effort').value = s.effort;
  $('set-workers').value = String(s.workers);
  $('set-budget').value = s.budgetUsd == null ? '' : String(s.budgetUsd);
  renderSource();
}

// Switching source: Claude sources keep a model they accept (else the default), OpenAI takes the
// first listed model, Codex leaves it alone.
function switchProvider(next) {
  const prev = $('set-model').value || DEFAULTS.model;
  let model = prev;
  if (next === 'openai-api') model = modelsFor(next, SET.models)[0] || '';
  else if (next !== 'codex-cli' && !modelsFor(next, SET.models).includes(prev)) model = DEFAULTS.model;
  SET.changingKey = false;
  $('key-input').value = '';
  $('key-result').textContent = '';
  clearSaveError();
  fillModelOptions(next, model);
  renderSource();
}

function markPreset() {
  const usable = PRESET_PROVIDERS.includes(currentProvider());
  const p = usable ? presetOf(readSettingsForm()) : null;
  for (const b of document.querySelectorAll('#settings [data-preset]')) {
    b.disabled = !usable;
    b.setAttribute('aria-pressed', String(b.dataset.preset === p));
  }
  $('preset-note').textContent = !usable ? '預設組合指定 Claude 模型，只在 Claude CLI／Anthropic API 下可用'
    : p ? PRESETS[p].note : '自訂組合';
}

function renderSource() {
  const provider = currentProvider();
  $('source-note').textContent = SOURCE_NOTE[provider] + ' 併行數越大切句越快，同時送出的請求也越多。';
  const vendor = PROVIDERS[provider].key;
  $('keybox').hidden = !vendor;
  if (vendor) renderKeybox(vendor);
  markPreset();
}

// The key box only ever sees { set, tail, source }: the full key never comes back from the server.
function renderKeybox(vendor) {
  const k = SET.keys[vendor] || { set: false, tail: null, source: null };
  const env = KEY_ENV[vendor];
  const status = $('key-status');
  if (k.set) {
    status.textContent = '已設定 ••••' + k.tail + '（' + (k.source === 'env' ? '環境變數 ' + env : '檔案') + '）';
    status.className = 'key-status';
  } else {
    status.textContent = '尚未設定 ' + VENDOR_NAME[vendor] + ' API key';
    status.className = 'key-status unset';
  }
  const editing = !k.set || SET.changingKey;
  $('key-row').hidden = !editing;
  $('key-input').placeholder = k.set ? '貼上新的 ' + VENDOR_NAME[vendor] + ' API key' : '貼上 ' + VENDOR_NAME[vendor] + ' API key';
  $('key-change').hidden = !k.set || SET.changingKey;
  $('key-remove').hidden = !(k.set && k.source === 'file');
  let hint;
  if (!k.set) hint = '貼上 key 後按「測試連線」：成功會立刻存到本機 data/keys.json，不用另外按儲存。也可以改用環境變數 ' + env + '。';
  else if (k.source === 'env') hint = '這把 key 來自環境變數 ' + env + '，要移除請改環境變數。按「更換」貼上新的 key 測試成功後，會存進 data/keys.json 並優先使用。';
  else hint = 'key 只存在本機 data/keys.json，頁面只拿得到最後四碼。';
  $('key-hint').textContent = hint;
}

function keyResult(text, kind) {
  const r = $('key-result');
  r.textContent = text;
  r.className = 'meta' + (kind ? ' ' + kind : '');
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let out;
  try { out = await res.json(); } catch (e) { throw new BadResponse(); }
  return { res, out };
}

function keyButtons(disabled) {
  for (const id of ['key-test', 'key-change', 'key-remove']) $(id).disabled = disabled;
}

async function testKey() {
  const vendor = PROVIDERS[currentProvider()].key;
  if (!vendor) return;
  const pasted = $('key-input').value.trim();
  keyResult('測試中…');
  keyButtons(true);
  try {
    const { res, out } = await postJson('/keys/test', pasted ? { provider: vendor, key: pasted } : { provider: vendor });
    if (!res.ok || !out.ok) { keyResult(out.error || '測試失敗', 'bad'); return; }
    $('key-input').value = '';
    SET.changingKey = false;
    if (out.keys) SET.keys = out.keys;
    SET.models = { ...SET.models, [vendor]: out.models || [] };
    const model = $('set-model').value;
    const list = modelsFor(currentProvider(), SET.models);
    fillModelOptions(currentProvider(), list.includes(model) ? model : (currentProvider() === 'openai-api' ? list[0] : DEFAULTS.model));
    renderSource();
    clearSaveError();
    keyResult('連線成功' + (pasted ? '，key 已存到本機' : '') + '；取得 ' + (out.models || []).length + ' 個模型。', 'ok');
  } catch (e) {
    keyResult(e instanceof BadResponse ? BAD_RESPONSE : UNREACHABLE, 'bad');
  } finally {
    keyButtons(false);
  }
}

async function removeKey() {
  const vendor = PROVIDERS[currentProvider()].key;
  if (!vendor || !window.confirm('移除本機儲存的 ' + VENDOR_NAME[vendor] + ' API key？')) return;
  keyButtons(true);
  try {
    const { res, out } = await postJson('/keys', { [vendor]: '' });
    if (!res.ok || !out.ok) { keyResult((out.errors && out.errors.join('；')) || '無法移除', 'bad'); return; }
    SET.keys = out.keys || SET.keys;
    SET.changingKey = false;
    renderSource();
    const still = SET.keys[vendor] && SET.keys[vendor].set;
    const inUse = SET.saved && PROVIDERS[SET.saved.provider] && PROVIDERS[SET.saved.provider].key === vendor;
    keyResult('已移除' + (still ? '，現在改用環境變數 ' + KEY_ENV[vendor] + ' 的 key。'
      : inUse ? '。目前儲存的來源仍是 ' + PROVIDERS[SET.saved.provider].short + '，產課前請貼上新的 key 或換來源。' : '。'), still || !inUse ? 'ok' : 'bad');
  } catch (e) {
    keyResult(e instanceof BadResponse ? BAD_RESPONSE : UNREACHABLE, 'bad');
  } finally {
    keyButtons(false);
  }
}

// #usage-line: this month's API spend against the budget (GET /usage). Shown on the real home page only.
async function loadUsage() {
  const box = $('usage');
  if ($('settings').hidden) { box.hidden = true; return; }
  try {
    const u = await (await fetch('/usage')).json();
    if (typeof u.apiUsd !== 'number') throw new BadResponse();
    const line = $('usage-line');
    line.textContent = budgetText(u);
    if (u.budgetState === 'warn' || u.budgetState === 'over') {
      line.append(el('span', '・已用 ' + u.pct + '%' + (u.budgetState === 'over' ? '，新的產課要按「這次仍要跑」' : ''), 'usage-pct'));
    }
    line.className = 'usage-line' + (u.budgetState === 'warn' || u.budgetState === 'over' ? ' ' + u.budgetState : '');
    let cli = $('usage-cli');
    if (typeof u.cliUsd === 'number' && u.cliUsd > 0) {
      if (!cli) { cli = el('p', null, 'meta usage-cli'); cli.id = 'usage-cli'; line.after(cli); }
      cli.textContent = 'CLI 等值' + fmtUsd(u.cliUsd) + '（訂閱額度，不計入上限）';
    } else if (cli) cli.remove();
    box.hidden = false;
  } catch (e) {
    box.hidden = true; // the usage line is informative; the settings form reports connection problems
  }
}

function initSettings(listed) {
  const box = $('settings');
  const result = $('set-result');
  const warn = (text) => { $('set-warning').textContent = text || ''; $('set-warning').hidden = !text; };
  const dirty = () => { result.textContent = '尚未儲存'; };
  if (!$('set-effort').options.length) {
    $('set-effort').append(...EFFORTS.map((x) => { const o = el('option', EFFORT_TEXT[x] || x); o.value = x; return o; }));
    $('set-providers').append(...Object.entries(PROVIDERS).map(([value, p]) => {
      const label = el('label');
      const r = el('input');
      r.type = 'radio';
      r.name = 'provider';
      r.value = value;
      r.onchange = () => { switchProvider(value); dirty(); };
      label.append(r, el('span', p.label));
      return label;
    }));
  }
  for (const b of box.querySelectorAll('[data-preset]')) {
    b.onclick = () => {
      const p = PRESETS[b.dataset.preset].settings;
      fillModelOptions(currentProvider(), p.model);
      $('set-effort').value = p.effort;
      $('set-workers').value = String(p.workers);
      markPreset();
      dirty();
    };
  }
  for (const id of ['set-model', 'set-effort', 'set-workers', 'set-budget']) {
    $(id).oninput = () => { markPreset(); dirty(); };
  }
  $('key-test').onclick = testKey;
  $('key-remove').onclick = removeKey;
  $('key-change').onclick = () => { SET.changingKey = true; renderSource(); $('key-input').focus(); };
  $('key-input').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); testKey(); } };
  $('set-save').onclick = async () => {
    const budget = readBudget();
    if (budget.error) { result.textContent = ''; warn('無法儲存：' + budget.error); return; }
    const { settings, errors } = normalize(readSettingsForm(), SET.models);
    if (errors.length) { result.textContent = ''; warn('無法儲存：' + errors.join('；')); return; }
    result.textContent = '儲存中…';
    try {
      const { res, out } = await postJson('/settings', settings);
      if (!res.ok || !out.ok) {
        result.textContent = '';
        warn('無法儲存：' + ((out.errors && out.errors.join('；')) || '未知錯誤'));
        return;
      }
      warn('');
      SET.saved = out.settings;
      fillSettingsForm(out.settings);
      $('settings-summary').textContent = summary(out.settings);
      result.textContent = '已儲存，之後開始的產課會用這組設定。';
      loadUsage();
    } catch (e) {
      result.textContent = '';
      warn(e instanceof BadResponse ? BAD_RESPONSE : UNREACHABLE);
    }
  };
  fillSettingsForm(DEFAULTS); // until the server answers, never show a stray first option
  fetch('/settings').then(async (res) => {
    const out = await res.json();
    if (!out.settings) throw new BadResponse();
    SET.keys = out.keys || {};
    SET.models = out.models || {};
    SET.saved = out.settings;
    fillSettingsForm(out.settings);
    $('settings-summary').textContent = summary(out.settings);
    warn(out.warning ? '設定檔有問題，暫用預設值：' + out.warning : '');
  }).catch(() => warn('讀不到目前的設定（' + UNREACHABLE + '）'));
  loadUsage();
  openSettingsFromHash(listed);
  window.addEventListener('hashchange', () => openSettingsFromHash());
}

// index.html#settings (the extension icon's 「設定」 menu item) opens the section and scrolls to it;
// once more after the lesson list above it has loaded, since that moves it down.
function openSettingsFromHash(listed) {
  if (location.hash !== '#settings') return;
  const box = $('settings');
  box.open = true;
  const go = () => box.scrollIntoView({ block: 'start' });
  go();
  if (listed) listed.finally(go);
}

// ---------------------------------------------------------------- progress card
const PAGE_ORIGIN = location.origin; // targetOrigin for the extension bridge and the message guard
const POLL_MS = 2000;
const ACK_MS = 3000;
const STATE_TEXT = {
  queued: '等待擴充功能…',
  capturing: '正在背景開啟影片擷取字幕…',
  captured: '正在翻譯與挑選單字（約 1–3 分鐘）…',
  building: '正在翻譯與挑選單字（約 1–3 分鐘）…',
  done: '完成',
};
const STEP_NAMES = ['擷取字幕', '產生課程', '完成'];
const BAD_RESPONSE = '本機 server 回應異常';
const UNREACHABLE = '無法連線到本機 server，請確認 python3 server.py 正在執行';
const stepOf = (state) => ({ queued: 0, capturing: 0, captured: 1, building: 1, done: 2 })[state];

// One card at a time. `gen` invalidates timers/handshakes of a replaced card.
let CARD = null;
let genCounter = 0;
const msgHandlers = new Set(); // handshake listeners, fed by the single message listener

function stopCard() {
  if (CARD) { clearInterval(CARD.timer); CARD.timer = null; }
}

function mountCard(container, id, opts = {}) {
  stopCard();
  if (CARD && CARD.container !== container) CARD.container.replaceChildren();
  CARD = { gen: ++genCounter, container, id, job: null, live: null, title: null, ext: 'unknown',
           netText: null, lastStep: 0, lastPct: 0, startedAt: Date.now(), timer: null, polling: false,
           onDone: opts.onDone || null, doneFired: false, endFired: false, budget: null };
  return CARD;
}

class BadResponse extends Error {}
class BudgetBlocked extends Error {} // POST /add said 402 code "budget": the monthly API cap is reached

// `extra` is { override: true } after 「這次仍要跑」 (skips the budget check for this one attempt).
async function postAdd(id, extra = {}) {
  const res = await fetch('/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=' + id, ...extra }) });
  let out;
  try { out = await res.json(); } catch (e) { throw new BadResponse(); }
  if (res.status === 402 && out.code === 'budget') throw new BudgetBlocked(out.error || '本月 API 費用已達上限（本機估算）');
  if (!res.ok || !out.job) throw new Error((out.errors && out.errors.join('；')) || '無法建立工作');
  return out.warning && !out.job.warning ? { ...out.job, warning: out.warning } : out.job;
}

// Create (or re-attach to) the job for `id`, show its card, poll, and ask the extension if queued.
async function startJob(id, container, opts) {
  const card = mountCard(container, id, opts);
  card.live = null;
  if (!canBuildHere(id)) { // external-site lessons are captured on their own page, never from here
    const site = externalSite(id);
    card.job = { videoId: id, state: 'error', message: site ? site.buildMsg : '無法辨識的影片 id' };
    card.noRetry = true;
    renderCard();
    return;
  }
  renderCard();
  let job;
  try {
    job = await postAdd(id, opts && opts.override ? { override: true } : {});
  } catch (e) {
    if (card !== CARD) return;
    if (e instanceof TypeError) card.netText = UNREACHABLE;
    else if (e instanceof BadResponse) card.netText = BAD_RESPONSE;
    else if (e instanceof BudgetBlocked) card.budget = e.message;
    else card.job = { videoId: id, state: 'error', message: e.message };
    renderCard();
    return;
  }
  if (card !== CARD) return;
  applyJob(card, job);
  startPolling(card);
  if (job.state === 'queued') requestCapture(card);
}

// Show a job we did not create through /add (import response, ?v=<id>).
function showJob(job, container, opts) {
  const card = mountCard(container, job.videoId, opts);
  applyJob(card, job);
  startPolling(card);
  return card;
}

function applyJob(card, job) {
  const prev = card.job;
  if (!prev || prev.state !== job.state || prev.updatedAt !== job.updatedAt || prev.attempt !== job.attempt) card.live = null;
  card.job = job;
  card.netText = null;
  const st = stepOf(job.state);
  if (st != null) card.lastStep = st;
  if (job.progress) card.lastPct = barState(job, 0).pct; // kept so an error bar freezes where the build stopped
  if ((job.state === 'done' || job.state === 'error') && !card.endFired) {
    card.endFired = true;
    loadUsage(); // the ledger has this build's line now
  }
  if (job.state === 'done') {
    if (card.title == null) fetchTitle(card);
    if (card.doneFired === false) {
      card.doneFired = true;
      loadLessonList();
      if (card.onDone) setTimeout(() => card.onDone(card.id), 0);
    }
  }
  renderCard();
}

async function fetchTitle(card) {
  card.title = '';
  try {
    const list = await (await fetch('/lessons')).json();
    const hit = list.find((l) => l.videoId === card.id);
    if (hit && hit.title) { card.title = hit.title; if (card === CARD) renderCard(); }
  } catch (e) { /* title is cosmetic */ }
}

function startPolling(card) {
  clearInterval(card.timer);
  if (card.job && (card.job.state === 'done' || card.job.state === 'error')) return;
  card.timer = setInterval(() => pollOnce(card), POLL_MS);
}

async function pollOnce(card) {
  if (card !== CARD || card.polling) return;
  card.polling = true;
  try {
    const res = await fetch('/jobs/' + encodeURIComponent(card.id));
    if (card !== CARD) return;
    if (res.ok) {
      const body = await res.json();
      const job = body.job || body;
      if (card !== CARD) return;
      applyJob(card, job);
      if (job.state === 'done' || job.state === 'error') { clearInterval(card.timer); card.timer = null; }
    } else if (res.status === 404) {
      card.job = { videoId: card.id, state: 'error', message: 'server 已重啟，請重試' };
      clearInterval(card.timer); card.timer = null;
      renderCard();
    }
  } catch (e) {
    if (card === CARD) { card.netText = e instanceof SyntaxError ? BAD_RESPONSE : UNREACHABLE; renderCard(); }
  } finally {
    card.polling = false;
  }
}

async function requestCapture(card) {
  card.ext = 'checking';
  renderCard();
  const ok = await waitForAck({
    post: () => window.postMessage({ type: 'ytlearn:ping' }, PAGE_ORIGIN),
    listen: (h) => { msgHandlers.add(h); return () => msgHandlers.delete(h); },
    timeoutMs: ACK_MS,
  });
  if (card !== CARD) return;
  card.ext = ok ? 'ok' : 'missing';
  if (ok) window.postMessage({ type: 'ytlearn:capture', videoId: card.id }, PAGE_ORIGIN);
  renderCard();
}

function retry(override = false) {
  if (!CARD) return;
  const { id, container, onDone } = CARD;
  startJob(id, container, override ? { onDone, override: true } : { onDone });
}

// The card in place of a job POST /add refused over the monthly budget: no job exists yet.
function budgetCard(card, box) {
  box.append(el('p', card.budget, 'cstate bad'));
  box.append(el('p', '「這次仍要跑」只跳過這一次，不會改上限；要調整上限請到下方設定。', 'meta'));
  const b = el('button', '這次仍要跑', 'primary');
  b.type = 'button';
  b.onclick = () => retry(true);
  const actions = el('p', null, 'actions');
  actions.append(b);
  box.append(actions);
  card.container.replaceChildren(box);
}

function renderCard() {
  const card = CARD;
  if (!card) return;
  const job = card.job;
  const box = el('section', null, 'card');
  const head = el('div', null, 'card-head');
  if (card.title) head.append(el('span', card.title, 'ctitle'));
  head.append(el('code', card.id));
  box.append(head);
  if (card.budget) { budgetCard(card, box); return; }

  const isErr = job && job.state === 'error';
  const cur = job && !isErr ? stepOf(job.state) : (isErr && stepOf(job.failedIn) != null ? stepOf(job.failedIn) : card.lastStep);
  const steps = el('ol', null, 'steps');
  STEP_NAMES.forEach((name, i) => {
    let cls = '';
    if (job && job.state === 'done') cls = 'done';
    else if (isErr && i === cur) cls = 'bad';
    else if (i < cur) cls = 'past';
    else if (i === cur && job) cls = 'cur';
    steps.append(el('li', name, cls));
  });
  box.append(steps);

  const bs = barState(card.netText ? null : job, (Date.now() - card.startedAt) / 1000, card.lastPct);
  const bar = el('div', null, 'bar ' + bs.mode);
  const fill = el('div', null, 'bar-fill');
  if (bs.mode === 'indet') fill.style.animationDelay = (-(Date.now() % 1300)) + 'ms'; // phase survives the redraw
  else fill.style.width = bs.pct + '%';
  bar.append(fill);
  box.append(bar);
  if (bs.label) box.append(el('p', bs.label, 'bar-label'));

  let text, bad = false;
  if (card.netText) { text = card.netText; bad = true; }
  else if (!job) text = '正在建立工作…';
  else if (isErr) { text = '失敗：' + (job.message || '未知錯誤'); bad = true; }
  else if (job.state === 'done') text = STATE_TEXT.done;
  else if (card.live && card.live.state === 'error') { text = card.live.message || '擴充功能回報錯誤'; bad = true; }
  else if (card.live && card.live.message) text = card.live.message;
  else text = STATE_TEXT[job.state] || job.state;
  box.append(el('p', text, 'cstate' + (bad ? ' bad' : '')));
  if (job && !card.netText) {
    const cost = job.state === 'building' ? costText(job.progress) : (job.state === 'done' || isErr) ? costText(job) : '';
    if (cost) box.append(el('p', cost, 'ccost'));
    if (job.warning && job.state !== 'done') box.append(el('p', job.warning, 'cwarn'));
  }

  if (job && job.state === 'done') {
    const actions = el('p', null, 'actions');
    const a = el('a', '開始學習', 'btn primary');
    a.href = job.lessonUrl || 'index.html?v=' + encodeURIComponent(card.id);
    actions.append(a);
    box.append(actions);
  } else if ((isErr || (card.netText && !job)) && !card.noRetry && canBuildHere(card.id)) {
    const b = el('button', '重試');
    b.type = 'button';
    b.onclick = () => retry();
    const actions = el('p', null, 'actions');
    actions.append(b);
    box.append(actions);
  }

  if (card.ext === 'missing' && job && job.state === 'queued' && !card.netText) box.append(noExtBlock());
  card.container.replaceChildren(box);
}

function noExtBlock() {
  const d = el('div', null, 'noext');
  d.append(el('b', '尚未偵測到擴充功能'));
  const ol = document.createElement('ol');
  ['在 Chrome 開啟 chrome://extensions', '右上角開啟「開發人員模式」', '按「載入未封裝項目」', '選擇專案的 extension/ 資料夾', '回到本頁重新整理']
    .forEach((t) => ol.append(el('li', t)));
  d.append(ol);
  d.append(el('p', '或改用書籤小工具擷取字幕，再到下方「手動匯入（備援）」貼上；卡片會自動變成 building → done。', 'hint'));
  return d;
}

// The single window message listener: same window, same origin, ytlearn:* only.
window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== PAGE_ORIGIN) return;
  const data = event.data;
  if (!data || typeof data.type !== 'string' || !data.type.startsWith('ytlearn:')) return;
  if (data.type === 'ytlearn:accepted') return;
  [...msgHandlers].forEach((h) => h(data));
  if (data.type === 'ytlearn:status' && CARD && CARD.job && data.videoId === CARD.id && shouldApplyLiveStatus(CARD.job.state)) {
    CARD.live = { state: data.state, message: data.message };
    renderCard();
  }
});
window.addEventListener('pagehide', stopCard);

async function loadLessonList() {
  markNav(true);
  setScreen('課程', '載入中…', { form: true });
  const lessons = $('lessons');
  const meta = $('screen-meta');
  try {
    const list = await (await fetch('/lessons')).json();
    if (!list.length) {
      if (meta) meta.textContent = '還沒有課程';
      lessons.replaceChildren(el('li', '還沒有課程。貼上第一支影片的網址，擷取字幕後就會出現在這裡。', 'lrow-empty'));
      return;
    }
    const words = list.reduce((n, l) => n + (l.vocabCount || 0), 0);
    if (meta) meta.textContent = list.length + ' 堂課・' + words + ' 個單字';
    lessons.replaceChildren(...list.map((l) => {
      const li = el('li', null, 'lrow');
      const a = el('a', null, 'lrow-link');
      a.href = 'index.html?v=' + encodeURIComponent(l.videoId);
      const text = el('div', null, 'lrow-text');
      text.append(el('div', l.title || l.videoId, 'lrow-title'));
      const sub = [l.channel, l.duration ? fmtTime(l.duration) : null].filter(Boolean).join('・');
      const site = listRowSite(l);
      if (sub || site) {
        const subEl = el('div', null, 'lrow-sub');
        if (site) subEl.append(el('span', site.name, 'lrow-tag'));
        if (sub) subEl.append(sub);
        text.append(subEl);
      }
      a.append(text);
      const hasCost = Object.hasOwn(l, 'costUsd');
      if (l.vocabCount != null || hasCost) {
        const n = el('div', null, 'lrow-num num');
        if (l.vocabCount != null) n.append(el('b', String(l.vocabCount)), el('span', ' 個單字'));
        if (hasCost) {
          const c = el('span', fmtUsd(l.costUsd), 'lrow-cost');
          if (PROVIDERS[l.provider]) c.title = PROVIDERS[l.provider].short;
          n.append(c);
        }
        a.append(n);
      }
      li.append(a);
      const src = listRowSourceLink(l);
      if (src) {
        const sa = el('a', site.linkText + ' ↗', 'lrow-src');
        sa.href = src;
        sa.target = '_blank';
        sa.rel = 'noopener noreferrer';
        li.append(sa);
      }
      return li;
    }));
  } catch (e) {
    if (meta) meta.textContent = '';
    lessons.replaceChildren(el('li', '無法載入課程清單。', 'lrow-empty err'));
  }
}

// ---------------------------------------------------------------- load
async function loadLesson(id) {
  let lesson = null;
  try {
    const res = await fetch('/data/lessons/' + encodeURIComponent(id) + '.json');
    if (res.ok) lesson = await res.json();
  } catch (e) { lesson = null; }
  if (!lesson || !Array.isArray(lesson.words) || !Array.isArray(lesson.cues)) {
    showMissing(id);
    return;
  }
  try {
    setupLesson(lesson, id);
  } catch (e) {
    showMalformed(id, e);
  }
}

function showMalformed(id, e) {
  $('player-view').hidden = true;
  $('missing').hidden = false;
  $('missing').querySelector('h1').textContent = '課程檔格式錯誤：' + e.message;
  $('missing').querySelector('p').replaceChildren('影片 ', el('code', id), ' 的課程檔無法使用。可重新產課：');
  $('missing-cmd').textContent = 'python3 -m pipeline.build ' + id;
  $('missing-capture').parentElement.hidden = true;
  initHome(false);
}

// The intro card is optional data; anything malformed just means no card, never a broken lesson.
function renderIntro(intro) {
  const box = $('intro');
  box.hidden = true;
  box.classList.remove('show');
  try {
    const rows = introRows(intro);
    if (!rows) return;
    $('intro-title').replaceChildren(...rows.title.map((r) => el('div', r)));
    $('intro-lines').replaceChildren(...rows.lines.map((r) => el('div', r)));
    box.hidden = false;
  } catch (e) { box.hidden = true; }
}

function showIntro() {
  const hint = $('hint');
  hint.classList.add('show');
  setTimeout(() => hint.classList.remove('show'), HINT_SECONDS * 1000);
  const box = $('intro');
  if (box.hidden) return;
  box.classList.add('show');
  setTimeout(() => box.classList.remove('show'), INTRO_SECONDS * 1000);
}

// The title row is shared chrome: every route names itself in the one h1.
function setScreen(title, meta, { form = false } = {}) {
  $('title-row').hidden = false;
  $('screen-title').textContent = title;
  $('screen-meta').textContent = meta || '';
  $('url-form').hidden = !form;
}

function markNav(onHome) {
  const n = $('nav-home');
  if (n) { n.classList.toggle('current', onHome); if (onHome) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); }
}

function setupLesson(lesson, id) {
  markNav(false);
  lesson.vocab = lesson.vocab || [];
  S.lesson = lesson;
  S.flat = flattenHits(lesson.vocab, lesson.words);
  S.vocabById = new Map(lesson.vocab.map((v) => [v.id, v]));
  document.title = (lesson.title || id) + ' · yt-learn';
  $('player-view').hidden = false;
  setScreen(lesson.title || id, [lesson.channel, fmtTime(lesson.duration), lesson.vocab.length + ' 個單字'].filter(Boolean).join('・'));
  renderIntro(lesson.intro);
  if (lesson.coveredSeconds != null && lesson.duration != null && lesson.coveredSeconds < lesson.duration) {
    $('banner').hidden = false;
    $('banner').textContent = '僅前 ' + Math.round(lesson.coveredSeconds) + ' 秒';
  }
  buildPanel();
  buildTranscript();
  buildVocabTable();
  render(0);
  const site = externalSite(id);
  if (site) { setupExternalLesson(lesson, id, site); return; } // never initPlayer() for these
  initPlayer(lesson.videoId || id);
}

// External-site lessons (Udemy, Netflix, HelloInterview) have no player here: subtitles only exist as an overlay on
// that site's page. Show the header (done by setupLesson), a notice and the vocab review grid.
function setupExternalLesson(lesson, id, site) {
  S.noPlayer = true;
  $('yt').hidden = true;
  const note = $('site-note');
  const text = el('span', site.note);
  const nodes = [text];
  const href = site.link(lesson, id);
  if (href) {
    const a = el('a', site.linkText);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    nodes.push('　', a);
  }
  nodes.push(el('span', site.playHint, 'site-hint'));
  note.replaceChildren(...nodes);
  note.hidden = false;
  enterReview();
}

let hintTimer = 0;
function sitePlayHint() {
  const h = document.querySelector('#site-note .site-hint');
  if (!h) return;
  h.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove('show'), 2500);
}

function showMissing(id) {
  $('missing').hidden = false;
  setScreen('尚未產課', id);
  $('missing-id').textContent = id;
  $('missing-cmd').textContent = 'python3 -m pipeline.build ' + id;
  initHome(false);
  const inPlace = () => {
    stopCard();
    $('missing').hidden = true;
    $('home').hidden = true;
    loadLesson(id);
  };
  let clicked = false;
  $('missing-capture').onclick = () => {
    clicked = true;
    $('missing-default').hidden = true;
    $('missing').querySelector('h1').textContent = '擷取影片';
    startJob(id, $('card-missing'), { onDone: inPlace });
  };
  // A job may already be running (e.g. the extension icon created it just before opening this page).
  fetch('/jobs/' + encodeURIComponent(id)).then(async (res) => {
    if (!res.ok || clicked) return;
    const body = await res.json();
    if (clicked) return;
    const job = body.job || body;
    $('missing-default').hidden = true;
    $('missing').querySelector('h1').textContent = '正在產生課程';
    showJob(job, $('card-missing'), { onDone: inPlace });
  }).catch(() => { /* server unreachable: keep the v1 view */ });
}

function fmtTime(s) {
  if (s == null) return '';
  s = Math.floor(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ---------------------------------------------------------------- player
async function initPlayer(videoId) {
  await window.ytReady;
  S.player = new YT.Player('yt', {
    videoId,
    playerVars: { controls: 1, rel: 0, fs: 0, cc_load_policy: 0, playsinline: 1 },
    events: {
      onReady: () => { S.ready = true; window.__player = S.player; hideYouTubeCaptions(); refresh(); },
      onStateChange: onStateChange,
    },
  });
  let tick = 0;
  setInterval(() => {
    if (!S.ready) return;
    if (S.player.getPlayerState() === YT.PlayerState.PLAYING) { refresh(); return; }
    // Deviation (see report): scrubbing YouTube's own progress bar while paused fires
    // no state change, so every 500 ms re-read the (static) time and redraw only if it moved.
    if (++tick % 5 === 0 && !S.pendingSeek && Math.abs((S.player.getCurrentTime() || 0) - S.t) > 0.05) refresh();
  }, 100);
}

// Our subtitles replace YouTube's CC. cc_load_policy:0 does not override a viewer's
// own "always show captions" preference, so also unload the captions module.
function hideYouTubeCaptions() {
  try { S.player.unloadModule('captions'); S.player.unloadModule('cc'); } catch (e) { /* not fatal */ }
}

function onStateChange(ev) {
  const st = ev.data;
  if (st === YT.PlayerState.PLAYING) hideYouTubeCaptions();
  if (st === YT.PlayerState.PLAYING && !S.started) { S.started = true; $('stage').classList.add('started'); showIntro(); }
  if (st === YT.PlayerState.ENDED) enterReview();
  else if (st === YT.PlayerState.PLAYING && S.review) leaveReview();
  $('btn-play').textContent = st === YT.PlayerState.PLAYING ? '暫停' : '播放';
  refresh();
}

function refresh() {
  if (!S.ready) return;
  let t = S.player.getCurrentTime() || 0;
  const p = S.pendingSeek;
  if (p) {
    // The API reports a cached pre-seek time until the iframe confirms the seek
    // (up to ~1 s while paused). Ignore such stale reads; never extrapolate.
    if (Math.abs(t - p.t) > 0.75 && performance.now() < p.until) t = p.t;
    else S.pendingSeek = null;
  }
  render(t);
}

function seek(t, play = true) {
  if (S.noPlayer) { sitePlayHint(); return; }
  if (!S.ready) return;
  if (S.review) leaveReview();
  t = Math.max(0, t);
  S.player.seekTo(t, true);
  if (play) S.player.playVideo();
  // A paused seek fires no state change: draw the target now, then keep re-reading
  // until the player confirms it (see refresh()).
  S.pendingSeek = { t, until: performance.now() + 2500 };
  render(t);
  clearInterval(S.seekTimer);
  S.seekTimer = setInterval(() => { refresh(); if (!S.pendingSeek) clearInterval(S.seekTimer); }, 200);
}

function cueStart(i) { return S.lesson.words[S.lesson.cues[i].a].t; }

function seekHit(h) { seek(h.start - 0.3); }

function render(t) {
  S.t = t;
  renderSubtitle(t);
  renderPanel(t);
  renderTranscriptCurrent(t);
}

// ---------------------------------------------------------------- render subtitle
function renderSubtitle(t) {
  const { cues, words } = S.lesson;
  const ci = cueIndexAt(cues, words, t);
  const hit = activeHitAt(S.flat, cues, words, t);
  let lit = null; // [a, b] global word range to paint orange
  let term = ''; // its vocab term: what a click on the orange span looks up
  if (hit && ci >= 0) {
    const v = S.vocabById.get(hit.vocabId);
    const h = v.hits[hit.hitIdx];
    if (h.cue === ci) { lit = [h.a, h.b]; term = v.term; }
  }
  const key = ci + '|' + (lit ? lit.join('-') : '');
  if (key === S.keys.sub) return;
  S.keys.sub = key;
  const en = $('sub-en'), zh = $('sub-zh');
  if (ci < 0) { en.replaceChildren(); zh.replaceChildren(); en.dataset.cue = ''; return; }
  const cue = cues[ci];
  const parts = [];
  // Every token is its own clickable .w span; a vocab hit spanning several tokens is one .kw span
  // (data-term = the vocab term), so a click on it looks up the whole term.
  let kw = null;
  cue.tokens.forEach((tok, k) => {
    const w = cue.a + k;
    const inHit = lit && w >= lit[0] && w <= lit[1];
    if (inHit && kw) { kw.textContent += ' ' + tok; return; }
    if (k) parts.push(document.createTextNode(' '));
    if (inHit) {
      kw = el('span', tok, 'kw');
      if (term) kw.dataset.term = term;
      parts.push(kw);
    } else parts.push(el('span', tok, 'w'));
  });
  const enChanged = en.dataset.cue !== String(ci);
  en.replaceChildren(...parts);
  if (enChanged) {
    en.dataset.cue = String(ci);
    zh.textContent = cue.zh || '';
    fitSubtitle();
  }
}

// Click a subtitle word → pause and look it up in the Cambridge dictionary, in one small popup
// window that later lookups reuse (named target).
function onWordClick(e) {
  const raw = clickWord(e.target);
  if (!raw) return;
  e.preventDefault();
  const word = dictWord(raw);
  if (!word) return; // a number or punctuation only
  if (S.ready) S.player.pauseVideo();
  const win = window.open(dictUrl(word), 'ytlearn-dict', 'popup,width=520,height=760');
  if (win) win.focus();
}

// Shrink English when it needs more than two lines, Chinese when it overflows one line.
function fitSubtitle() {
  const en = $('sub-en'), zh = $('sub-zh');
  en.classList.remove('long');
  zh.classList.remove('long');
  if (en.textContent) {
    en.classList.add('measuring'); // lift the 2-line clamp while measuring
    const lh = parseFloat(getComputedStyle(en).lineHeight);
    if (en.scrollHeight > lh * 2.3) en.classList.add('long');
    en.classList.remove('measuring');
  }
  if (zh.textContent && zh.scrollWidth > zh.clientWidth + 1) zh.classList.add('long');
}

// ---------------------------------------------------------------- render panel
function buildPanel() {
  const n = S.lesson.vocab.length;
  $('panel').hidden = n === 0;
  $('panel-total').textContent = n;
  const rows = $('panel-rows');
  rows.replaceChildren();
  // All occurrences are rendered once as a vertical track; renderPanel slides the track so the
  // current occurrence sits in the middle slot. Rows never re-render, so the motion is one smooth scroll.
  const track = el('div', null, 'ptrack');
  track.id = 'panel-track';
  S.flat.forEach((h, fi) => {
    const v = S.vocabById.get(h.vocabId);
    const r = el('div', null, 'prow future');
    r.dataset.flat = fi;
    r.innerHTML = '<div class="l1"><span class="term"></span><span class="pos"></span><span class="ipa"></span><span class="times"></span></div>'
      + '<div class="l2"><span class="pzh"></span><span class="dots"></span></div>';
    r.querySelector('.term').textContent = v.term;
    r.querySelector('.pos').textContent = v.pos || '';
    r.querySelector('.ipa').textContent = v.ipa || '';
    r.querySelector('.times').textContent = '\u00d7' + v.hits.length;
    r.querySelector('.pzh').textContent = v.zh;
    r.querySelector('.dots').replaceChildren(...v.hits.map((_, j) => el('i', null, j === h.hitIdx ? 'on' : '')));
    r.addEventListener('click', () => seekHit(S.flat[fi]));
    track.append(r);
  });
  rows.append(track);
  S.keys.panel = null;
  S.panelCurrent = -1;
}

function renderPanel(t) {
  const { words } = S.lesson;
  const k = seenCount(S.flat, words, t);
  const countKey = k + '/' + S.lesson.vocab.length;
  if (countKey !== S.keys.count) { S.keys.count = countKey; $('panel-count').textContent = k + ' / ' + S.lesson.vocab.length; }
  // The panel stays hidden until just before the first vocab word is spoken, then fades in.
  const live = S.flat.length > 0 && t >= S.flat[0].start - PANEL_LEAD;
  $('panel').classList.toggle('live', live);
  const ps = panelState(S.flat, words, t);
  if (ps.current === S.keys.panel) return;
  S.keys.panel = ps.current;
  const track = $('panel-track');
  if (!track) return;
  const rowEls = track.children;
  const n = rowEls.length;
  // Slide so the current row is the 3rd of 5 visible rows; clamp at both ends (same window as panelState).
  const first = ps.rows.length ? ps.rows[0] : 0;
  const rowH = rowEls[0] ? rowEls[0].getBoundingClientRect().height : 0;
  track.style.transform = 'translateY(' + (-first * rowH) + 'px)';
  for (let fi = 0; fi < n; fi++) {
    const r = rowEls[fi];
    r.classList.toggle('current', fi === ps.current);
    r.classList.toggle('future', ps.current < 0 || fi > ps.current);
  }
}

// ---------------------------------------------------------------- review
function reviewItems() { return [...S.lesson.vocab].sort((a, b) => a.id - b.id); }
function pageCount() { return Math.max(1, Math.ceil(S.lesson.vocab.length / PER_PAGE)); }

function enterReview(page = 0) {
  S.review = true;
  $('intro').classList.remove('show');
  S.page = page;
  $('review-total').textContent = S.lesson.vocab.length;
  $('review').hidden = false;
  $('stage').classList.add('reviewing');
  renderReview();
}

function leaveReview() {
  S.review = false;
  $('review').hidden = true;
  $('stage').classList.remove('reviewing');
}

function turnPage(d) {
  S.page = Math.min(pageCount() - 1, Math.max(0, S.page + d));
  renderReview();
}

function renderReview() {
  const items = reviewItems().slice(S.page * PER_PAGE, (S.page + 1) * PER_PAGE);
  $('review-pager').replaceChildren(el('b', String(S.page + 1)), ' / ' + pageCount());
  $('review-prev').disabled = S.page === 0;
  $('review-next').disabled = S.page >= pageCount() - 1;
  const grid = $('review-grid');
  if (!S.lesson.vocab.length) { grid.replaceChildren(el('p', '本集沒有精選單字。', 'empty')); return; }
  grid.replaceChildren(...items.map((v) => {
    const c = el('button', null, 'cell');
    c.type = 'button';
    const l1 = el('div', null, 'c1');
    l1.append(el('span', v.term, 'cterm'), el('span', v.pos || '', 'cpos'));
    if (v.hits.length >= 2) l1.append(el('span', '×' + v.hits.length, 'pill'));
    c.append(l1, el('div', v.zh, 'czh'));
    c.addEventListener('click', () => {
      const first = S.flat.find((h) => h.vocabId === v.id);
      if (first) seekHit(first);
    });
    return c;
  }));
}

// ---------------------------------------------------------------- lists
function buildTranscript() {
  const { cues } = S.lesson;
  $('transcript').replaceChildren(...cues.map((c, i) => {
    const li = el('li', null, 'tline');
    li.append(el('span', fmtTime(cueStart(i)), 'tt'), el('span', c.en, 'ten'), el('span', c.zh, 'tzh'));
    li.addEventListener('click', () => seek(cueStart(i)));
    return li;
  }));
}

function renderTranscriptCurrent(t) {
  const ci = cueIndexAt(S.lesson.cues, S.lesson.words, t);
  if (ci === S.keys.cue) return;
  const list = $('transcript');
  if (S.keys.cue != null && S.keys.cue >= 0) list.children[S.keys.cue]?.classList.remove('current');
  S.keys.cue = ci;
  if (ci < 0) return;
  const li = list.children[ci];
  li.classList.add('current');
  // "nearest" scroll inside the list box only, so the page itself never jumps.
  // (.transcript is position:relative, so it is the li's offsetParent.)
  const top = li.offsetTop, bottom = top + li.offsetHeight;
  if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = top - list.clientHeight / 2 + li.offsetHeight / 2;
  }
}

function buildVocabTable() {
  $('vocab-body').replaceChildren(...reviewItems().map((v) => {
    const tr = document.createElement('tr');
    const term = el('td', null, 'vt');
    term.append(el('div', v.term));
    if (v.ipa) term.append(el('div', v.ipa, 'vi')); // the IPA stacks under the term: one identity column, no empty 音標 column
    tr.append(term, el('td', v.pos || ''), el('td', v.zh), el('td', '×' + v.hits.length, 'vn num'));
    tr.addEventListener('click', () => {
      const first = S.flat.find((h) => h.vocabId === v.id);
      if (first) seekHit(first);
    });
    return tr;
  }));
}

// ---------------------------------------------------------------- controls & keyboard
function currentCueForNav() {
  const { cues, words } = S.lesson;
  // last cue that has started (so silence counts as "after" the previous cue)
  let i = -1;
  for (let j = 0; j < cues.length && words[cues[j].a].t <= S.t; j++) i = j;
  return i;
}

function togglePlay() {
  if (!S.ready) return;
  if (S.player.getPlayerState() === YT.PlayerState.PLAYING) S.player.pauseVideo();
  else S.player.playVideo();
}
function replayCue() { const i = currentCueForNav(); seek(i >= 0 ? cueStart(i) : 0); }
function stepCue(d) {
  const n = S.lesson.cues.length;
  if (!n) return;
  const i = Math.min(n - 1, Math.max(0, currentCueForNav() + d));
  seek(cueStart(i));
}
function toggleZh() {
  S.showZh = !S.showZh;
  $('stage').classList.toggle('no-zh', !S.showZh);
  $('btn-zh').textContent = '中文 ' + (S.showZh ? 'on' : 'off');
  $('btn-zh').setAttribute('aria-pressed', String(S.showZh));
  if (S.showZh) fitSubtitle();
}
function toggleEn() {
  S.showEn = !S.showEn;
  $('stage').classList.toggle('no-en', !S.showEn);
  $('btn-en').textContent = '英文 ' + (S.showEn ? 'on' : 'off');
  $('btn-en').setAttribute('aria-pressed', String(S.showEn));
  if (S.showEn) fitSubtitle(); // a cue fitted while hidden measured 0 height
}
function toggleVocab() {
  S.showVocab = !S.showVocab;
  $('stage').classList.toggle('no-vocab', !S.showVocab);
  $('btn-vocab').textContent = '單字 ' + (S.showVocab ? 'on' : 'off');
  $('btn-vocab').setAttribute('aria-pressed', String(S.showVocab));
  if (S.showVocab && S.lesson) { S.keys.panel = null; renderPanel(S.t || 0); } // rows measured 0 height while hidden
}
function toggleShade() {
  S.showShade = !S.showShade;
  $('stage').classList.toggle('no-shade', !S.showShade);
  $('btn-shade').textContent = '黑底 ' + (S.showShade ? 'on' : 'off');
  $('btn-shade').setAttribute('aria-pressed', String(S.showShade));
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen?.();
}

function initControls() {
  $('btn-play').onclick = togglePlay;
  $('btn-replay').onclick = replayCue;
  $('btn-prev').onclick = () => stepCue(-1);
  $('btn-next').onclick = () => stepCue(1);
  $('btn-zh').onclick = toggleZh;
  $('btn-en').onclick = toggleEn;
  $('btn-vocab').onclick = toggleVocab;
  $('btn-shade').onclick = toggleShade;
  $('btn-fs').onclick = toggleFullscreen;
  $('sub-en').addEventListener('click', onWordClick); // delegated: the word spans are rebuilt per cue
  // Keep focus off the buttons so Space never double-fires (button click + our handler).
  document.querySelectorAll('#controls button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
  $('review-prev').onclick = () => turnPage(-1);
  $('review-next').onclick = () => turnPage(1);
  $('review-again').onclick = () => seek(0);
  window.addEventListener('resize', () => { if (S.lesson) { fitSubtitle(); S.keys.panel = null; renderPanel(S.t || 0); } });
  document.addEventListener('fullscreenchange', () => {
    $('btn-fs').textContent = document.fullscreenElement ? '離開全螢幕' : '全螢幕';
    if (S.lesson) fitSubtitle();
  });
  document.addEventListener('keydown', onKey);
  // Key events never reach this page while the YouTube iframe has focus, which it takes on any click
  // on the video. Pull focus back as soon as it lands there so the shortcuts keep working.
  window.addEventListener('blur', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a.tagName === 'IFRAME' && $('stage').contains(a)) { a.blur(); window.focus(); }
    }, 0);
  });
}

function onKey(e) {
  if (!S.lesson || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // Match on the physical key (e.code): with a Chinese IME active, letter keys arrive with
  // e.key === 'Process' and would never match 'e' / 'z' / 'v'.
  const code = e.code || e.key;
  if (S.review) {
    if (code === 'ArrowLeft') { turnPage(-1); e.preventDefault(); }
    else if (code === 'ArrowRight') { turnPage(1); e.preventDefault(); }
    return;
  }
  switch (code) {
    case 'Space': case ' ': togglePlay(); break;
    case 'ArrowLeft': stepCue(-1); break;
    case 'ArrowRight': stepCue(1); break;
    case 'KeyR': replayCue(); break;
    case 'KeyZ': toggleZh(); break;
    case 'KeyE': toggleEn(); break;
    case 'KeyV': toggleVocab(); break;
    case 'KeyB': toggleShade(); break;
    case 'KeyF': toggleFullscreen(); break;
    default: return;
  }
  e.preventDefault();
}

// ---------------------------------------------------------------- boot
const vid = new URLSearchParams(location.search).get('v');
if (vid) {
  initControls();
  loadLesson(vid);
} else {
  initHome(true);
}
// debug/verification hooks
window.__yt = { S, enterReview, leaveReview, turnPage, seek };
