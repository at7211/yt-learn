import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WORDS, POLL_MS, POLL_LIMIT_MS, TIMEOUT_TEXT, spanRange, phraseText, noteKey, dragKind, noteList, noteAtWord,
  notedWords, noteFor, cardSections, explainOutcome, runExplain, unionRect, placeAbove, cardNodes, noteRowNodes, LOADING_TEXT,
} from '../../web/phrase.js';
import { readFileSync } from 'node:fs';

const CUE = { a: 10, b: 15, tokens: ["wouldn't", 'it', 'be', 'great', 'to', 'know?'], en: "wouldn't it be great to know?" };

test('spanRange: sorts, clamps into the cue, caps the length at the far end', () => {
  assert.deepEqual(spanRange(CUE, 12, 14), { a: 12, b: 14 });
  assert.deepEqual(spanRange(CUE, 14, 12), { a: 12, b: 14 });
  assert.deepEqual(spanRange(CUE, 13, 13), { a: 13, b: 13 });
  assert.deepEqual(spanRange(CUE, 3, 99), { a: 10, b: 15 });
  assert.deepEqual(spanRange(CUE, 10, 15, 3), { a: 10, b: 12 }, 'anchor 10, far end gives way');
  assert.deepEqual(spanRange(CUE, 15, 10, 3), { a: 13, b: 15 });
  const long = { a: 0, b: 99, tokens: [] };
  const r = spanRange(long, 0, 99);
  assert.equal(r.b - r.a + 1, MAX_WORDS);
  assert.equal(spanRange(null, 1, 2), null);
  assert.equal(spanRange(CUE, 'x', 2), null);
  assert.equal(spanRange({ a: 5, b: 2 }, 3, 4), null);
});

test('phraseText: the cue tokens a..b joined by one space (what the server checks)', () => {
  assert.equal(phraseText(CUE, 10, 13), "wouldn't it be great");
  assert.equal(phraseText(CUE, 15, 15), 'know?');
  assert.equal(phraseText(CUE, 9, 12), '');
  assert.equal(phraseText(CUE, 12, 11), '');
  assert.equal(phraseText(CUE, 14, 16), '');
  assert.equal(phraseText({ a: 0, b: 1 }, 0, 1), '');
});

test('noteKey', () => { assert.equal(noteKey(4, 7), '4-7'); });

test('dragKind: one word without leaving it = dict; two or more = phrase; away and back = nothing', () => {
  assert.equal(dragKind(3, 3, false), 'dict');
  assert.equal(dragKind(3, null, false), 'dict');
  assert.equal(dragKind(3, 5, true), 'phrase');
  assert.equal(dragKind(5, 3, true), 'phrase');
  assert.equal(dragKind(3, 3, true), null);
  assert.equal(dragKind(null, 3, true), null);
});

const note = (cue, a, b, phrase = 'p', extra = {}) => ({ phrase, cueEn: 'x', cue, a, b, result: { meaningZh: 'm' + a }, ts: 't', ...extra });

test('noteList: sorted by cue, start, length; malformed entries dropped', () => {
  const notes = { '12-13': note(1, 12, 13), '10-14': note(1, 10, 14), '10-11': note(1, 10, 11), '2-3': note(0, 2, 3),
    bad: { cue: 1 }, worse: null, reversed: note(1, 9, 8) };
  assert.deepEqual(noteList(notes).map((n) => n.a + '-' + n.b), ['2-3', '10-11', '10-14', '12-13']);
  assert.deepEqual(noteList(null), []);
  assert.deepEqual(noteList('x'), []);
});

test('noteAtWord / notedWords: the shortest note covering the word; covered words per cue', () => {
  const notes = { '10-14': note(1, 10, 14), '12-13': note(1, 12, 13), '20-21': note(2, 20, 21) };
  assert.equal(noteAtWord(notes, 1, 12).a, 12);
  assert.equal(noteAtWord(notes, 1, 11).a, 10);
  assert.equal(noteAtWord(notes, 1, 15), null);
  assert.equal(noteAtWord(notes, 2, 12), null, 'other cue');
  assert.deepEqual([...notedWords(notes, 1)].sort((x, y) => x - y), [10, 11, 12, 13, 14]);
  assert.deepEqual([...notedWords(notes, 3)], []);
});

