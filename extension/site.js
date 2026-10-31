// Site adapters for the overlay engine (extension/overlay.js dynamic-imports this file).
// siteFor(hostname) -> { name, lessonId(url, doc), findPlayer(doc) -> {root, video}|null, isAd(root),
//                        nativeCaptionCss, navEvents: [{target:'document'|'window', name}],
//                        seek?(video, t, {play, lessonId, gen}) -> boolean, cancelSeek?() } | null
// seek is optional: missing or false -> the engine sets video.currentTime itself (YouTube, Udemy);
// true -> the adapter did the seek (Netflix: through the MAIN-world hook, never video.currentTime).
// Everything here only reads the document / window it is handed, so it runs under node --test with fakes
// (tests/web/site.test.js).
import { lessonIdFromUrl, adShowing } from './overlay-state.js';

const ON_CLASS = 'ytlearn-on'; // overlay.js puts it on the player root while the overlay is on
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/; // a bare YouTube video id (overlay-state.js ID_RE)

/* ---------- YouTube ---------- */

// The watch page's video id; null while the URL and ytd-watch-flexy[video-id] disagree (mid-navigation).
export function youtubeLessonId(url, doc) {
  const flexy = doc && doc.querySelector('ytd-watch-flexy');
  const attr = flexy ? flexy.getAttribute('video-id') : null;
  const id = lessonIdFromUrl(url, attr);
  return id && YT_ID_RE.test(id) ? id : null; // YouTube ids only (udemy.<id> / netflix.<id> are other sites)
}

export function youtubeFindPlayer(doc) {
  const root = doc && doc.getElementById('movie_player');
  const video = root && (root.querySelector('video.html5-main-video') || root.querySelector('video'));
  return root && video ? { root, video } : null;
}

export const youtube = Object.freeze({
  name: 'youtube',
  lessonId: youtubeLessonId,
  findPlayer: youtubeFindPlayer,
  isAd: (root) => !!root && adShowing(root.classList),
  nativeCaptionCss: '#movie_player.' + ON_CLASS + ' .ytp-caption-window-container{opacity:0 !important;pointer-events:none !important}',
  navEvents: Object.freeze([Object.freeze({ target: 'document', name: 'yt-navigate-finish' })]),
});

/* ---------- Udemy (lecture pages, Shaka player) ---------- */

const SHAKA = '[data-purpose="shaka-video-player"]';

export function udemyLessonId(url) {
  const id = lessonIdFromUrl(url);
  return id && id.startsWith('udemy.') ? id : null;
}

// Udemy replaces the whole <video> on a lecture change; the engine compares {root, video} identity.
export function udemyFindPlayer(doc) {
  const root = doc && doc.querySelector(SHAKA);
  const video = root && root.querySelector('video');
  return root && video ? { root, video } : null;
}

export const udemy = Object.freeze({
  name: 'udemy',
  lessonId: (url) => udemyLessonId(url),
  findPlayer: udemyFindPlayer,
  isAd: () => false,
  // Udemy draws its own cues in div._caption-container_<hash>; the hash changes, the prefix does not.
  nativeCaptionCss: SHAKA + '.' + ON_CLASS + ' [class*="caption-container"]{opacity:0}',
  navEvents: Object.freeze([]),
});

/* ---------- Netflix (watch pages; MAIN-world hook netflix-hook.js does the seeking) ---------- */

const NF_ORIGIN = 'https://www.netflix.com';
const NF_ROOT = '.watch-video--player-view'; // absolute, fills the window, inside the fullscreen element .watch-video
export const NF_SEEK_ACK_MS = 1000;

export function netflixLessonId(url) {
  const id = lessonIdFromUrl(url);
  return id && id.startsWith('netflix.') ? id : null;
}

export function netflixFindPlayer(doc) {
  const root = doc && doc.querySelector(NF_ROOT);
  const video = root && root.querySelector('video');
  return root && video ? { root, video } : null;
}

