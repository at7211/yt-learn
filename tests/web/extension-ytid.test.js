// extension/ytid.js must agree with pipeline/jobs.py::parse_video_id on the shared table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/ytid.js', import.meta.url), 'utf8');
const TABLE = JSON.parse(readFileSync(new URL('../fixtures/urls.json', import.meta.url), 'utf8'));
const IDS = JSON.parse(readFileSync(new URL('../fixtures/lesson_ids.json', import.meta.url), 'utf8'));
const ctx = { URL };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx);

test('accepts every url in the shared table', () => {
  for (const [input, id] of TABLE.accept) assert.equal(ctx.ytLearnParseVideoId(input), id, JSON.stringify(input));
});

test('rejects every url in the shared table', () => {
  for (const input of TABLE.reject) assert.equal(ctx.ytLearnParseVideoId(input), null, JSON.stringify(input));
});

test('non-strings rejected; canonical url', () => {
  assert.equal(ctx.ytLearnParseVideoId(undefined), null);
  assert.equal(ctx.ytLearnParseVideoId(42), null);
  assert.equal(ctx.ytLearnCanonicalUrl('puh91fohvTA'), 'https://www.youtube.com/watch?v=puh91fohvTA');
});

test('ytLearnParseLessonId agrees with pipeline/ids.py on lesson_ids.json', () => {
  for (const [input, id] of IDS.parse) assert.equal(ctx.ytLearnParseLessonId(input), id, JSON.stringify(input));
  for (const [input, id] of TABLE.accept) assert.equal(ctx.ytLearnParseLessonId(input), id, JSON.stringify(input));
  for (const input of TABLE.reject) assert.equal(ctx.ytLearnParseLessonId(input), null, JSON.stringify(input));
});

test('ytLearnParseVideoId stays YouTube-only', () => {
  assert.equal(ctx.ytLearnParseVideoId('udemy.5800738'), null);
  assert.equal(ctx.ytLearnParseVideoId('https://www.udemy.com/course/x/learn/lecture/5800738'), null);
});

test('ytLearnParseUdemyUrl and ytLearnLessonSource agree with lesson_ids.json', () => {
  for (const [input, want] of IDS.udemyUrl) {
    // vm objects come from another realm, so compare fields rather than deepEqual the object.
    const got = ctx.ytLearnParseUdemyUrl(input);
    assert.deepEqual(got && [got.slug, got.lectureId], want, JSON.stringify(input));
  }
  for (const [input, want] of IDS.source) assert.equal(ctx.ytLearnLessonSource(input), want, JSON.stringify(input));
  assert.equal(ctx.ytLearnLessonSource(undefined), null);
  assert.equal(ctx.ytLearnParseLessonId(42), null);
  assert.equal(ctx.ytLearnParseUdemyUrl(null), null);
});

test('ytLearnParseNetflixUrl agrees with lesson_ids.json; netflix watch URLs parse to netflix.<id>', () => {
  for (const [input, want] of IDS.netflixUrl) assert.equal(ctx.ytLearnParseNetflixUrl(input), want, JSON.stringify(input));
  assert.equal(ctx.ytLearnParseNetflixUrl(undefined), null);
  assert.equal(ctx.ytLearnParseLessonId('https://www.netflix.com/watch/81234567?trackId=1'), 'netflix.81234567');
  assert.equal(ctx.ytLearnLessonSource('netflix.81234567'), 'netflix');
  assert.equal(ctx.ytLearnNetflixWatchUrl('81234567'), 'https://www.netflix.com/watch/81234567');
  assert.equal(ctx.ytLearnParseVideoId('https://www.netflix.com/watch/81234567'), null);
});

test('ytLearnParseHelloUrl and ytLearnLessonSource agree with lesson_ids.json (helloUrl and helloUrlLength)', () => {
  assert.ok(IDS.helloUrl.length >= 25);
  assert.equal(IDS.helloUrlLength.length, 8);
  for (const [input, want] of IDS.helloUrl) assert.equal(ctx.ytLearnParseHelloUrl(input), want, JSON.stringify(input));
  for (const [input, want] of IDS.helloUrlLength) {
    assert.equal(ctx.ytLearnParseHelloUrl(input), want, input);
    assert.equal(ctx.ytLearnParseLessonId(input), want && 'hello.' + want.replace(/\//g, '.'), input);
  }
  for (const [input, want] of IDS.source) assert.equal(ctx.ytLearnLessonSource(input), want, JSON.stringify(input));
  assert.equal(ctx.ytLearnLessonSource('hello.system-design.patterns.dealing-with-contention'), 'hellointerview');
  assert.equal(ctx.ytLearnParseHelloUrl(undefined), null);
  assert.equal(ctx.ytLearnHelloLearnUrl(undefined), null);
  assert.equal(ctx.ytLearnHelloLearnUrl('hello.a..b'), null);
  assert.equal(ctx.ytLearnHelloLearnUrl('hello.system-design.patterns.dealing-with-contention'),
    'https://www.hellointerview.com/learn/system-design/patterns/dealing-with-contention');
  assert.equal(ctx.ytLearnParseLessonId(ctx.ytLearnHelloLearnUrl('hello.a.b.c.d.e.f')), 'hello.a.b.c.d.e.f');
  assert.equal(ctx.ytLearnParseVideoId('https://www.hellointerview.com/learn/a'), null);
});
