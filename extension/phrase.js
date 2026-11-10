// Drag across subtitle words → ask the local server to explain that phrase (POST /explain, poll
// GET /explain/<key>), keep the answer as a per-video note (GET /notes/<videoId>). Pure helpers and the
// polling loop only, no DOM: web/app.js and extension/overlay.js build the UI. web/phrase.js and
// extension/phrase.js must stay byte-identical (tests/web/extension-copies.test.js).

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