// Minimal caller-side check of the hook's ytlearn:nf-seek-ack (the full one, ytLearnNfValidateSeekAck in
// netflix-manifest.js, is an IIFE for the isolated/MAIN worlds; overlay.js only dynamic-imports ES modules).
export function seekAckOk(msg, requestId) {
  return !!msg && typeof msg === 'object' && msg.type === 'ytlearn:nf-seek-ack' && msg.requestId === requestId && typeof msg.ok === 'boolean';
}

// One pending ytlearn:nf-seek at a time, bound to {lessonId, gen, video}. A new seek, cancel() (teardown,
// episode change, switch-off) or the 1 s timeout drops it: listener removed, timer cleared, a late ack ignored.
// The ack only gets logged (ok:false / timeout); the engine redraws from the video's own seeked event.
// env = { win, log, setTimeout, clearTimeout } (injectable for tests).
export function netflixSeeker(env) {
  const win = env.win;
  const log = env.log || (() => { });
  const setT = env.setTimeout || setTimeout;
  const clearT = env.clearTimeout || clearTimeout;
  let seq = 0;
  let pending = null; // { requestId, lessonId, gen, video, timer, onMsg }

  function cancel() {
    const p = pending;
    if (!p) return;
    pending = null;
    clearT(p.timer);
    win.removeEventListener('message', p.onMsg);
  }

  function seek(video, t, { play, lessonId, gen } = {}) {
    cancel();
    // Always true: whatever happens, the engine must not fall back to video.currentTime on Netflix.
    if (typeof lessonId !== 'string' || !/^netflix\.[0-9]{1,12}$/.test(lessonId)) { log('nf-seek:bad-lesson', String(lessonId)); return true; }
    const requestId = 'seek-' + Date.now().toString(36) + '-' + (++seq);
    const p = { requestId, lessonId, gen, video, timer: null, onMsg: null };
    p.onMsg = (ev) => {
      if (pending !== p || !ev || ev.source !== win || ev.origin !== NF_ORIGIN) return;
      if (!seekAckOk(ev.data, requestId)) return;
      cancel();
      if (!ev.data.ok) log('nf-seek:failed', lessonId, String(ev.data.error || ''));
    };
    p.timer = setT(() => { if (pending === p) { cancel(); log('nf-seek:timeout', lessonId); } }, NF_SEEK_ACK_MS);
    pending = p;
    win.addEventListener('message', p.onMsg);
    win.postMessage({
      type: 'ytlearn:nf-seek', requestId, expectedMovieId: lessonId.slice('netflix.'.length),
      ms: Math.round(Math.max(0, t) * 1000), play: play === true,
    }, NF_ORIGIN);
    return true;
  }

  return { seek, cancel, pending: () => (pending ? { requestId: pending.requestId, lessonId: pending.lessonId, gen: pending.gen, video: pending.video } : null) };
}

let nfSeeker = null;
const defaultSeeker = () => nfSeeker || (nfSeeker = netflixSeeker({ win: globalThis.window, log: (...a) => console.log('[yt-learn]', ...a) }));

export const netflix = Object.freeze({
  name: 'netflix',
  lessonId: (url) => netflixLessonId(url),
  findPlayer: netflixFindPlayer,
  isAd: () => false,
  nativeCaptionCss: NF_ROOT + '.' + ON_CLASS + ' .player-timedtext{opacity:0 !important}', // Netflix sets inline styles on these nodes
  // pushState episode changes fire nothing; the engine's 1 s route poll catches them.
  navEvents: Object.freeze([Object.freeze({ target: 'window', name: 'popstate' })]),
  // Never video.currentTime on Netflix (it trips error M7375): the hook calls the player API instead.
  seek: (video, t, ctx) => defaultSeeker().seek(video, t, ctx),
  cancelSeek: () => { if (nfSeeker) nfSeeker.cancel(); },
});

export function siteFor(hostname) {
  if (hostname === 'www.youtube.com') return youtube;
  if (hostname === 'www.udemy.com') return udemy;
  if (hostname === 'www.netflix.com') return netflix;
  return null;
}
