// Site adapters for the overlay engine (extension/overlay.js dynamic-imports this file).
// siteFor(hostname) -> { name, lessonId(url, doc), findPlayer(doc) -> {root, video}|null, isAd(root),
//                        nativeCaptionCss, navEvents } | null
// Everything here only reads the document it is handed, so it runs under node --test with a fake doc
// (tests/web/site.test.js).
import { lessonIdFromUrl, adShowing } from './overlay-state.js';

const ON_CLASS = 'ytlearn-on'; // overlay.js puts it on the player root while the overlay is on

/* ---------- YouTube ---------- */

// The watch page's video id; null while the URL and ytd-watch-flexy[video-id] disagree (mid-navigation).
export function youtubeLessonId(url, doc) {
  const flexy = doc && doc.querySelector('ytd-watch-flexy');
  const attr = flexy ? flexy.getAttribute('video-id') : null;
  const id = lessonIdFromUrl(url, attr);
  return id && !id.startsWith('udemy.') ? id : null;
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
  navEvents: Object.freeze(['yt-navigate-finish']),
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

export function siteFor(hostname) {
  if (hostname === 'www.youtube.com') return youtube;
  if (hostname === 'www.udemy.com') return udemy;
  return null;
}
