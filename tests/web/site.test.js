// extension/site.js: the per-site adapters the overlay engine uses. Pure over a fake document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteFor, youtube, udemy } from '../../extension/site.js';

const A = 'puh91fohvTA';
const B = 'abcdefghijk';
const LURL = 'https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738?start=0#overview';

// Minimal fake DOM: elements answer querySelector by exact selector string from a map.
function elem(sel = {}, attrs = {}, classes = []) {
  return {
    querySelector: (q) => sel[q] || null,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    classList: classes,
  };
}
function doc({ byId = {}, sel = {} } = {}) {
  return { getElementById: (id) => byId[id] || null, querySelector: (q) => sel[q] || null };
}

test('siteFor: www.youtube.com and www.udemy.com only', () => {
  assert.equal(siteFor('www.youtube.com'), youtube);
  assert.equal(siteFor('www.udemy.com'), udemy);
  for (const h of ['youtube.com', 'm.youtube.com', 'udemy.com', 'mycompany.udemy.com', '127.0.0.1', '', undefined]) {
    assert.equal(siteFor(h), null, String(h));
  }
  assert.equal(youtube.name, 'youtube');
  assert.equal(udemy.name, 'udemy');
});

test('youtube.lessonId: URL id, null when ytd-watch-flexy[video-id] disagrees, null for Udemy URLs', () => {
  const W = 'https://www.youtube.com/watch?v=' + A;
  assert.equal(youtube.lessonId(W, doc()), A, 'no flexy yet');
  assert.equal(youtube.lessonId(W, doc({ sel: { 'ytd-watch-flexy': elem({}, { 'video-id': A }) } })), A);
  assert.equal(youtube.lessonId(W, doc({ sel: { 'ytd-watch-flexy': elem({}, {}) } })), A, 'attribute absent');
  assert.equal(youtube.lessonId(W, doc({ sel: { 'ytd-watch-flexy': elem({}, { 'video-id': B }) } })), null, 'mid-navigation');
  assert.equal(youtube.lessonId('https://www.youtube.com/feed/subscriptions', doc()), null);
  assert.equal(youtube.lessonId(LURL, doc()), null);
});

test('youtube.findPlayer: #movie_player + video.html5-main-video, falling back to any video', () => {
  const main = { tag: 'main' };
  const other = { tag: 'other' };
  const root = elem({ 'video.html5-main-video': main, video: other });
  assert.deepEqual(youtube.findPlayer(doc({ byId: { movie_player: root } })), { root, video: main });
  const root2 = elem({ video: other });
  assert.deepEqual(youtube.findPlayer(doc({ byId: { movie_player: root2 } })), { root: root2, video: other });
  assert.equal(youtube.findPlayer(doc({ byId: { movie_player: elem() } })), null, 'no video');
  assert.equal(youtube.findPlayer(doc()), null, 'no player');
});

test('youtube.isAd: ad-showing / ad-interrupting on the root', () => {
  assert.equal(youtube.isAd(elem({}, {}, ['html5-video-player', 'ad-showing'])), true);
  assert.equal(youtube.isAd(elem({}, {}, ['html5-video-player', 'ad-interrupting'])), true);
  assert.equal(youtube.isAd(elem({}, {}, ['html5-video-player', 'playing-mode'])), false);
  assert.equal(youtube.isAd(null), false);
});

test('youtube: native caption rule and navigation event are the pre-adapter ones', () => {
  assert.equal(youtube.nativeCaptionCss,
    '#movie_player.ytlearn-on .ytp-caption-window-container{opacity:0 !important;pointer-events:none !important}');
  assert.deepEqual([...youtube.navEvents], ['yt-navigate-finish']);
});

test('udemy.lessonId: lecture URLs -> udemy.<id>, everything else null', () => {
  assert.equal(udemy.lessonId(LURL, doc()), 'udemy.5800738');
  assert.equal(udemy.lessonId('https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738/'), 'udemy.5800738');
  for (const u of ['https://www.udemy.com/course/30-days-of-python/', 'https://www.udemy.com/course/x/learn/quiz/1',
    'https://mycompany.udemy.com/course/x/learn/lecture/1', 'https://www.youtube.com/watch?v=' + A, '', undefined]) {
    assert.equal(udemy.lessonId(u, doc()), null, String(u));
  }
});

test('udemy.findPlayer: shaka root and its first video; null if either is missing', () => {
  const SHAKA = '[data-purpose="shaka-video-player"]';
  const v = { tag: 'video' };
  const root = elem({ video: v });
  assert.deepEqual(udemy.findPlayer(doc({ sel: { [SHAKA]: root } })), { root, video: v });
  assert.equal(udemy.findPlayer(doc({ sel: { [SHAKA]: elem() } })), null);
  assert.equal(udemy.findPlayer(doc({ sel: { video: v } })), null, 'a video outside the player does not count');
});

test('udemy: never an ad, hides its own caption container, no navigation events (the poll is the router)', () => {
  assert.equal(udemy.isAd(elem({}, {}, ['ad-showing'])), false);
  assert.equal(udemy.nativeCaptionCss, '[data-purpose="shaka-video-player"].ytlearn-on [class*="caption-container"]{opacity:0}');
  assert.deepEqual([...udemy.navEvents], []);
});
