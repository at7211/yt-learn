// Runs extension/vtt.js (plain script) in a vm context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/vtt.js', import.meta.url), 'utf8');
const FIX = readFileSync(new URL('../fixtures/udemy_small.vtt', import.meta.url), 'utf8');
const ctx = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const parse = (s) => JSON.parse(JSON.stringify(ctx.ytLearnParseVtt(s)));
const one = (t, text) => `WEBVTT\n\n${t}\n${text}\n`;

test('fixture: BOM, CRLF, NOTE, tags, entity, settings, truncation, dropped', () => {
  assert.equal(FIX.charCodeAt(0), 0xFEFF);
  assert.ok(FIX.includes('\r\n'));
  const r = parse(FIX);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.events, [
    { t: 1000, d: 2000, segs: [[null, 'Welcome to the course.']] },
    { t: 3000, d: 2000, segs: [[null, 'Tom & Jerry']] },
    { t: 5000, d: 2000, segs: [[null, 'Two lines here']] },
    { t: 7000, d: 0, segs: [[null, 'Same start A']] },
    { t: 7000, d: 1000, segs: [[null, 'Same start B']] },
    { t: 10000, d: 2000, segs: [[null, 'The end.']] },
  ]);
});

test('no trailing newline, LF only, mm:ss.mmm', () => {
  const r = parse('WEBVTT\n\n00:01.500 --> 00:02.250\nhi');
  assert.deepEqual(r.events, [{ t: 1500, d: 750, segs: [[null, 'hi']] }]);
  assert.equal(r.dropped, 0);
});

test('hh:mm:ss.mmm with hours', () => {
  const r = parse(one('01:02:03.004 --> 01:02:04.000', 'x'));
  assert.deepEqual(r.events[0], { t: 3723004, d: 996, segs: [[null, 'x']] });
});

test('header block, STYLE and REGION blocks skipped', () => {
  const r = parse('WEBVTT - title\nKind: captions\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:a\n\n00:00.000 --> 00:01.000\nok\n');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].segs[0][1], 'ok');
  assert.equal(r.dropped, 0);
});

test('identifiers: numeric and non-numeric', () => {
  const r = parse('WEBVTT\n\n7\n00:00.000 --> 00:01.000\na\n\nintro-cue\n00:01.000 --> 00:02.000\nb\n');
  assert.deepEqual(r.events.map((e) => e.segs[0][1]), ['a', 'b']);
});

test('tags removed: v, c.foo, i, b, u, ruby/rt, inline timestamps', () => {
  const r = parse(one('00:00.000 --> 00:05.000',
    '<v Bob>a <c.foo>b</c> <i>c</i><b>d</b><u>e</u> <ruby>f<rt>g</rt></ruby> <00:01.000>h</v>'));
  assert.equal(r.events[0].segs[0][1], 'a b cde fg h');
});

test('entities decoded', () => {
  const r = parse(one('00:00.000 --> 00:01.000', 'a&amp;b &lt;x&gt;&nbsp;y&lrm;&rlm; &quot;q&quot; it&#39;s'));
  assert.equal(r.events[0].segs[0][1], 'a&b <x> y "q" it\'s');
});

test('whitespace collapsed across lines', () => {
  const r = parse(one('00:00.000 --> 00:01.000', '  a   b\n\t c  '));
  assert.equal(r.events[0].segs[0][1], 'a b c');
});

test('zero and negative duration dropped and counted', () => {
  const r = parse('WEBVTT\n\n00:01.000 --> 00:01.000\nzero\n\n00:02.000 --> 00:01.500\nneg\n\n00:03.000 --> 00:04.000\nok\n');
  assert.equal(r.events.length, 1);
  assert.equal(r.dropped, 2);
});

test('empty text dropped', () => {
  const r = parse(one('00:00.000 --> 00:01.000', '<i> </i>'));
  assert.deepEqual(r, { events: [], dropped: 1 });
});

test('same start kept; out-of-order dropped; compared with last kept cue', () => {
  const r = parse('WEBVTT\n\n00:05.000 --> 00:06.000\na\n\n00:05.000 --> 00:07.000\nb\n\n00:04.000 --> 00:04.500\nc\n\n00:08.000 --> 00:09.000\nd\n');
  assert.deepEqual(r.events.map((e) => e.segs[0][1]), ['a', 'b', 'd']);
  assert.equal(r.dropped, 1);
});

test('truncation never overlaps next kept cue; dropped cue does not truncate', () => {
  const r = parse('WEBVTT\n\n00:00.000 --> 00:10.000\na\n\n00:03.000 --> 00:03.000\nbad\n\n00:04.000 --> 00:05.000\nb\n');
  assert.equal(r.events[0].d, 4000);
  assert.equal(r.events[1].d, 1000);
});

test('integer ms and one seg per cue', () => {
  const r = parse(FIX);
  for (const e of r.events) {
    assert.ok(Number.isInteger(e.t) && Number.isInteger(e.d));
    assert.equal(e.segs.length, 1);
    assert.equal(e.segs[0][0], null);
  }
});
