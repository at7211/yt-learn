// Runs extension/ttml.js (plain script) in a vm context. Every fixture sentence is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/ttml.js', import.meta.url), 'utf8');
const FIX = readFileSync(new URL('../fixtures/netflix_small.ttml', import.meta.url), 'utf8');
const ctx = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const parse = (s) => JSON.parse(JSON.stringify(ctx.ytLearnParseTtml(s)));

const NS = 'xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"';
// A document with the given tt attributes and body content (default: one div around `cues`).
const doc = (cues, { tt = 'ttp:tickRate="1000"', body = null, head = '' } = {}) =>
  `<?xml version="1.0" encoding="utf-8"?><tt ${NS} ${tt}>${head}<body>${body === null ? '<div>' + cues + '</div>' : body}</body></tt>`;
const P = (begin, end, text) => `<p begin="${begin}" end="${end}">${text}</p>`;

function rejects(src, re) {
  let err = null;
  try { ctx.ytLearnParseTtml(src); } catch (e) { err = e; }
  assert.ok(err, 'expected a throw for: ' + String(src).slice(0, 160));
  assert.ok(String(err.message).startsWith('不支援的字幕檔結構：'), err.message);
  if (re) assert.match(err.message, re);
  return err.message;
}

/* ---------- negatives first: every one must throw 「不支援的字幕檔結構：…」 ---------- */

test('reject: DOCTYPE / entity declarations, CDATA, processing instructions', () => {
  rejects('<?xml version="1.0"?><!DOCTYPE tt [<!ENTITY x "y">]>' + doc(P('0t', '10t', 'a')).replace(/^<\?xml[^>]*>/, ''), /DOCTYPE/);
  rejects('<!DOCTYPE tt>' + doc(P('0t', '10t', 'a')).replace(/^<\?xml[^>]*>/, ''), /DOCTYPE/);
  rejects(doc(P('0t', '10t', 'a<![CDATA[b]]>')), /CDATA/);
  rejects(doc(P('0t', '10t', 'a<?pi x?>')), /處理指令/);
  rejects(doc(P('0t', '10t', 'a')).replace('<tt', '<?pi x?><tt'), /處理指令/);
});

test('reject: root is not tt, or the TTML namespace is wrong / missing', () => {
  rejects('<?xml version="1.0"?><html xmlns="http://www.w3.org/ns/ttml"><body/></html>', /根元素不是 tt/);
  rejects('<tt xmlns="http://example.com/ttml"><body><div/></body></tt>', /namespace/);
  rejects('<tt><body><div/></body></tt>', /namespace/);
  // prefix bound to the wrong URI
  rejects('<x:tt xmlns:x="http://www.w3.org/ns/ttml#styling"><x:body/></x:tt>', /namespace/);
  // undeclared prefix
  rejects('<x:tt><x:body/></x:tt>', /前綴/);
});

test('reject: timing on body / div / span (ancestors of p)', () => {
  for (const a of ['begin="1t"', 'end="9t"', 'dur="9t"', 'timeContainer="seq"']) {
    rejects(doc('', { body: `<div ${a}>${P('0t', '10t', 'a')}</div>` }), /時間/);
    rejects(doc(P('0t', '10t', `<span ${a}>a</span>`)), /時間/);
  }
  rejects(`<tt ${NS}><body begin="1t"><div>${P('0t', '10t', 'a')}</div></body></tt>`, /時間/);
});

test('reject: p with timeContainer; p missing begin or end/dur', () => {
  rejects(doc('<p begin="0t" end="10t" timeContainer="par">a</p>'), /timeContainer/);
  rejects(doc('<p end="10t">a</p>'), /begin/);
  rejects(doc('<p begin="10t">a</p>'), /end/);
});

test('reject: ruby / metadata / image / set / foreign elements inside p, nested div, p straight under body', () => {
  rejects(doc(P('0t', '10t', '<span tts:ruby="container" xmlns:tts="http://www.w3.org/ns/ttml#styling">a<ruby>b</ruby></span>')), /ruby/);
  rejects(doc(P('0t', '10t', '<metadata>x</metadata>a')), /metadata/);
  rejects(doc(P('0t', '10t', '<image src="x.png"/>')), /image/);
  rejects(doc(P('0t', '10t', '<set tts:color="red" xmlns:tts="http://www.w3.org/ns/ttml#styling"/>a')), /set/);
  rejects(doc(P('0t', '10t', '<x:span xmlns:x="http://example.com/">a</x:span>')), /span/);
  rejects(doc('', { body: `<div><div>${P('0t', '10t', 'a')}</div></div>` }), /div/);
  rejects(doc('', { body: P('0t', '10t', 'a') }), /沒有 div/);
  rejects(doc('', { body: `<div>stray text${P('0t', '10t', 'a')}</div>` }), /文字/);
  rejects(doc(P('0t', '10t', 'a<br>b</br>')), /br/);
});

