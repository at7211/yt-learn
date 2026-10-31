import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  watchVideoId, lessonIdFromUrl, initialState, tokenOf, isStale, navigate, toggle, markMounted, markBuilding, markIdle,
  pillText, jobPhase, OWN_KEYS, isEditable, keyAction, adShowing, cueForNav, cueSeekTarget,
} from '../../extension/overlay-state.js';

const A = 'puh91fohvTA';
const B = 'abcdefghijk';
const W = (id, extra = '') => 'https://www.youtube.com/watch?v=' + id + extra;

test('watchVideoId: watch pages only, flexy attribute must agree', () => {
  assert.equal(watchVideoId(W(A)), A);
  assert.equal(watchVideoId(W(A, '&t=42s&list=PL1')), A);
  assert.equal(watchVideoId(W(A), A), A);
  assert.equal(watchVideoId(W(A), ''), A);
  assert.equal(watchVideoId(W(A), null), A);
  assert.equal(watchVideoId(W(A), B), null, 'URL and ytd-watch-flexy disagree mid-navigation');
  for (const bad of ['https://www.youtube.com/', 'https://www.youtube.com/shorts/' + A, 'https://www.youtube.com/embed/' + A,
    'https://m.youtube.com/watch?v=' + A, 'http://www.youtube.com/watch?v=' + A, 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch', 'not a url', '', undefined]) {
    assert.equal(watchVideoId(bad), null, String(bad));
  }
});

test('navigate: first watch page does not auto-mount while off', () => {
  const r = navigate(initialState(), A);
  assert.equal(r.state.videoId, A);
  assert.equal(r.state.gen, 1);
  assert.equal(r.autoload, false);
  assert.equal(r.teardown, false);
  const same = navigate(r.state, A);
  assert.equal(same.state, r.state, 'same id is a no-op');
  assert.equal(same.teardown, false);
});

test('toggle: on -> load, mounted -> teardown and explicit off; nothing off a watch page', () => {
  assert.equal(toggle(initialState()).action, 'none');
  let s = navigate(initialState(), A).state;
  const t1 = toggle(s);
  assert.equal(t1.action, 'load');
  assert.equal(t1.state.on, true);
  assert.equal(t1.state.gen, s.gen + 1);
  s = markMounted(t1.state, tokenOf(t1.state));
  assert.equal(s.mounted, true);
  const t2 = toggle(s);
  assert.equal(t2.action, 'teardown');
  assert.equal(t2.state.on, false);
  assert.equal(t2.state.mounted, false);
  // toggling while a build is being watched also turns it off
  const b = markBuilding(toggle(t2.state).state, tokenOf(toggle(t2.state).state));
  assert.equal(b.building, true);
  assert.equal(toggle(b).action, 'teardown');
});

test('stale replies are rejected: after toggle, after navigation, for the wrong video', () => {
  let s = toggle(navigate(initialState(), A).state).state;
  const tok = tokenOf(s);
  assert.equal(isStale(s, tok), false);
  assert.equal(isStale(s, null), true);
  assert.equal(isStale(s, { videoId: B, gen: tok.gen }), true);
  const off = toggle(markMounted(s, tok)).state;
  assert.equal(isStale(off, tok), true);
  assert.equal(markMounted(off, tok), off, 'a late lesson reply cannot re-mount after the user turned it off');
  assert.equal(markBuilding(off, tok), off);
  assert.equal(markIdle(off, tok), off);
  const moved = navigate(s, B).state;
  assert.equal(isStale(moved, tok), true);
  assert.equal(markMounted(moved, tok).mounted, false);
});

test('A -> B -> A: on persists, every navigation tears down and invalidates older work', () => {
  let s = navigate(initialState(), A).state;
  s = toggle(s).state;
  const tokA1 = tokenOf(s);
  s = markMounted(s, tokA1);
  const toB = navigate(s, B);
  assert.equal(toB.teardown, true);
  assert.equal(toB.autoload, true, 'overlay was on: try the next video');
  assert.equal(toB.state.mounted, false);
  const tokB = tokenOf(toB.state);
  const backA = navigate(toB.state, A);
  assert.equal(backA.teardown, true);
  assert.equal(backA.autoload, true);
  assert.equal(isStale(backA.state, tokA1), true, 'the first visit to A is a different generation');
  assert.equal(isStale(backA.state, tokB), true);
  assert.equal(markMounted(backA.state, tokenOf(backA.state)).mounted, true);
});

test('explicit off persists across navigation', () => {
  let s = toggle(navigate(initialState(), A).state).state;
  s = markMounted(s, tokenOf(s));
  s = toggle(s).state; // user turns it off
  const r = navigate(s, B);
  assert.equal(r.autoload, false);
  assert.equal(navigate(r.state, A).autoload, false);
});

test('leaving the watch page tears down and never autoloads', () => {
  let s = toggle(navigate(initialState(), A).state).state;
  s = markMounted(s, tokenOf(s));
  const r = navigate(s, null);
  assert.equal(r.teardown, true);
  assert.equal(r.autoload, false);
  assert.equal(r.state.videoId, null);
  assert.equal(r.state.on, true, 'intent kept for the next watch page');
  assert.equal(navigate(r.state, B).autoload, true);
});

test('markIdle clears mounted/building for the current token', () => {
  let s = toggle(navigate(initialState(), A).state).state;
  const tok = tokenOf(s);
  s = markBuilding(s, tok);
  s = markIdle(s, tok);
  assert.equal(s.building, false);
  assert.equal(s.mounted, false);
  assert.equal(toggle(s).action, 'load', 'after a failed build the next click retries');
});

test('pillText follows 擷取字幕 → 產生課程 x% → 完成', () => {
  assert.equal(pillText(null), 'yt-learn：擷取字幕…');
  assert.equal(pillText({ state: 'queued' }), 'yt-learn：擷取字幕…');
  assert.equal(pillText({ state: 'capturing' }), 'yt-learn：擷取字幕…');
  assert.equal(pillText({ state: 'captured' }), 'yt-learn：產生課程…');
  assert.equal(pillText({ state: 'building' }), 'yt-learn：產生課程…');
  assert.equal(pillText({ state: 'building', progress: { phase: 'segment', done: 3, total: 8 } }), 'yt-learn：產生課程 38%');
  assert.equal(pillText({ state: 'building', progress: { phase: 'x', done: 9, total: 8 } }), 'yt-learn：產生課程 100%');
  assert.equal(pillText({ state: 'building', progress: { phase: 'x', done: 1, total: 0 } }), 'yt-learn：產生課程…');
  assert.equal(pillText({ state: 'done' }), 'yt-learn：完成');
  assert.equal(pillText({ state: 'error', message: '找不到英文字幕' }), 'yt-learn：找不到英文字幕');
  assert.equal(pillText({ state: 'error', message: '' }), 'yt-learn：產課失敗');
});

test('jobPhase', () => {
  assert.equal(jobPhase(null), 'poll');
  assert.equal(jobPhase({ state: 'building' }), 'poll');
  assert.equal(jobPhase({ state: 'done' }), 'done');
  assert.equal(jobPhase({ state: 'error' }), 'error');
});

const key = (code, extra = {}) => ({ code, key: 'x', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, ...extra });
const el = (tagName, attrs = {}, isContentEditable = false) => ({ tagName, isContentEditable, getAttribute: (n) => (n in attrs ? attrs[n] : null) });

test('keyAction: only our keys, only while active', () => {
  assert.deepEqual(Object.keys(OWN_KEYS).sort(), ['BracketLeft', 'BracketRight', 'KeyE', 'KeyR', 'KeyV', 'KeyZ']);
  const on = { active: true, path: [el('DIV'), el('BODY')] };
  assert.equal(keyAction(key('KeyZ'), on), 'zh');
  assert.equal(keyAction(key('KeyE'), on), 'en');
  assert.equal(keyAction(key('KeyV'), on), 'vocab');
  assert.equal(keyAction(key('KeyR'), on), 'replay');
  assert.equal(keyAction(key('BracketLeft'), on), 'prev');
  assert.equal(keyAction(key('BracketRight'), on), 'next');
  assert.equal(keyAction(key('KeyZ', { key: 'Process' }), on), 'zh', 'IME on: matched by physical key');
  for (const yt of ['Space', 'ArrowLeft', 'ArrowRight', 'KeyF', 'KeyC', 'KeyK', 'KeyJ', 'KeyL', 'KeyM', 'KeyT']) {
    assert.equal(keyAction(key(yt), on), null, yt + ' stays YouTube\'s');
  }
  assert.equal(keyAction(key('KeyZ'), { active: false }), null);
  assert.equal(keyAction(key('KeyZ')), null);
  assert.equal(keyAction(null, on), null);
});

test('keyAction: modifiers, composition, repeat and editable targets are ignored', () => {
  const on = { active: true };
  for (const m of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'isComposing', 'repeat']) {
    assert.equal(keyAction(key('KeyZ', { [m]: true }), on), null, m);
  }
  const editables = [el('INPUT'), el('textarea'), el('SELECT'), el('DIV', {}, true), el('DIV', { contenteditable: '' }),
    el('DIV', { contenteditable: 'true' }), el('DIV', { contenteditable: 'plaintext-only' })];
  for (const target of editables) {
    assert.equal(keyAction(key('KeyE'), { active: true, path: [el('SPAN'), target, el('BODY')] }), null, JSON.stringify(target));
  }
  assert.equal(keyAction(key('KeyE'), { active: true, path: [el('DIV', { contenteditable: 'false' }), {}, null, 'x'] }), 'en');
});

