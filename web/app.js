// yt-learn player. Sections: util, home, load, player, render subtitle,
// render panel, review, lists, controls & keyboard, boot.
import { cueIndexAt, flattenHits, activeHitAt, panelState, seenCount } from './timing.js';

// ---------------------------------------------------------------- util
const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
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
  review: false,
  page: 0,
  keys: { sub: null, panel: null, cue: null, count: null },
};

// ---------------------------------------------------------------- home (no ?v)
function initHome(showList) {
  $('home').hidden = false;
  $('lesson-list').hidden = !showList;
  const result = $('result');
  const show = (nodes) => result.replaceChildren(...nodes);
  $('go').onclick = async () => {
    const text = $('import').value.trim();
    if (!text) { show([el('p', '請先貼上 JSON。', 'err')]); return; }
    try {
      const res = await fetch('/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
      const out = await res.json();
      if (out.ok) {
        show([el('p', '已匯入 ' + out.videoId + '（' + out.events + ' 個事件）。請在終端機執行：'),
              el('pre', out.next), el('p', '產課完成後重新整理此頁。')]);
      } else {
        show([el('p', '匯入失敗：', 'err'), ...(out.errors || ['未知錯誤']).map((m) => el('p', m, 'err'))]);
      }
    } catch (e) {
      show([el('p', '無法連線到 server：' + e.message, 'err')]);
    }
  };
  if (showList) loadLessonList();
}

async function loadLessonList() {
  const lessons = $('lessons');
  try {
    const list = await (await fetch('/lessons')).json();
    if (!list.length) { lessons.replaceChildren(el('li', '尚無課程。')); return; }
    lessons.replaceChildren(...list.map((l) => {
      const li = document.createElement('li');
      const a = el('a', l.title || l.videoId);
      a.href = 'index.html?v=' + encodeURIComponent(l.videoId);
      const meta = [l.channel, l.vocabCount != null ? l.vocabCount + ' 個單字' : null].filter(Boolean).join('・');
      li.append(a, meta ? document.createTextNode('　' + meta) : '');
      return li;
    }));
  } catch (e) {
    lessons.replaceChildren(el('li', '無法載入課程清單。', 'err'));
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
  initHome(false);
}

function setupLesson(lesson, id) {
  lesson.vocab = lesson.vocab || [];
  S.lesson = lesson;
  S.flat = flattenHits(lesson.vocab, lesson.words);
  S.vocabById = new Map(lesson.vocab.map((v) => [v.id, v]));
  document.title = (lesson.title || id) + ' · yt-learn';
  $('player-view').hidden = false;
  $('lesson-title').textContent = lesson.title || id;
  $('lesson-meta').textContent = [lesson.channel, fmtTime(lesson.duration), lesson.vocab.length + ' 個單字'].filter(Boolean).join('・');
  if (lesson.coveredSeconds != null && lesson.duration != null && lesson.coveredSeconds < lesson.duration) {
    $('banner').hidden = false;
    $('banner').textContent = '僅前 ' + Math.round(lesson.coveredSeconds) + ' 秒';
  }
  buildPanel();
  buildTranscript();
  buildVocabTable();
  render(0);
  initPlayer(lesson.videoId || id);
}

function showMissing(id) {
  $('missing').hidden = false;
  $('missing-id').textContent = id;
  $('missing-cmd').textContent = 'python3 -m pipeline.build ' + id;
  initHome(false);
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
  if (hit && ci >= 0) {
    const h = S.vocabById.get(hit.vocabId).hits[hit.hitIdx];
    if (h.cue === ci) lit = [h.a, h.b];
  }
  const key = ci + '|' + (lit ? lit.join('-') : '');
  if (key === S.keys.sub) return;
  S.keys.sub = key;
  const en = $('sub-en'), zh = $('sub-zh');
  if (ci < 0) { en.replaceChildren(); zh.replaceChildren(); en.dataset.cue = ''; return; }
  const cue = cues[ci];
  const parts = [];
  cue.tokens.forEach((tok, k) => {
    const w = cue.a + k;
    if (k) parts.push(document.createTextNode(' '));
    parts.push(lit && w >= lit[0] && w <= lit[1] ? el('span', tok, 'kw') : document.createTextNode(tok));
  });
  const enChanged = en.dataset.cue !== String(ci);
  en.replaceChildren(...parts);
  if (enChanged) {
    en.dataset.cue = String(ci);
    zh.textContent = cue.zh || '';
    fitSubtitle();
  }
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
  for (let i = 0; i < Math.min(5, S.flat.length); i++) {
    const r = el('div', null, 'prow');
    r.innerHTML = '<div class="l1"><span class="term"></span><span class="pos"></span><span class="ipa"></span><span class="times"></span></div>'
      + '<div class="l2"><span class="pzh"></span><span class="dots"></span></div>';
    r.addEventListener('click', () => {
      const fi = Number(r.dataset.flat);
      if (!Number.isNaN(fi)) seekHit(S.flat[fi]);
    });
    rows.append(r);
  }
}

function renderPanel(t) {
  const { words } = S.lesson;
  const k = seenCount(S.flat, words, t);
  const countKey = k + '/' + S.lesson.vocab.length;
  if (countKey !== S.keys.count) { S.keys.count = countKey; $('panel-count').textContent = k + ' / ' + S.lesson.vocab.length; }
  const ps = panelState(S.flat, words, t);
  const key = ps.current + ':' + ps.rows.join(',');
  if (key === S.keys.panel) return;
  S.keys.panel = key;
  const rowEls = $('panel-rows').children;
  ps.rows.forEach((fi, i) => {
    const r = rowEls[i];
    const h = S.flat[fi];
    const v = S.vocabById.get(h.vocabId);
    r.dataset.flat = fi;
    r.classList.toggle('current', fi === ps.current);
    r.classList.toggle('future', ps.current < 0 || fi > ps.current);
    r.querySelector('.term').textContent = v.term;
    r.querySelector('.pos').textContent = v.pos || '';
    r.querySelector('.ipa').textContent = v.ipa || '';
    r.querySelector('.times').textContent = '×' + v.hits.length;
    r.querySelector('.pzh').textContent = v.zh;
    const dots = r.querySelector('.dots');
    dots.replaceChildren(...v.hits.map((_, j) => el('i', null, j === h.hitIdx ? 'on' : '')));
  });
}

// ---------------------------------------------------------------- review
function reviewItems() { return [...S.lesson.vocab].sort((a, b) => a.id - b.id); }
function pageCount() { return Math.max(1, Math.ceil(S.lesson.vocab.length / PER_PAGE)); }

function enterReview(page = 0) {
  S.review = true;
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
    tr.append(el('td', v.term, 'vt'), el('td', v.pos || ''), el('td', v.ipa || '', 'vi'), el('td', v.zh), el('td', '×' + v.hits.length, 'vn'));
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
  $('btn-fs').onclick = toggleFullscreen;
  // Keep focus off the buttons so Space never double-fires (button click + our handler).
  document.querySelectorAll('#controls button').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));
  $('review-prev').onclick = () => turnPage(-1);
  $('review-next').onclick = () => turnPage(1);
  $('review-again').onclick = () => seek(0);
  window.addEventListener('resize', () => { if (S.lesson) fitSubtitle(); });
  document.addEventListener('fullscreenchange', () => {
    $('btn-fs').textContent = document.fullscreenElement ? '離開全螢幕' : '全螢幕';
    if (S.lesson) fitSubtitle();
  });
  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (!S.lesson || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (S.review) {
    if (e.key === 'ArrowLeft') { turnPage(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { turnPage(1); e.preventDefault(); }
    return;
  }
  switch (e.key) {
    case ' ': togglePlay(); break;
    case 'ArrowLeft': stepCue(-1); break;
    case 'ArrowRight': stepCue(1); break;
    case 'r': case 'R': replayCue(); break;
    case 'z': case 'Z': toggleZh(); break;
    case 'e': case 'E': toggleEn(); break;
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