test('reject: timeBase other than media; bad frameRate / subFrameRate / multiplier / tickRate values', () => {
  rejects(doc(P('0t', '10t', 'a'), { tt: 'ttp:timeBase="smpte"' }), /timeBase/);
  rejects(doc(P('0t', '10t', 'a'), { tt: 'ttp:timeBase="clock"' }), /timeBase/);
  for (const bad of ['0', '-30', '29.97', 'abc', '', ' ', '1e2', '+30']) {
    rejects(doc(P('0t', '10t', 'a'), { tt: `ttp:frameRate="${bad}"` }), /frameRate/);
    rejects(doc(P('0t', '10t', 'a'), { tt: `ttp:tickRate="${bad}"` }), /tickRate/);
    rejects(doc(P('0t', '10t', 'a'), { tt: `ttp:subFrameRate="${bad}"` }), /subFrameRate/);
  }
  for (const bad of ['1000 0', '0 1001', '1000', '1000 1001 1', '1.5 1', 'a b', '-1 1']) {
    rejects(doc(P('0t', '10t', 'a'), { tt: `ttp:frameRate="30" ttp:frameRateMultiplier="${bad}"` }), /frameRateMultiplier/);
  }
});

test('reject: parameters are recognised by namespace URI, not by the literal ttp: prefix', () => {
  // a prefix named "q" bound to the parameter namespace still counts
  rejects(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:q="http://www.w3.org/ns/ttml#parameter" q:timeBase="smpte"><body><div>${P('0t', '1t', 'a')}</div></body></tt>`, /timeBase/);
  // "ttp:" bound to some other namespace is not a parameter (and is ignored), so this parses
  const r = parse(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://example.com/p" ttp:timeBase="smpte"><body><div>${P('1s', '2s', 'Fine here.')}</div></body></tt>`);
  assert.deepEqual(r.events, [{ t: 1000, d: 1000, text: 'Fine here.' }]);
});

test('reject: bad time expressions', () => {
  for (const bad of ['10', '1:2:3', '00:00:61.000', '00:61:00', '10x', '1.5.5s', '-1s', 's', '00:00:01:30', 'PT1S', '1 s']) {
    rejects(doc(`<p begin="${bad}" end="99s">a</p>`), /時間/);
  }
});

test('reject: end and dur both present but disagreeing', () => {
  rejects(doc('<p begin="1s" end="3s" dur="5s">a</p>'), /end.*dur|dur.*end/);
  // within 1 ms is fine
  assert.equal(parse(doc('<p begin="1s" end="3s" dur="2001ms">Close enough.</p>')).events[0].d, 2000);
});

test('reject: unquoted attribute, missing value, duplicate attribute, missing whitespace between attributes', () => {
  rejects(doc('<p begin=0t end="10t">a</p>'), /引號/);
  rejects(doc('<p begin end="10t">a</p>'), /值/);
  rejects(doc('<p begin="0t" begin="1t" end="10t">a</p>'), /重複/);
  rejects(doc('<p begin="0t"end="10t">a</p>'), /空白/);
  rejects(doc('<p begin="0t" end="10t>a</p>'), /./);
});

test('reject: unpaired / mismatched / unclosed tags, text outside the root, two roots', () => {
  rejects(doc(P('0t', '10t', '<span>a')), /配對|結束/);
  rejects(doc(P('0t', '10t', 'a</span>')), /配對/);
  rejects(`<tt ${NS}><body><div>${P('0t', '10t', 'a')}</div></body>`, /結束|配對/);
  rejects(doc(P('0t', '10t', 'a')) + 'trailing', /根元素之後/);
  rejects(doc(P('0t', '10t', 'a')) + '<tt/>', /根元素之後/);
  rejects('junk' + doc(P('0t', '10t', 'a')).replace(/^<\?xml[^>]*>/, ''), /./);
  rejects(doc(P('0t', '10t', 'a')).replace('<?xml', ' <?xml'), /處理指令|XML 宣告/);
  rejects('', /./);
});

