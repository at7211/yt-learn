// Drag across subtitle words → ask the local server to explain that phrase (POST /explain, poll
// GET /explain/<key>), keep the answer as a per-video note (GET /notes/<videoId>). Pure helpers, the
// polling loop, and the card / note-row builders. Those take the document as an argument and only use
// createElement / textContent / append / addEventListener: the answer is model output and youtube.com
// enforces Trusted Types, so no HTML sink is ever used. web/app.js and extension/overlay.js own the
// events and the placement. web/phrase.js and extension/phrase.js must stay byte-identical
// (tests/web/extension-copies.test.js).

export const MAX_WORDS = 30; // the server refuses a longer selection
export const POLL_MS = 1500;
export const POLL_LIMIT_MS = 3 * 60 * 1000;
const MAX_REPOSTS = 3; // a poll 404 (job pruned / server restarted) re-POSTs at most this often
const MAX_DOWNS = 3; // consecutive unreachable polls before giving up
export const TIMEOUT_TEXT = 'AI 太久沒有回應，請稍後再試（結果若完成仍會存進我的片語）';
const GONE_TEXT = '找不到這個查詢，請再試一次';

const isInt = (n) => Number.isInteger(n);

// The global word range {a, b} (a <= b) from the anchor word i to the word j under the pointer, both
// clamped into the cue, and at most `max` words long (the far end gives way). null for a bad cue.
export function spanRange(cue, i, j, max = MAX_WORDS) {
  if (!cue || !isInt(cue.a) || !isInt(cue.b) || cue.b < cue.a || !isInt(i) || !isInt(j)) return null;
  const clamp = (x) => Math.min(cue.b, Math.max(cue.a, x));
  i = clamp(i);
  j = clamp(j);
  if (Math.abs(j - i) + 1 > max) j = i + Math.sign(j - i) * (max - 1);
  return { a: Math.min(i, j), b: Math.max(i, j) };
}

// The phrase text the server expects: the cue's own tokens a..b joined by single spaces.
export function phraseText(cue, a, b) {
  if (!cue || !Array.isArray(cue.tokens) || !isInt(a) || !isInt(b) || a > b || a < cue.a || b > cue.b) return '';
  return cue.tokens.slice(a - cue.a, b - cue.a + 1).join(' ');
}

export function noteKey(a, b) { return a + '-' + b; }

// What a press-drag-release on the subtitle means. down/up: the word index under the press / the last
// word the pointer was over; moved: the selection ever spanned more than the pressed word.
// 'dict' (a plain click on one word), 'phrase' (two or more words), null (nothing: dragged away and back).
export function dragKind(down, up, moved) {
  if (!isInt(down)) return null;
  if (!isInt(up) || up === down) return moved ? null : 'dict';
  return 'phrase';
}

// A note is usable for cue ci when it names that cue and a sane range inside it.
function noteOk(n) {
  return !!n && typeof n === 'object' && isInt(n.cue) && isInt(n.a) && isInt(n.b) && n.a <= n.b
    && typeof n.phrase === 'string' && !!n.result && typeof n.result === 'object';
}

// The notes in {"a-b": NOTE} order by cue, then by start, then shorter first. Malformed entries are dropped.
export function noteList(notes) {
  if (!notes || typeof notes !== 'object') return [];
  return Object.values(notes).filter(noteOk).sort((x, y) => x.cue - y.cue || x.a - y.a || x.b - y.b);
}

// The note a click on word i of cue ci opens: the shortest note covering it (null when none).
export function noteAtWord(notes, ci, i) {
  let best = null;
  for (const n of noteList(notes)) {
    if (n.cue !== ci || i < n.a || i > n.b) continue;
    if (!best || n.b - n.a < best.b - best.a) best = n;
  }
  return best;
}

// Word indices of cue ci covered by some note (they get a faint underline).
export function notedWords(notes, ci) {
  const out = new Set();
  for (const n of noteList(notes)) if (n.cue === ci) for (let w = n.a; w <= n.b; w++) out.add(w);
  return out;
}

// The saved note for exactly this selection, when it still matches the phrase (else null: ask the server).
export function noteFor(notes, ci, a, b, phrase) {
  const n = notes && typeof notes === 'object' ? notes[noteKey(a, b)] : null;
  return noteOk(n) && n.cue === ci && n.a === a && n.b === b && n.phrase === phrase ? n : null;
}

