import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVideoId, canonicalUrl, parseLessonId, lessonSource, parseUdemyUrl } from '../../web/ytid.js';

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
test('lessonSource agrees with lesson_ids.json', () => {
  for (const [input, want] of ids.source) assert.equal(lessonSource(input), want, JSON.stringify(input));
  for (const bad of [null, undefined, 42]) {
    assert.equal(lessonSource(bad), null);
    assert.equal(parseLessonId(bad), null);
    assert.equal(parseUdemyUrl(bad), null);
  }
});