test('reject: unknown or malformed entities and character references', () => {
  for (const bad of ['&nbsp;', '&copy;', '& b', '&amp', '&#;', '&#x;', '&#0;', '&#xD800;', '&#x110000;', '&#1;', '&#xZZ;']) {
    rejects(doc(P('0t', '10t', 'a ' + bad)), /實體|字元/);
  }
  rejects(doc('<p begin="0t" end="10t" title="&foo;">a</p>'), /實體/);
  rejects(doc(P('0t', '10t', 'a \u0001 b')), /控制字元/);
});

test('reject: XML declaration with another encoding or a broken one', () => {
  rejects(doc(P('0t', '10t', 'a')).replace('encoding="utf-8"', 'encoding="UTF-16"'), /編碼/);
  rejects(doc(P('0t', '10t', 'a')).replace('version="1.0"', 'versio="1.0"'), /XML 宣告/);
});

test('reject: limits — depth > 16, nodes > 50000, cues > 10000, input > 2 MB', () => {
  // depth: tt(1) body(2) div(3) p(4) + 13 spans = 17
  const deep = '<span>'.repeat(13) + 'a' + '</span>'.repeat(13);
  rejects(doc(P('0t', '10t', deep)), /深度/);
  const ok = '<span>'.repeat(12) + 'Deep but fine.' + '</span>'.repeat(12);
  assert.equal(parse(doc(P('0t', '10t', ok))).events[0].text, 'Deep but fine.');
  rejects(doc(P('0t', '10t', 'a' + '<br/>'.repeat(50000))), /節點/);
  const many = Array.from({ length: 10001 }, (_, i) => P(i * 10 + 't', i * 10 + 5 + 't', 'w')).join('');
  rejects(doc(many), /cue|字幕句/);
  rejects(doc(P('0t', '10t', 'a')) + '<!--' + 'x'.repeat(2 * 1024 * 1024) + '-->', /2 MB/);
  rejects(42, /./);
});

/* ---------- positives ---------- */

test('fixture: ticks, SDH cleanup, multiple spans + br, entities, same-begin merge, dropped', () => {
  assert.ok(!/<!DOCTYPE/.test(FIX));
  const r = parse(FIX);
  assert.deepEqual(r.events, [
    { t: 1234, d: 2222, text: 'First line of a made-up sentence.' },
    { t: 4000, d: 2000, text: 'Pancakes & tea are on the table.' },
    { t: 9000, d: 2000, text: 'We sing about the pretend river' },
    { t: 14000, d: 1000, text: 'Wait (quietly) for me.' },
    { t: 16000, d: 1500, text: 'Speaker one says hi. Speaker two waves back.' },
    { t: 21000, d: 2000, text: 'It\'s "fine", <really> été.' },
  ]);
  assert.equal(r.dropped, 3, '[thunder rumbling], (sighs), -[gasps]');
});

test('BOM and comments are skipped; prefixed tt and the old ttaf1 namespace are accepted', () => {
  const r = parse('﻿<!-- c --><t:tt xmlns:t="http://www.w3.org/2006/10/ttaf1" xmlns:p="http://www.w3.org/2006/10/ttaf1#parameter" p:tickRate="10"><!-- c --><t:body><t:div>'
    + '<t:p begin="10t" end="20t">Old <t:span>style</t:span><!-- c --> doc.</t:p></t:div></t:body></t:tt><!-- end -->\n');
  assert.deepEqual(r.events, [{ t: 1000, d: 1000, text: 'Old style doc.' }]);
});

test('frameRate=30 multiplier="1000 1001", no tickRate -> tickRate = 29.97, 30000t = 1001 s', () => {
  const r = parse(doc(P('30000t', '60000t', 'Drop-frame-ish.'), { tt: 'ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001"' }));
  assert.deepEqual(r.events, [{ t: 1001000, d: 1001000, text: 'Drop-frame-ish.' }]);
  // without frameRate: tickRate defaults to 1
  assert.deepEqual(parse(doc(P('3t', '4t', 'One tick a second.'), { tt: '' })).events, [{ t: 3000, d: 1000, text: 'One tick a second.' }]);
  // with frameRate and subFrameRate: tickRate = 25 × 2
  assert.deepEqual(parse(doc(P('50t', '100t', 'Fifty a second.'), { tt: 'ttp:frameRate="25" ttp:subFrameRate="2"' })).events, [{ t: 1000, d: 1000, text: 'Fifty a second.' }]);
  // timeBase="media" explicit is fine
  assert.equal(parse(doc(P('1t', '2t', 'Media.'), { tt: 'ttp:timeBase="media" ttp:tickRate="1"' })).events[0].t, 1000);
});