// The card body for a note's result (all model output: render as text only). Empty or malformed fields
// are left out. -> [{label, text}] or [{label, items: [{en, zh}]}].
export function cardSections(result) {
  const r = result && typeof result === 'object' ? result : {};
  const str = (x) => (typeof x === 'string' && x.trim() ? x : '');
  const list = (arr, zhKey) => (Array.isArray(arr) ? arr : [])
    .filter((x) => x && typeof x === 'object' && str(x.en))
    .map((x) => ({ en: x.en, zh: str(x[zhKey]) }));
  const out = [];
  for (const [label, key] of [['在這裡的意思', 'meaningZh'], ['為什麼這樣說', 'whyHere'], ['可套用的句型', 'pattern']]) {
    if (str(r[key])) out.push({ label, text: r[key] });
  }
  const ex = list(r.examples, 'zh');
  if (ex.length) out.push({ label: '其他例句', items: ex });
  const alt = list(r.alternatives, 'noteZh');
  if (alt.length) out.push({ label: '類似說法', items: alt });
  return out;
}

// One reply ({status, json} from the server, or {error} when it could not be reached) → what it means.
// kind: 'done' {note} | 'pending' {key, warning} | 'budget' | 'busy' | 'phrase' | 'error' {error}
//       | 'gone' (poll 404: re-POST) | 'down' {error} (unreachable).
export function explainOutcome(reply, isPoll = false) {
  if (!reply || typeof reply !== 'object') return { kind: 'down', error: '沒有回應' };
  if (reply.disabled === true) return { kind: 'down', error: '這個網站的字幕疊加已關閉' };
  if (typeof reply.status !== 'number') return { kind: 'down', error: String(reply.error || '無法連線到本機 server') };
  const s = reply.status;
  const j = reply.json && typeof reply.json === 'object' ? reply.json : {};
  const err = typeof j.error === 'string' && j.error ? j.error : 'HTTP ' + s;
  if (s === 200 || s === 202) {
    if (j.state === 'done' && j.note && typeof j.note === 'object') return { kind: 'done', note: j.note };
    if (j.state === 'pending' && typeof j.key === 'string') {
      return { kind: 'pending', key: j.key, warning: typeof j.warning === 'string' ? j.warning : '' };
    }
    if (j.state === 'error') return { kind: 'error', error: err };
    return { kind: 'error', error: '本機 server 回應異常' };
  }
  if (isPoll && s === 404) return { kind: 'gone' };
  if (s === 402 && j.code === 'budget') return { kind: 'budget', error: err };
  if (s === 429 && j.code === 'busy') return { kind: 'busy', error: err };
  if (s === 409 && j.code === 'phrase') return { kind: 'phrase', error: err };
  return { kind: 'error', error: err };
}

// POST, then poll every POLL_MS until done / error, for at most POLL_LIMIT_MS. A poll 404 re-POSTs (a finished
// job's note is already saved, so that answers done). io: { post(body) → reply, poll(key) → reply,
// sleep(ms), now() → ms, cancelled() → bool, onPending?(outcome) }. Resolves to a final outcome
// (done / budget / busy / phrase / error) or {kind:'cancelled'} once cancelled() turns true.
export async function runExplain(io, body) {
  const now = io.now || Date.now;
  const cancelled = io.cancelled || (() => false);
  const start = now();
  let reposts = 0;
  let downs = 0;
  let key = null;
  let r = explainOutcome(await io.post(body));
  for (;;) {
    if (cancelled()) return { kind: 'cancelled' };
    if (r.kind === 'pending') {
      key = r.key;
      downs = 0;
      if (io.onPending) io.onPending(r);
    } else if (r.kind === 'gone') {
      if (++reposts > MAX_REPOSTS) return { kind: 'error', error: GONE_TEXT };
      r = explainOutcome(await io.post(body));
      if (r.kind === 'down') return { kind: 'error', error: r.error };
      continue;
    } else if (r.kind === 'down') {
      if (key === null || ++downs >= MAX_DOWNS) return { kind: 'error', error: r.error };
    } else {
      return r;
    }
    if (now() - start >= POLL_LIMIT_MS) return { kind: 'error', error: TIMEOUT_TEXT };
    await io.sleep(POLL_MS);
    if (cancelled()) return { kind: 'cancelled' };
    r = explainOutcome(await io.poll(key), true);
  }
}

/* ---------- placement ---------- */