test('noteFor: same range, cue and phrase only', () => {
  const notes = { '10-13': note(1, 10, 13, "wouldn't it be great") };
  assert.ok(noteFor(notes, 1, 10, 13, "wouldn't it be great"));
  assert.equal(noteFor(notes, 1, 10, 13, 'other'), null);
  assert.equal(noteFor(notes, 2, 10, 13, "wouldn't it be great"), null);
  assert.equal(noteFor(notes, 1, 10, 12, "wouldn't it be"), null);
  assert.equal(noteFor(null, 1, 10, 13, 'x'), null);
});

test('cardSections: fields in order, empty and malformed ones left out, alternatives use noteZh', () => {
  const s = cardSections({
    meaningZh: '意思', whyHere: '原因', pattern: 'figure sth out',
    examples: [{ en: 'A.', zh: '甲' }, { en: '', zh: 'x' }, null, { en: 'B.' }],
    alternatives: [{ en: 'C.', noteZh: '丙' }],
  });
  assert.deepEqual(s, [
    { label: '在這裡的意思', text: '意思' },
    { label: '為什麼這樣說', text: '原因' },
    { label: '可套用的句型', text: 'figure sth out' },
    { label: '其他例句', items: [{ en: 'A.', zh: '甲' }, { en: 'B.', zh: '' }] },
    { label: '類似說法', items: [{ en: 'C.', zh: '丙' }] },
  ]);
  assert.deepEqual(cardSections({ meaningZh: '  ', whyHere: 3, examples: 'x', alternatives: [] }), []);
  assert.deepEqual(cardSections(null), []);
});

const NOTE = note(1, 10, 13);

test('explainOutcome: the HTTP contract', () => {
  assert.deepEqual(explainOutcome({ status: 200, json: { ok: true, state: 'done', key: 'k', note: NOTE } }), { kind: 'done', note: NOTE });
  assert.deepEqual(explainOutcome({ status: 202, json: { ok: true, state: 'pending', key: 'abc' } }), { kind: 'pending', key: 'abc', warning: '' });
  assert.equal(explainOutcome({ status: 202, json: { state: 'pending', key: 'abc', warning: 'w' } }).warning, 'w');
  assert.deepEqual(explainOutcome({ status: 200, json: { state: 'error', error: 'AI 回覆失敗：x' } }, true), { kind: 'error', error: 'AI 回覆失敗：x' });
  assert.deepEqual(explainOutcome({ status: 404, json: { error: 'no such explain job' } }, true), { kind: 'gone' });
  assert.deepEqual(explainOutcome({ status: 404, json: { error: '找不到這部影片的課程' } }), { kind: 'error', error: '找不到這部影片的課程' });
  assert.equal(explainOutcome({ status: 402, json: { error: '本月…', code: 'budget' } }).kind, 'budget');
  assert.equal(explainOutcome({ status: 402, json: { error: 'x' } }).kind, 'error');
  assert.deepEqual(explainOutcome({ status: 429, json: { error: 'AI 正忙，稍後再試', code: 'busy' } }), { kind: 'busy', error: 'AI 正忙，稍後再試' });
  assert.equal(explainOutcome({ status: 409, json: { error: '選取的文字…', code: 'phrase', phrase: 'x' } }).kind, 'phrase');
  assert.deepEqual(explainOutcome({ status: 500, json: null }), { kind: 'error', error: 'HTTP 500' });
  assert.equal(explainOutcome({ status: 200, json: { ok: true } }).kind, 'error');
  assert.deepEqual(explainOutcome({ error: '本機 server 沒有回應' }), { kind: 'down', error: '本機 server 沒有回應' });
  assert.equal(explainOutcome(undefined).kind, 'down');
});

// A scripted server: replies are consumed in order per route; the clock moves only in sleep().
function harness(posts, polls, { cancelAfter = Infinity } = {}) {
  let t = 0;
  const log = [];
  let sleeps = 0;
  const io = {
    post: async (body) => { log.push(['post', body]); return posts.shift(); },
    poll: async (key) => { log.push(['poll', key]); return polls.shift(); },
    sleep: async (ms) => { log.push(['sleep', ms]); t += ms; sleeps++; },
    now: () => t,
    cancelled: () => sleeps >= cancelAfter,
  };
  return { io, log };
}
const P = (key = 'k1') => ({ status: 202, json: { ok: true, state: 'pending', key } });
const PP = (key = 'k1') => ({ status: 200, json: { ok: true, state: 'pending', key } });
const DONE = { status: 200, json: { ok: true, state: 'done', key: 'k1', note: NOTE } };
const BODY = { videoId: 'v', cue: 1, a: 10, b: 13, phrase: 'p', override: false };