test('clock and frame time expressions', () => {
  const r = parse(doc(
    P('00:00:01.5', '00:00:02.250', 'Clock with fractions.')
    + P('00:01:00', '00:01:01', 'Whole seconds.')
    + P('00:00:03:15', '00:00:04:00', 'Frames at thirty.')
    + P('01:00:00:00.1', '01:00:00:01', 'Sub frame.'),
    { tt: 'ttp:frameRate="30" ttp:subFrameRate="2"' }));
  assert.deepEqual(r.events, [
    { t: 1500, d: 750, text: 'Clock with fractions.' },
    { t: 3500, d: 500, text: 'Frames at thirty.' },
    { t: 60000, d: 1000, text: 'Whole seconds.' },
    { t: 3600017, d: 16, text: 'Sub frame.' },
  ]);
  // frame time uses the effective frame rate (30 × 1000/1001): 30 frames = 1.001 s
  assert.equal(parse(doc(P('00:00:00:00', '00:00:00:29', 'x y'), { tt: 'ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001"' })).events[0].d, 968);
  assert.equal(parse(doc(P('00:00:10:00', '00:00:20:00', 'Ten.'), { tt: 'ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001"' })).events[0].t, 10000);
  rejects(doc(P('00:00:00:30', '00:00:01:00', 'a'), { tt: 'ttp:frameRate="30"' }), /時間/);
});

test('offset units h / m / s / ms / f / t, and dur', () => {
  const r = parse(doc(
    P('1h', '1.5h', 'Hours.')
    + P('2m', '2.5m', 'Minutes.')
    + P('3s', '3.25s', 'Seconds.')
    + P('4000ms', '6000.4ms', 'Millis.')
    + P('150f', '180f', 'Frames.')
    + '<p begin="7000t" dur="1000t">With dur.</p>',
    { tt: 'ttp:frameRate="30" ttp:tickRate="1000"' }));
  assert.deepEqual(r.events, [
    { t: 3000, d: 250, text: 'Seconds.' },
    { t: 4000, d: 1000, text: 'Millis.' },
    { t: 5000, d: 1000, text: 'Frames.' },
    { t: 7000, d: 1000, text: 'With dur.' },
    { t: 120000, d: 30000, text: 'Minutes.' },
    { t: 3600000, d: 1800000, text: 'Hours.' },
  ]);
  assert.equal(r.events[1].d, 1000, '6000.4ms truncated to the next begin');
});

test('end is truncated to the next begin; end <= begin is dropped and counted', () => {
  const r = parse(doc(P('1s', '10s', 'Long one.') + P('3s', '4s', 'Next one.') + P('5s', '5s', 'Zero length.') + P('7s', '6s', 'Backwards.')));
  assert.deepEqual(r.events, [{ t: 1000, d: 2000, text: 'Long one.' }, { t: 3000, d: 1000, text: 'Next one.' }]);
  assert.equal(r.dropped, 2);
});

test('same begin: merged in document order, end = max, even when not adjacent; stable sort otherwise', () => {
  const r = parse(doc(P('5s', '6s', 'Later.') + P('1s', '2s', 'Alpha says.') + P('3s', '4s', 'Middle.') + P('1s', '2.5s', 'Beta answers.')));
  assert.deepEqual(r.events, [
    { t: 1000, d: 1500, text: 'Alpha says. Beta answers.' },
    { t: 3000, d: 1000, text: 'Middle.' },
    { t: 5000, d: 1000, text: 'Later.' },
  ]);
});

test('short cues (d < tokens × 2 ms) merge into the next; chains; the last merges into the previous', () => {
  // 3 tokens in 5 ms -> short -> merged into next
  let r = parse(doc(P('1000ms', '1005ms', 'one two three') + P('1005ms', '2000ms', 'Next sentence.')));
  assert.deepEqual(r.events, [{ t: 1000, d: 1000, text: 'one two three Next sentence.' }]);
  // chain: a short, then the merged a+b still short, then merged with c
  r = parse(doc(P('1000ms', '1001ms', 'a a') + P('1001ms', '1004ms', 'b b b') + P('1004ms', '3000ms', 'Last one here.')));
  assert.deepEqual(r.events, [{ t: 1000, d: 2000, text: 'a a b b b Last one here.' }]);
  // exactly tokens × 2 ms is not short
  r = parse(doc(P('1000ms', '1004ms', 'x y') + P('1004ms', '2000ms', 'Stays apart.')));
  assert.equal(r.events.length, 2);
  // last one short -> merged into the previous (end = max)
  r = parse(doc(P('1s', '2s', 'Earlier line.') + P('2s', '2001ms', 'tail words here')));
  assert.deepEqual(r.events, [{ t: 1000, d: 1001, text: 'Earlier line. tail words here' }]);
  // a lone short cue stays (nothing to merge with)
  r = parse(doc(P('1s', '1001ms', 'many short words here')));
  assert.deepEqual(r.events, [{ t: 1000, d: 1, text: 'many short words here' }]);
  // t stays strictly increasing and d > 0 throughout
  for (const e of r.events) assert.ok(e.d > 0);
});