// The smallest rect around rects ({left, top, right, bottom}); null when none has a size.
export function unionRect(rects) {
  let u = null;
  for (const r of rects || []) {
    if (!r || !(r.right > r.left || r.bottom > r.top)) continue;
    u = u ? { left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return u;
}

// Where a box `width` px wide goes above `anchor` inside `frame` (both viewport rects): {left, bottom,
// maxHeight} in px relative to the frame (left: the box's left edge, clamped inside; bottom: distance from
// the frame's bottom edge; maxHeight: the room above the anchor) and cx, the anchor's centre.
export function placeAbove(anchor, frame, width, gap = 8) {
  const fw = frame.right - frame.left;
  const cx = (anchor.left + anchor.right) / 2 - frame.left;
  const left = Math.max(gap, Math.min(cx - width / 2, fw - width - gap));
  return {
    cx: Math.round(cx),
    left: Math.round(left),
    bottom: Math.round(frame.bottom - anchor.top + gap),
    maxHeight: Math.round(Math.max(80, anchor.top - frame.top - 2 * gap)),
  };
}

/* ---------- DOM builders (document injected; text only) ---------- */

function mk(doc, tag, text, cls) {
  const e = doc.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function button(doc, text, cls, onClick) {
  const b = mk(doc, 'button', text, cls);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export const LOADING_TEXT = 'AI 正在解釋這段字幕…（可能要 10–60 秒，關掉卡片也會在背景存進我的片語）';

// The card's children for a view: {kind:'loading', phrase, warning?} | {kind:'done', phrase, result}
// | {kind:'budget'|'busy'|'phrase'|'error', phrase, error}. on: {close, retry, override, dict} click handlers
// (dict: a 查字典 button in the footer of a done card).
export function cardNodes(doc, view, on = {}) {
  const v = view || {};
  const head = mk(doc, 'div', null, 'ph-head');
  head.append(mk(doc, 'span', typeof v.phrase === 'string' ? v.phrase : '', 'ph-phrase'));
  const x = button(doc, '×', 'ph-x', on.close);
  x.title = '關閉（Esc）';
  head.append(x);
  const body = mk(doc, 'div', null, 'ph-body');
  if (v.kind === 'loading') {
    body.append(mk(doc, 'p', LOADING_TEXT, 'ph-status'));
    if (v.warning) body.append(mk(doc, 'p', v.warning, 'ph-warn'));
  } else if (v.kind === 'done') {
    const secs = cardSections(v.result);
    if (!secs.length) body.append(mk(doc, 'p', 'AI 這次沒有給出內容', 'ph-status'));
    for (const s of secs) {
      const sec = mk(doc, 'section', null, 'ph-sec');
      sec.append(mk(doc, 'div', s.label, 'ph-label'));
      if (s.items) {
        const ul = mk(doc, 'ul', null, 'ph-list');
        for (const it of s.items) {
          const li = mk(doc, 'li');
          li.append(mk(doc, 'div', it.en, 'ph-en'));
          if (it.zh) li.append(mk(doc, 'div', it.zh, 'ph-zh'));
          ul.append(li);
        }
        sec.append(ul);
      } else {
        sec.append(mk(doc, 'p', s.text, 'ph-text'));
      }
      body.append(sec);
    }
  } else {
    body.append(mk(doc, 'p', typeof v.error === 'string' && v.error ? v.error : '發生錯誤', 'ph-status ph-err'));
    const acts = mk(doc, 'div', null, 'ph-actions');
    if (v.kind === 'budget') acts.append(button(doc, '這次仍要問', 'ph-go', on.override));
    else if (v.kind !== 'phrase') acts.append(button(doc, '再試一次', 'ph-go', on.retry));
    if (acts.children.length) body.append(acts);
  }
  if (v.kind === 'done' && typeof on.dict === 'function') {
    const foot = mk(doc, 'div', null, 'ph-actions');
    foot.append(button(doc, '查字典', 'ph-dict', on.dict));
    body.append(foot);
  }
  return [head, body];
}

// One row per note for the 我的片語 list: the phrase and its meaning; a click calls onPick(note, event).
export function noteRowNodes(doc, notes, onPick) {
  return noteList(notes).map((n) => {
    const row = mk(doc, 'div', null, 'nrow');
    row.append(mk(doc, 'div', n.phrase, 'nphrase'));
    const zh = n.result && typeof n.result.meaningZh === 'string' ? n.result.meaningZh : '';
    row.append(mk(doc, 'div', zh, 'nzh'));
    row.title = n.phrase;
    if (onPick) row.addEventListener('click', (e) => onPick(n, e));
    return row;
  });
}