test('isEditable', () => {
  assert.equal(isEditable(null), false);
  assert.equal(isEditable({}), false);
  assert.equal(isEditable(el('BUTTON')), false);
  assert.equal(isEditable(el('INPUT')), true);
});

test('adShowing from className, classList-like or array', () => {
  assert.equal(adShowing('html5-video-player ytp-autohide playing-mode'), false);
  assert.equal(adShowing('html5-video-player ad-showing'), true);
  assert.equal(adShowing('html5-video-player ad-interrupting ytp-autohide'), true);
  assert.equal(adShowing(new Set(['ad-showing'])), true);
  assert.equal(adShowing(['ad-created']), false, 'ad-created alone is not an ad playing');
  assert.equal(adShowing(['x']), false);
  assert.equal(adShowing(null), false);
  assert.equal(adShowing(undefined), false);
});

test('cue navigation targets', () => {
  const words = [{ t: 1, e: 2 }, { t: 2, e: 3 }, { t: 5, e: 6 }, { t: 9, e: 10 }];
  const cues = [{ a: 0, b: 1 }, { a: 2, b: 2 }, { a: 3, b: 3 }];
  assert.equal(cueForNav(cues, words, 0), -1);
  assert.equal(cueForNav(cues, words, 4), 0, 'silence after cue 0 still counts as cue 0');
  assert.equal(cueForNav(cues, words, 9.5), 2);
  assert.equal(cueSeekTarget(cues, words, 0, 'replay'), 0);
  assert.equal(cueSeekTarget(cues, words, 0, 'next'), 1);
  assert.equal(cueSeekTarget(cues, words, 0, 'prev'), 1);
  assert.equal(cueSeekTarget(cues, words, 5.5, 'replay'), 5);
  assert.equal(cueSeekTarget(cues, words, 5.5, 'prev'), 1);
  assert.equal(cueSeekTarget(cues, words, 5.5, 'next'), 9);
  assert.equal(cueSeekTarget(cues, words, 9.5, 'next'), 9, 'clamped at the last cue');
  assert.equal(cueSeekTarget(cues, words, 9.5, 'zh'), null);
  assert.equal(cueSeekTarget([], [], 3, 'replay'), null);
});