test('whitespace: br -> space, source newlines collapse, leading dashes only at line starts', () => {
  const r = parse(doc(P('1s', '2s', '\n   <span>-Who  is</span>\n<br/>\n<span>- it?</span> A well-known name.\n')));
  assert.deepEqual(r.events, [{ t: 1000, d: 1000, text: 'Who is it? A well-known name.' }]);
  const empty = parse(doc(P('1s', '2s', '  <br/> ') + P('3s', '4s', '♪ ♪')));
  assert.deepEqual(empty, { events: [], dropped: 2 });
});

test('SDH leftovers: every run of leading dashes goes; a cue of only tags and dashes is dropped', () => {
  // two tags on one line leave "- -" behind -> nothing left -> dropped
  assert.deepEqual(parse(doc(P('1s', '2s', '-[tag one] -[tag two]'))), { events: [], dropped: 1 });
  // a tag before the dash of the next speaker
  assert.equal(parse(doc(P('1s', '2s', '-[tag] -Over here.'))).events[0].text, 'Over here.');
  // a tag wrapped across a br is one tag
  assert.equal(parse(doc(P('1s', '2s', '-[tag that<br/>wraps] -Over here.'))).events[0].text, 'Over here.');
  // an unmatched ] is literal text
  assert.equal(parse(doc(P('1s', '2s', 'Odd ] bracket'))).events[0].text, 'Odd ] bracket');
});

test('head is skipped (any well-formed content), XML comments anywhere', () => {
  const head = '<head><!-- c --><metadata xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><ttm:title>Hi &amp; bye</ttm:title><whatever begin="1s"/></metadata></head>';
  const r = parse(doc(P('1s', '2s', 'Body only.'), { head }));
  assert.deepEqual(r.events, [{ t: 1000, d: 1000, text: 'Body only.' }]);
  rejects(doc(P('1s', '2s', 'a'), { head: '<head><b></head>' }), /配對/);
  rejects(doc(P('1s', '2s', 'a'), { head: '<head/><head/>' }), /head/);
});

test('empty body / no div content -> zero events, not an error', () => {
  assert.deepEqual(parse(doc('')), { events: [], dropped: 0 });
  assert.deepEqual(parse(`<tt ${NS}/>`), { events: [], dropped: 0 });
});

/* ---------- fix round 1: XML strictness, byte limit, dropped count, linear time ---------- */

test('comments: content may not contain -- nor end with -', () => {
  rejects(doc(P('1s', '2s', 'a')).replace('<body>', '<body><!-- x--->'), /註解/);
  rejects(doc(P('1s', '2s', 'a')).replace('<body>', '<body><!-- a -- b -->'), /註解/);
  assert.equal(parse(doc(P('1s', '2s', 'Comment ok.')).replace('<body>', '<body><!-- a - b -->')).events.length, 1);
});

test('lone surrogates are rejected in text, attribute values and comments; valid astral characters pass', () => {
  rejects(doc(P('1s', '2s', 'a \uD800 b')), /surrogate/);
  rejects(doc(P('1s', '2s', 'a \uDC00 b')), /surrogate/);
  rejects(doc('<p begin="1s" end="2s" title="\uDBFF">a</p>'), /surrogate/);
  rejects(doc(P('1s', '2s', 'a')).replace('<body>', '<body><!-- \uD83D -->'), /surrogate/);
  rejects(doc(P('1s', '2s', 'a')) + '\uD800', /surrogate/);
  rejects(doc(P('1s', '2s', 'a ￾')), /控制字元/);
  const r = parse(doc(P('1s', '2s', 'Rare 𠀋 and 😀 here &#x1F600;.')));
  assert.deepEqual(r.events, [{ t: 1000, d: 1000, text: 'Rare 𠀋 and 😀 here 😀.' }]);
});