test('runExplain: saved note answers at once, no polling', async () => {
  const { io, log } = harness([DONE], []);
  assert.deepEqual(await runExplain(io, BODY), { kind: 'done', note: NOTE });
  assert.deepEqual(log.map((x) => x[0]), ['post']);
});

test('runExplain: pending -> polls every POLL_MS with the key -> done', async () => {
  const pend = [];
  const { io, log } = harness([P()], [PP(), DONE]);
  io.onPending = (o) => pend.push(o.key);
  const r = await runExplain(io, BODY);
  assert.equal(r.kind, 'done');
  assert.deepEqual(log, [['post', BODY], ['sleep', POLL_MS], ['poll', 'k1'], ['sleep', POLL_MS], ['poll', 'k1']]);
  assert.deepEqual(pend, ['k1', 'k1']);
});

test('runExplain: a poll 404 re-POSTs the same body; the re-POST may answer done', async () => {
  const { io, log } = harness([P(), DONE], [{ status: 404, json: { ok: false, error: 'no such explain job' } }]);
  const r = await runExplain(io, BODY);
  assert.equal(r.kind, 'done');
  assert.deepEqual(log.map((x) => x[0]), ['post', 'sleep', 'poll', 'post']);
  assert.deepEqual(log[3][1], BODY);
});

test('runExplain: endless 404s give up after a few re-POSTs', async () => {
  const gone = { status: 404, json: {} };
  const { io, log } = harness([P(), P(), P(), P()], [gone, gone, gone, gone]);
  const r = await runExplain(io, BODY);
  assert.equal(r.kind, 'error');
  assert.equal(log.filter((x) => x[0] === 'post').length, 4);
});

test('runExplain: job error, budget, busy, phrase end the loop with that outcome', async () => {
  const err = harness([P()], [{ status: 200, json: { state: 'error', error: 'AI 回覆失敗：boom' } }]);
  assert.deepEqual(await runExplain(err.io, BODY), { kind: 'error', error: 'AI 回覆失敗：boom' });
  for (const [status, code] of [[402, 'budget'], [429, 'busy'], [409, 'phrase']]) {
    const h = harness([{ status, json: { ok: false, error: 'e', code } }], []);
    assert.equal((await runExplain(h.io, BODY)).kind, code);
    assert.equal(h.log.length, 1);
  }
});

test('runExplain: unreachable on the first POST fails at once; while polling three in a row', async () => {
  const first = harness([{ error: '本機 server 沒有回應' }], []);
  assert.deepEqual(await runExplain(first.io, BODY), { kind: 'error', error: '本機 server 沒有回應' });
  const down = { error: 'down' };
  const flaky = harness([P()], [down, down, PP(), down, DONE]);
  assert.equal((await runExplain(flaky.io, BODY)).kind, 'done', 'two misses then a pending reset the count');
  const dead = harness([P()], [down, down, down]);
  assert.deepEqual(await runExplain(dead.io, BODY), { kind: 'error', error: 'down' });
});

test('runExplain: stops after POLL_LIMIT_MS', async () => {
  const polls = Array.from({ length: 1000 }, () => PP());
  const { io, log } = harness([P()], polls);
  assert.deepEqual(await runExplain(io, BODY), { kind: 'error', error: TIMEOUT_TEXT });
  assert.equal(log.filter((x) => x[0] === 'poll').length, POLL_LIMIT_MS / POLL_MS);
});

test('runExplain: cancelled (card closed) stops polling without another request', async () => {
  const { io, log } = harness([P()], [PP(), PP(), DONE], { cancelAfter: 2 });
  assert.deepEqual(await runExplain(io, BODY), { kind: 'cancelled' });
  assert.deepEqual(log.map((x) => x[0]), ['post', 'sleep', 'poll', 'sleep']);
});

