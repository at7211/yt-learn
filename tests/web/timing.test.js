import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cueIndexAt, flattenHits, activeHitAt, panelState, seenCount,
} from '../../web/timing.js';

// Tiny hand-built lesson.
//   cue0 [0.2, 1.5)  words 0-2   "Hello big world"
//   silence [1.5, 2.0)
//   cue1 [2.0, 3.5)  words 3-5   "run your mouth"
//   cue2 [3.5, 4.5)  words 6-7   "now please"   (word 7 untimed)
//   silence [4.5, 5.0)
//   cue3 [5.0, 6.0)  words 8-9   "hello again"
const words = [
  { t: 0.2, e: 0.5, w: 'Hello', timed: true },
  { t: 0.5, e: 1.0, w: 'big', timed: true },
  { t: 1.0, e: 1.5, w: 'world', timed: true },
  { t: 2.0, e: 2.5, w: 'run', timed: true },
  { t: 2.5, e: 3.0, w: 'your', timed: true },
  { t: 3.0, e: 3.5, w: 'mouth', timed: true },
  { t: 3.5, e: 4.0, w: 'now', timed: true },
  { t: 4.0, e: 4.5, w: 'please', timed: false },
  { t: 5.0, e: 5.5, w: 'hello', timed: true },
  { t: 5.5, e: 6.0, w: 'again', timed: true },
];
const cues = [
  { a: 0, b: 2, en: 'Hello big world', tokens: ['Hello', 'big', 'world'], zh: '你好大世界' },
  { a: 3, b: 5, en: 'run your mouth', tokens: ['run', 'your', 'mouth'], zh: '亂講話' },
  { a: 6, b: 7, en: 'now please', tokens: ['now', 'please'], zh: '現在拜託' },
  { a: 8, b: 9, en: 'hello again', tokens: ['hello', 'again'], zh: '又是你好' },
];
const vocab = [
  { id: 0, term: 'big world', pos: 'phr.', ipa: null, zh: '大世界', hits: [{ cue: 0, a: 1, b: 2 }] },
  { id: 1, term: 'hello', pos: 'int.', ipa: null, zh: '你好', hits: [{ cue: 0, a: 0, b: 0 }, { cue: 3, a: 8, b: 8 }] },
  { id: 2, term: 'run your mouth', pos: 'idiom', ipa: null, zh: '亂講話', hits: [{ cue: 1, a: 3, b: 5 }] },
  { id: 3, term: 'your', pos: 'pron.', ipa: null, zh: '你的', hits: [{ cue: 1, a: 4, b: 4 }] },
  { id: 4, term: 'please', pos: 'adv.', ipa: null, zh: '拜託', hits: [{ cue: 2, a: 7, b: 7 }] },
];
const flat = flattenHits(vocab, words);
const ids = (h) => (h ? [h.vocabId, h.hitIdx] : null);

test('flattenHits_sorted_by_start', () => {
  assert.deepEqual(flat.map((h) => [h.vocabId, h.hitIdx]), [[1, 0], [0, 0], [2, 0], [3, 0], [4, 0], [1, 1]]);
  assert.deepEqual(flat[2], { vocabId: 2, hitIdx: 0, cue: 1, a: 3, b: 5, start: 2.0 });
});

test('cueIndexAt_boundaries_inclusive_start_exclusive_end', () => {
  assert.equal(cueIndexAt(cues, words, 0.2), 0);
  assert.equal(cueIndexAt(cues, words, 1.49), 0);
  assert.equal(cueIndexAt(cues, words, 1.5), -1);
  assert.equal(cueIndexAt(cues, words, 2.0), 1);
  assert.equal(cueIndexAt(cues, words, 3.5), 2);
  assert.equal(cueIndexAt(cues, words, 5.999), 3);
  assert.equal(cueIndexAt(cues, words, 6.0), -1);
});

test('cueIndexAt_silence_returns_minus_one', () => {
  assert.equal(cueIndexAt(cues, words, 0), -1);
  assert.equal(cueIndexAt(cues, words, 1.7), -1);
  assert.equal(cueIndexAt(cues, words, 4.7), -1);
  assert.equal(cueIndexAt(cues, words, 100), -1);
  assert.equal(cueIndexAt([], [], 1), -1);
});

test('activeHitAt_only_during_hit_interval', () => {
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 0.3)), [1, 0]);
  // same cue, "hello" has ended: only "big world" lights, not "hello"
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 0.5)), [0, 0]);
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 1.2)), [0, 0]);
  assert.equal(activeHitAt(flat, cues, words, 0.1), null);
  assert.equal(activeHitAt(flat, cues, words, 1.5), null);
  assert.equal(activeHitAt(flat, cues, words, 1.8), null);
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 5.2)), [1, 1]);
  assert.equal(activeHitAt(flat, cues, words, 5.6), null); // "again" is not vocab
});

test('activeHitAt_untimed_uses_cue_span', () => {
  // "please" (untimed) lights for the whole cue2 [3.5, 4.5)
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 3.5)), [4, 0]);
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 3.7)), [4, 0]);
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 4.4)), [4, 0]);
  assert.equal(activeHitAt(flat, cues, words, 4.5), null);
});

test('activeHitAt_overlap_later_start_wins', () => {
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 2.2)), [2, 0]);
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 2.5)), [3, 0]);
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 2.9)), [3, 0]);
  assert.deepEqual(ids(activeHitAt(flat, cues, words, 3.0)), [2, 0]);
});

test('panelState_before_first_hit', () => {
  assert.deepEqual(panelState(flat, words, 0.1), { current: -1, rows: [0, 1, 2, 3, 4] });
  const three = flat.slice(0, 3);
  assert.deepEqual(panelState(three, words, 0), { current: -1, rows: [0, 1, 2] });
});

test('panelState_centered_and_clamped', () => {
  assert.deepEqual(panelState(flat, words, 0.2), { current: 0, rows: [0, 1, 2, 3, 4] });
  assert.deepEqual(panelState(flat, words, 2.1), { current: 2, rows: [0, 1, 2, 3, 4] });
  assert.deepEqual(panelState(flat, words, 2.6), { current: 3, rows: [1, 2, 3, 4, 5] });
  assert.deepEqual(panelState(flat, words, 4.1), { current: 4, rows: [1, 2, 3, 4, 5] });
  assert.deepEqual(panelState(flat, words, 99), { current: 5, rows: [1, 2, 3, 4, 5] });
  // current stays on the last started hit through silence
  assert.deepEqual(panelState(flat, words, 1.8).current, 1);
  const three = flat.slice(0, 3);
  assert.deepEqual(panelState(three, words, 99), { current: 2, rows: [0, 1, 2] });
});

test('seenCount_decreases_after_backward_seek', () => {
  assert.equal(seenCount(flat, words, 0.1), 0);
  assert.equal(seenCount(flat, words, 0.3), 1);
  assert.equal(seenCount(flat, words, 5.2), 5); // "hello" twice counts once
  assert.equal(seenCount(flat, words, 2.6), 4); // after seeking back
  assert.equal(seenCount(flat, words, 0.6), 2);
});

test('zero_vocab_everything_empty', () => {
  const none = flattenHits([], words);
  assert.deepEqual(none, []);
  assert.equal(activeHitAt(none, cues, words, 0.3), null);
  assert.deepEqual(panelState(none, words, 0.3), { current: -1, rows: [] });
  assert.equal(seenCount(none, words, 99), 0);
});