/* ---------- lesson ids from either site; player identity (token) ---------- */

const L = 'https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738';

test('lessonIdFromUrl: YouTube watch pages and Udemy lecture pages; watchVideoId is the same function', () => {
  assert.equal(watchVideoId, lessonIdFromUrl);
  assert.equal(lessonIdFromUrl(W(A)), A);
  assert.equal(lessonIdFromUrl(W(A), B), null);
  assert.equal(lessonIdFromUrl(L), 'udemy.5800738');
  assert.equal(lessonIdFromUrl(L + '?start=0#overview'), 'udemy.5800738');
  assert.equal(lessonIdFromUrl(L + '/'), 'udemy.5800738');
  assert.equal(lessonIdFromUrl(L, 'ignored-for-udemy'), 'udemy.5800738');
  for (const bad of ['https://www.udemy.com/course/30-days-of-python/', 'http://www.udemy.com/course/x/learn/lecture/1',
    'https://mycompany.udemy.com/course/x/learn/lecture/1', 'https://www.udemy.com/course/x/learn/quiz/1',
    'https://www.udemy.com/course/x/learn/lecture/1234567890123', 'https://www.udemy.com/course/x/learn/lecture/1/extra', 'udemy.5800738']) {
    assert.equal(lessonIdFromUrl(bad), null, bad);
  }
});

test('lessonIdFromUrl agrees with the shared fixture for Udemy lecture URLs', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/lesson_ids.json', import.meta.url), 'utf8'));
  for (const [input, want] of fx.udemyUrl) {
    if (input.startsWith('https://www.youtube.com/')) continue; // a YouTube id, not a Udemy one
    assert.equal(lessonIdFromUrl(input), want ? 'udemy.' + want[1] : null, input);
  }
});

test('navigate: same id with a different player token resets gen, tears down, and autoloads when on', () => {
  let s = navigate(initialState(), 'udemy.1', 0).state;
  assert.equal(s.token, 0);
  s = toggle(s).state;
  const tok = tokenOf(s);
  s = markMounted(s, tok);
  assert.equal(navigate(s, 'udemy.1', 0).state, s, 'same id, same player: no-op');
  const r = navigate(s, 'udemy.1', 1);
  assert.equal(r.state.videoId, 'udemy.1');
  assert.equal(r.state.token, 1);
  assert.equal(r.state.gen, s.gen + 1);
  assert.equal(r.state.mounted, false);
  assert.equal(r.teardown, true);
  assert.equal(r.autoload, true, 'remount on the new <video>');
  assert.equal(isStale(r.state, tok), true, 'work bound to the old player is stale');
  // off: a replaced player tears down but does not autoload
  const off = toggle(markMounted(r.state, tokenOf(r.state))).state;
  const r2 = navigate(off, 'udemy.1', 2);
  assert.equal(r2.autoload, false);
  assert.equal(r2.state.gen, off.gen + 1);
});

test('navigate: the token is ignored off a lesson page; no token behaves as before', () => {
  const s = initialState();
  assert.equal(navigate(s, null, 5).state, s);
  const a = navigate(s, A).state;
  assert.equal(a.token, null);
  assert.equal(navigate(a, A).state, a);
  assert.equal(navigate(a, A, undefined).state, a);
  const away = navigate(a, null, 3).state;
  assert.equal(away.videoId, null);
  assert.equal(navigate(away, null, 4).state, away);
});