test('unionRect / placeAbove: box above the anchor, clamped inside the frame', () => {
  assert.equal(unionRect([]), null);
  assert.equal(unionRect([{ left: 1, top: 1, right: 1, bottom: 1 }]), null, 'zero-size rects (hidden) do not count');
  assert.deepEqual(unionRect([{ left: 10, top: 50, right: 30, bottom: 70 }, { left: 40, top: 48, right: 60, bottom: 72 }]),
    { left: 10, top: 48, right: 60, bottom: 72 });
  const frame = { left: 100, top: 0, right: 1100, bottom: 562 };
  assert.deepEqual(placeAbove({ left: 600, top: 400, right: 700, bottom: 440 }, frame, 400),
    { cx: 550, left: 350, bottom: 170, maxHeight: 384 });
  assert.equal(placeAbove({ left: 100, top: 400, right: 140, bottom: 440 }, frame, 400).left, 8, 'clamped at the left edge');
  assert.equal(placeAbove({ left: 1050, top: 400, right: 1100, bottom: 440 }, frame, 400).left, 1000 - 400 - 8, 'and at the right');
  assert.equal(placeAbove({ left: 600, top: 20, right: 700, bottom: 40 }, frame, 400).maxHeight, 80);
});

// A tiny document: elements record className / textContent / children / listeners. No innerHTML at all.
function fakeDoc() {
  const mkEl = (tag) => {
    const e = { tagName: tag, className: '', textContent: '', children: [], listeners: {}, type: '', title: '' };
    e.append = (...k) => { for (const c of k) e.children.push(c); };
    e.addEventListener = (n, f) => { e.listeners[n] = f; };
    return e;
  };
  return { createElement: mkEl };
}
const texts = (n) => [n.textContent, ...n.children.flatMap(texts)].filter(Boolean);
const find = (n, cls) => (String(n.className).split(' ').includes(cls) ? [n] : []).concat(n.children.flatMap((c) => find(c, cls)));

test('cardNodes: loading shows the phrase, the wait text and a budget warning', () => {
  const [head, body] = cardNodes(fakeDoc(), { kind: 'loading', phrase: 'figure out', warning: '本月已用 80%' });
  assert.equal(find(head, 'ph-phrase')[0].textContent, 'figure out');
  assert.deepEqual(texts(body), [LOADING_TEXT, '本月已用 80%']);
});

test('cardNodes: done renders every field as text; model output with markup stays literal text', () => {
  let closed = 0;
  const [head, body] = cardNodes(fakeDoc(), { kind: 'done', phrase: 'p', result: {
    meaningZh: '<img src=x onerror=alert(1)>', whyHere: '因為', pattern: 'sb + V',
    examples: [{ en: 'E1', zh: '例一' }], alternatives: [{ en: 'A1', noteZh: '較正式' }],
  } }, { close: () => closed++ });
  assert.deepEqual(texts(body), ['在這裡的意思', '<img src=x onerror=alert(1)>', '為什麼這樣說', '因為', '可套用的句型', 'sb + V',
    '其他例句', 'E1', '例一', '類似說法', 'A1', '較正式']);
  find(head, 'ph-x')[0].listeners.click();
  assert.equal(closed, 1);
});

test('cardNodes: budget offers 這次仍要問, busy/error 再試一次, phrase mismatch nothing', () => {
  const calls = [];
  const on = { override: () => calls.push('override'), retry: () => calls.push('retry') };
  const budget = cardNodes(fakeDoc(), { kind: 'budget', phrase: 'p', error: '本月 API 費用已達上限' }, on)[1];
  assert.deepEqual(texts(budget), ['本月 API 費用已達上限', '這次仍要問']);
  find(budget, 'ph-go')[0].listeners.click();
  const busy = cardNodes(fakeDoc(), { kind: 'busy', phrase: 'p', error: 'AI 正忙，稍後再試' }, on)[1];
  assert.deepEqual(texts(busy), ['AI 正忙，稍後再試', '再試一次']);
  find(busy, 'ph-go')[0].listeners.click();
  assert.deepEqual(calls, ['override', 'retry']);
  const phrase = cardNodes(fakeDoc(), { kind: 'phrase', phrase: 'p', error: '選取的文字和課程不一致' }, on)[1];
  assert.deepEqual(texts(phrase), ['選取的文字和課程不一致']);
  assert.equal(find(phrase, 'ph-go').length, 0);
});

test('noteRowNodes: sorted rows with phrase + meaning; a click hands back the note', () => {
  const picked = [];
  const notes = { '20-21': note(2, 20, 21, 'later'), '10-11': note(1, 10, 11, 'first') };
  const rows = noteRowNodes(fakeDoc(), notes, (n) => picked.push(n.phrase));
  assert.deepEqual(rows.map(texts), [['first', 'm10'], ['later', 'm20']]);
  rows[1].listeners.click({});
  assert.deepEqual(picked, ['later']);
});

test('phrase.js never touches an HTML sink', () => {
  const src = readFileSync(new URL('../../web/phrase.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
});
