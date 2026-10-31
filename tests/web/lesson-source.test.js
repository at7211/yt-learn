import { test } from 'node:test';
import assert from 'node:assert/strict';
import { udemyLessonLink, listRowSourceLink, canBuildHere } from '../../web/lesson-source.js';

const URL5 = 'https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738';

test('canBuildHere refuses only udemy ids', () => {
  assert.equal(canBuildHere('puh91fohvTA'), true);
  assert.equal(canBuildHere('udemy.5800738'), false);
  assert.equal(canBuildHere('bogus'), true);
});

test('udemyLessonLink validates host, path and id match', () => {
  assert.equal(udemyLessonLink({ videoId: 'udemy.5800738', sourceUrl: URL5 }, 'udemy.5800738'), URL5);
  assert.equal(udemyLessonLink({ videoId: 'udemy.5800738', sourceUrl: URL5 }), URL5);
  assert.equal(udemyLessonLink({ sourceUrl: URL5 }, 'udemy.1'), null);
  assert.equal(udemyLessonLink({ sourceUrl: URL5 }, 'puh91fohvTA'), null);
  for (const bad of ['javascript:alert(1)', 'http://www.udemy.com/course/a/learn/lecture/5800738',
    'https://evil.com/course/a/learn/lecture/5800738', 'https://www.udemy.com.evil.com/course/a/learn/lecture/5800738', '', null, 42]) {
    assert.equal(udemyLessonLink({ sourceUrl: bad }, 'udemy.5800738'), null, String(bad));
  }
  assert.equal(udemyLessonLink(null, 'udemy.5800738'), null);
});

test('listRowSourceLink needs source=udemy and a valid url', () => {
  assert.equal(listRowSourceLink({ videoId: 'udemy.5800738', source: 'udemy', sourceUrl: URL5 }), URL5);
  assert.equal(listRowSourceLink({ videoId: 'udemy.5800738', sourceUrl: URL5 }), null);
  assert.equal(listRowSourceLink({ videoId: 'udemy.5800738', source: 'udemy', sourceUrl: 'https://evil.com/x' }), null);
  assert.equal(listRowSourceLink({ videoId: 'puh91fohvTA', source: 'youtube' }), null);
});
