import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVideoId, canonicalUrl, parseLessonId, lessonSource, parseUdemyUrl, parseNetflixUrl, netflixWatchUrl, parseHelloUrl, helloLearnUrl, parseCourseraUrl } from '../../web/ytid.js';

const table = JSON.parse(readFileSync(new URL('../fixtures/urls.json', import.meta.url), 'utf8'));
const ids = JSON.parse(readFileSync(new URL('../fixtures/lesson_ids.json', import.meta.url), 'utf8'));

test('parseVideoId accepts every fixture row', () => {
  for (const [input, id] of table.accept) assert.equal(parseVideoId(input), id, JSON.stringify(input));
});
test('parseVideoId rejects every fixture row', () => {
  for (const input of table.reject) assert.equal(parseVideoId(input), null, JSON.stringify(input));
});
test('parseVideoId rejects non-strings', () => {
  assert.equal(parseVideoId(null), null);
  assert.equal(parseVideoId(undefined), null);
  assert.equal(parseVideoId(42), null);
});
test('canonicalUrl', () => {
  assert.equal(canonicalUrl('puh91fohvTA'), 'https://www.youtube.com/watch?v=puh91fohvTA');
});

test('parseLessonId agrees with pipeline/ids.py on lesson_ids.json', () => {
  for (const [input, id] of ids.parse) assert.equal(parseLessonId(input), id, JSON.stringify(input));
});
test('parseLessonId accepts/rejects every urls.json row like parseVideoId', () => {
  for (const [input, id] of table.accept) assert.equal(parseLessonId(input), id, JSON.stringify(input));
  for (const input of table.reject) assert.equal(parseLessonId(input), null, JSON.stringify(input));
});
test('parseVideoId stays YouTube-only', () => {
  assert.equal(parseVideoId('udemy.5800738'), null);
  assert.equal(parseVideoId('https://www.udemy.com/course/x/learn/lecture/5800738'), null);
});
test('parseUdemyUrl agrees with lesson_ids.json', () => {
  for (const [input, want] of ids.udemyUrl) {
    assert.deepEqual(parseUdemyUrl(input), want ? { slug: want[0], lectureId: want[1] } : null, JSON.stringify(input));
  }
});
test('parseNetflixUrl agrees with lesson_ids.json; netflixWatchUrl is canonical', () => {
  assert.ok(ids.netflixUrl.length >= 8);
  for (const [input, want] of ids.netflixUrl) assert.equal(parseNetflixUrl(input), want, JSON.stringify(input));
  for (const bad of [null, undefined, 42]) assert.equal(parseNetflixUrl(bad), null);
  assert.equal(netflixWatchUrl('81234567'), 'https://www.netflix.com/watch/81234567');
  assert.equal(parseVideoId('netflix.81234567'), null);
});
test('parseHelloUrl and helloLearnUrl agree with lesson_ids.json (helloUrl and helloUrlLength)', () => {
  assert.ok(ids.helloUrl.length >= 25);
  assert.equal(ids.helloUrlLength.length, 8);
  for (const [input, want] of ids.helloUrl) assert.equal(parseHelloUrl(input), want, JSON.stringify(input));
  for (const [input, want] of ids.helloUrlLength) {
    assert.equal(parseHelloUrl(input), want, input);
    assert.equal(parseLessonId(input), want && 'hello.' + want.replace(/\//g, '.'), input);
  }
  for (const bad of [null, undefined, 42]) {
    assert.equal(parseHelloUrl(bad), null);
    assert.equal(helloLearnUrl(bad), null);
  }
  const url = 'https://www.hellointerview.com/learn/system-design/patterns/dealing-with-contention';
  assert.equal(helloLearnUrl('hello.system-design.patterns.dealing-with-contention'), url);
  for (const id of ['hello.a', 'hello.a.b.c.d.e.f', 'hello.' + 'x'.repeat(120)]) {
    assert.equal(parseLessonId(helloLearnUrl(id)), id);
  }
  for (const bad of ['hello.A', 'hello.', 'hello.a..b', 'hello.a.b.c.d.e.f.g', 'hello.' + 'x'.repeat(121), 'netflix.1']) {
    assert.equal(helloLearnUrl(bad), null, bad);
  }
  assert.equal(parseVideoId('hello.a.b'), null);
});
test('parseCourseraUrl agrees with lesson_ids.json', () => {
  assert.ok(ids.courseraUrl.length >= 8);
  for (const [input, want] of ids.courseraUrl) {
    assert.deepEqual(parseCourseraUrl(input), want ? { slug: want[0], itemId: want[1] } : null, JSON.stringify(input));
  }
  for (const bad of [null, undefined, 42]) assert.equal(parseCourseraUrl(bad), null);
  assert.equal(parseVideoId('coursera.machine-learning.iYR2y'), null);
});
test('lessonSource agrees with lesson_ids.json', () => {
  for (const [input, want] of ids.source) assert.equal(lessonSource(input), want, JSON.stringify(input));
  for (const bad of [null, undefined, 42]) {
    assert.equal(lessonSource(bad), null);
    assert.equal(parseLessonId(bad), null);
    assert.equal(parseUdemyUrl(bad), null);
  }
});
