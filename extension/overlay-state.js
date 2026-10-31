// Pure state for the overlay (extension/overlay.js). No DOM, no chrome.*: everything here
// is plain data in, plain data out, so it runs under node --test (tests/web/overlay-state.test.js).

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Same rule as extension/ytid.js ytLearnParseUdemyUrl and pipeline/ids.py parse_udemy_url (tests/fixtures/lesson_ids.json).
const UDEMY_URL_RE = /^https:\/\/www\.udemy\.com\/course\/([A-Za-z0-9_-]+)\/learn\/lecture\/([0-9]{1,12})\/?(?:[?#]\S*)?$/;

/* ---------- route ---------- */

// The lesson id of the page, or null: a www.youtube.com watch page -> its 11-char video id, a
// www.udemy.com lecture page -> 'udemy.<lectureId>'. `flexyId` (YouTube only) is ytd-watch-flexy's
// video-id attribute (null/'' when absent). During an SPA navigation the URL and the attribute can
// briefly disagree; that is reported as null ("not settled"), and the 1 s route poll picks it up once they agree.
export function lessonIdFromUrl(href, flexyId) {
  if (typeof href !== 'string') return null;
  const m = UDEMY_URL_RE.exec(href);
  if (m) return 'udemy.' + m[2];
  let u;
  try { u = new URL(href); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'www.youtube.com' || u.pathname !== '/watch') return null;
  const id = u.searchParams.get('v');
  if (!id || !ID_RE.test(id)) return null;
  if (flexyId && flexyId !== id) return null;
  return id;
}

// Old name (YouTube-only days); same function.
export const watchVideoId = lessonIdFromUrl;

/* ---------- mount state machine ----------
   videoId  the lesson page the state belongs to (null off a watch/lecture page)
   token    identity of the player the state belongs to (a number the engine bumps whenever the
            {root, video} it finds is replaced by a different one, e.g. Udemy swaps <video> on a lecture change)
   gen      bumped on every navigation and every toggle; async work carries {videoId, gen}
   on       the user's intent: true after turning the overlay on, false after turning it off.
            It survives navigation, so an explicit "off" is never undone by changing videos.
   mounted  the overlay is rendered for (videoId, gen)
   building a lesson fetch or a capture/build job is in flight for (videoId, gen) */

export function initialState() {
  return { videoId: null, token: null, gen: 0, on: false, mounted: false, building: false };
}

export function tokenOf(s) {
  return { videoId: s.videoId, gen: s.gen };
}

export function isStale(s, tok) {
  return !tok || tok.gen !== s.gen || tok.videoId !== s.videoId;
}

// The page now shows `videoId` (null = not a lesson page) in the player identified by `token`.
// -> { state, teardown, autoload }: teardown the old overlay/pill; autoload = fetch the lesson and
// mount it if one exists (never starts a capture on its own). The same id in a different player
// (token changed) counts as a navigation too: the old overlay is bound to a <video> that is gone.
// Off a lesson page the token is ignored.
export function navigate(s, videoId, token) {
  const id = videoId || null;
  const tk = token === undefined ? null : token;
  if (id === s.videoId && (id === null || tk === (s.token === undefined ? null : s.token))) {
    return { state: s, teardown: false, autoload: false };
  }
  const state = { ...s, videoId: id, token: tk, gen: s.gen + 1, mounted: false, building: false };
  return { state, teardown: s.mounted || s.building || s.videoId !== null, autoload: s.on && id !== null };
}

// Icon clicked. -> { state, action: 'teardown' | 'load' | 'none' }.
// 'load' means: fetch the lesson, mount it, or start a capture when it is missing.
export function toggle(s) {
  if (s.videoId === null) return { state: s, action: 'none' };
  if (s.mounted || s.building) {
    return { state: { ...s, on: false, mounted: false, building: false, gen: s.gen + 1 }, action: 'teardown' };
  }
  return { state: { ...s, on: true, gen: s.gen + 1 }, action: 'load' };
}

// Results of async work: applied only if the token is still current, otherwise the state is returned as is.
export function markMounted(s, tok) {
  return isStale(s, tok) ? s : { ...s, mounted: true, building: false };
}

export function markBuilding(s, tok) {
  return isStale(s, tok) ? s : { ...s, building: true };
}

export function markIdle(s, tok) {
  return isStale(s, tok) ? s : { ...s, mounted: false, building: false };
}

/* ---------- progress pill ---------- */

// Same steps as the local player's card (web/app.js STATE_TEXT / STEP_NAMES): 擷取字幕 → 產生課程 → 完成.
export const PILL_PREFIX = 'yt-learn：';

export function pillText(job) {
  if (!job || typeof job.state !== 'string') return PILL_PREFIX + '擷取字幕…';
  switch (job.state) {
    case 'queued':
    case 'capturing':
      return PILL_PREFIX + '擷取字幕…';
    case 'captured':
      return PILL_PREFIX + '產生課程…';
    case 'building': {
      const p = job.progress;
      if (p && typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
        return PILL_PREFIX + '產生課程 ' + pct + '%';
      }
      return PILL_PREFIX + '產生課程…';
    }
    case 'done':
      return PILL_PREFIX + '完成';
    case 'error':
      return PILL_PREFIX + (job.message ? String(job.message) : '產課失敗');
    default:
      return PILL_PREFIX + job.state;
  }
}

// 'poll' keep polling, 'done' fetch the lesson and mount, 'error' show the message and stop.
export function jobPhase(job) {
  if (job && job.state === 'done') return 'done';
  if (job && job.state === 'error') return 'error';
  return 'poll';
}

/* ---------- keyboard ---------- */

// Physical keys (e.code) we own while the overlay is on. Everything else stays YouTube's
// (Space, ← →, F, C, K, J, L, M, T, …). e.code, not e.key: with a Chinese IME, e.key is 'Process'.
export const OWN_KEYS = {
  KeyZ: 'zh',
  KeyE: 'en',
  KeyV: 'vocab',
  KeyR: 'replay',
  BracketLeft: 'prev',
  BracketRight: 'next',
};

// A node from event.composedPath() that accepts text input.
export function isEditable(node) {
  if (!node || typeof node !== 'object') return false;
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (node.isContentEditable === true) return true;
  const ce = typeof node.getAttribute === 'function' ? node.getAttribute('contenteditable') : null;
  return ce === '' || ce === 'true' || ce === 'plaintext-only';
}

// -> action name from OWN_KEYS, or null when the event is not ours to take.
// `ev` is a keydown event (or a plain object with the same fields); `path` is its composedPath().
export function keyAction(ev, { active, path = [] } = {}) {
  if (!active || !ev) return null;
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  if (ev.isComposing || ev.repeat) return null;
  const action = Object.prototype.hasOwnProperty.call(OWN_KEYS, ev.code) ? OWN_KEYS[ev.code] : null;
  if (!action) return null;
  for (const n of path) if (isEditable(n)) return null;
  return action;
}

/* ---------- ads ---------- */

// `classes`: #movie_player's className string, classList, or an array of class names.
export function adShowing(classes) {
  let list;
  if (typeof classes === 'string') list = classes.split(/\s+/);
  else if (classes && typeof classes[Symbol.iterator] === 'function') list = [...classes];
  else return false;
  return list.includes('ad-showing') || list.includes('ad-interrupting');
}

/* ---------- cue navigation (R / [ / ]) ---------- */

// Last cue that has started at t (silence counts as "after" the previous cue), as web/app.js does.
export function cueForNav(cues, words, t) {
  let i = -1;
  for (let j = 0; j < cues.length && words[cues[j].a].t <= t; j++) i = j;
  return i;
}

// Seek target (seconds) for 'replay' | 'prev' | 'next', or null when there is nothing to seek to.
export function cueSeekTarget(cues, words, t, action) {
  const n = cues.length;
  if (!n) return null;
  const i = cueForNav(cues, words, t);
  const start = (k) => words[cues[k].a].t;
  if (action === 'replay') return i >= 0 ? start(i) : 0;
  if (action === 'prev') return start(Math.max(0, i - 1));
  if (action === 'next') return start(Math.min(n - 1, i + 1));
  return null;
}