test('2 MB limit is UTF-8 bytes, not UTF-16 code units (multibyte document across the boundary)', () => {
  const MAX = 2 * 1024 * 1024;
  const base = doc(P('1s', '2s', 'Multibyte filler.')).replace('<body>', '<body><!--X-->');
  const baseBytes = Buffer.byteLength(base, 'utf8') - 1; // without the X placeholder
  const fill = (bytes) => '漢'.repeat(Math.floor(bytes / 3)) + 'a'.repeat(bytes % 3);
  const at = base.replace('X', fill(MAX - baseBytes));
  assert.equal(Buffer.byteLength(at, 'utf8'), MAX);
  assert.ok(at.length < MAX);
  assert.equal(parse(at).events[0].text, 'Multibyte filler.');
  const over = base.replace('X', fill(MAX - baseBytes + 1));
  assert.equal(Buffer.byteLength(over, 'utf8'), MAX + 1);
  assert.ok(over.length < MAX, 'under 2 MB in code units, over in bytes');
  rejects(over, /2 MB/);
});

test('dropped counts every source cue of a same-begin group that is then dropped', () => {
  const r = parse(doc(P('1s', '0s', 'First bad.') + P('1s', '0s', 'Second bad.') + P('3s', '4s', 'Good one.')));
  assert.deepEqual(r.events, [{ t: 3000, d: 1000, text: 'Good one.' }]);
  assert.equal(r.dropped, 2);
  // a bad cue merged with a good one at the same begin is kept (end = max), not dropped
  const k = parse(doc(P('1s', '0s', 'Bad end.') + P('1s', '2s', 'Good end.')));
  assert.deepEqual(k, { events: [{ t: 1000, d: 1000, text: 'Bad end. Good end.' }], dropped: 0 });
});

test('brackets: nested removed in one pass; an unmatched ] stays; an unmatched [ drops to the end of the cue', () => {
  assert.equal(parse(doc(P('1s', '2s', 'Keep this] [drop [nested] too] end.'))).events[0].text, 'Keep this] end.');
  assert.equal(parse(doc(P('1s', '2s', 'Before [never closed<br/>still dropped'))).events[0].text, 'Before');
  assert.equal(parse(doc(P('1s', '2s', '[across<br/>lines] After.'))).events[0].text, 'After.');
});

const timed = (fn) => { const t0 = performance.now(); const r = fn(); return [r, performance.now() - t0]; };

test('perf: ~9,000 very short cues in ~1.4 MB chain-merge in linear time', () => {
  const words = Array(60).fill('w').join(' ');
  const src = doc(Array.from({ length: 9000 }, (_, i) => P(i + 'ms', i + 1 + 'ms', words)).join(''));
  assert.ok(src.length > 1.3e6 && src.length < 2e6, String(src.length));
  const [r, ms] = timed(() => parse(src));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].text.length, words.length * 9000 + 8999);
  assert.ok(ms < 1000, ms + ' ms');
});

test('perf: a 60 KB cue of nested brackets', () => {
  const src = doc(P('1s', '2s', 'Hi ' + '['.repeat(30000) + 'x' + ']'.repeat(30000) + ' there.'));
  const [r, ms] = timed(() => parse(src));
  assert.equal(r.events[0].text, 'Hi there.');
  assert.ok(ms < 1000, ms + ' ms');
});

test('perf: 30,000 attributes on one element; 2,000 namespace declarations × 10,000 empty elements', () => {
  const attrs = Array.from({ length: 30000 }, (_, i) => `a${i}="v"`).join(' ');
  let [r, ms] = timed(() => parse(doc(P('1s', '2s', `<span ${attrs}>Many attributes.</span>`))));
  assert.equal(r.events[0].text, 'Many attributes.');
  assert.ok(ms < 1000, ms + ' ms');
  const decls = Array.from({ length: 2000 }, (_, i) => `xmlns:n${i}="urn:x:${i}"`).join(' ');
  const head = '<head>' + '<n1999:e/>'.repeat(10000) + '</head>';
  [r, ms] = timed(() => parse(doc(P('1s', '2s', 'Many namespaces.'), { tt: 'ttp:tickRate="1000" ' + decls, head })));
  assert.equal(r.events[0].text, 'Many namespaces.');
  assert.ok(ms < 1000, ms + ' ms');
});

test('cue limit is enforced while tokenizing (also for p elements outside a div)', () => {
  const many = Array.from({ length: 10001 }, () => '<p/>').join('');
  rejects(doc('', { head: '<head>' + many + '</head>' }), /cue/);
});
