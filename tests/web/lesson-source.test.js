import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  udemyLessonLink, netflixLessonLink, helloLessonLink, courseraLessonLink, listRowSourceLink, listRowSite, canBuildHere,
  externalSite, UDEMY_BUILD_MSG, UDEMY_PLAY_HINT, NETFLIX_BUILD_MSG, NETFLIX_PLAY_HINT,
  HELLO_BUILD_MSG, HELLO_PLAY_HINT, COURSERA_BUILD_MSG, COURSERA_PLAY_HINT,
} from '../../web/lesson-source.js';

const URL5 = 'https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738';

test('canBuildHere is true only for a valid YouTube id', () => {
  assert.equal(canBuildHere('puh91fohvTA'), true);
  assert.equal(canBuildHere('udemy-12345'), true); // 11 chars: a YouTube id
  assert.equal(canBuildHere('udemy.5800738'), false);
  assert.equal(canBuildHere('netflix.81234567'), false);
  for (const bad of ['bogus', '', null, undefined, 42, 'netflix.abc']) assert.equal(canBuildHere(bad), false, String(bad));
});

test('externalSite: null for YouTube and invalid ids; Udemy, Netflix and HelloInterview carry their own copy and link', () => {
  for (const id of ['puh91fohvTA', 'bogus', '', null, undefined, 'netflix.', 'udemy.x']) assert.equal(externalSite(id), null, String(id));
  const u = externalSite('udemy.5800738');
  assert.equal(u.name, 'Udemy');
  assert.equal(u.buildMsg, UDEMY_BUILD_MSG);
  assert.equal(u.playHint, UDEMY_PLAY_HINT);
  assert.equal(u.link({ videoId: 'udemy.5800738', sourceUrl: URL5 }, 'udemy.5800738'), URL5);
  assert.equal(u.link({ videoId: 'udemy.5800738' }, 'udemy.5800738'), null, 'Udemy needs a matching sourceUrl');
  const n = externalSite('netflix.81234567');
  assert.equal(n.name, 'Netflix');
  assert.equal(n.buildMsg, NETFLIX_BUILD_MSG);
  assert.equal(n.playHint, NETFLIX_PLAY_HINT);
  assert.match(n.buildMsg, /Netflix 播放頁按擴充圖示/);
  assert.equal(n.link({}, 'netflix.81234567'), 'https://www.netflix.com/watch/81234567');
  const h = externalSite('hello.a.b');
  assert.equal(h.name, 'HelloInterview');
  assert.equal(h.buildMsg, HELLO_BUILD_MSG);
  assert.equal(h.playHint, HELLO_PLAY_HINT);
  for (const site of [u, n, h]) {
    assert.ok(site.note && site.linkText, site.name);
    assert.ok(Object.isFrozen(site), site.name);
  }
});

test('Coursera lessons: built on their own page, with a validated link back to the lecture', () => {
  const id = 'coursera.machine-learning.iYR2y';
  const url = 'https://www.coursera.org/learn/machine-learning/lecture/iYR2y/supervised-learning';
  assert.equal(canBuildHere(id), false);
  const c = externalSite(id);
  assert.equal(c.name, 'Coursera');
  assert.equal(c.buildMsg, COURSERA_BUILD_MSG);
  assert.equal(c.playHint, COURSERA_PLAY_HINT);
  assert.ok(c.note && c.linkText && Object.isFrozen(c));
  assert.equal(c.link({ videoId: id, sourceUrl: url }, id), url);
  assert.equal(courseraLessonLink({ videoId: id, sourceUrl: url }), url);
  assert.equal(courseraLessonLink({ videoId: id }), null, 'needs a matching sourceUrl');
  assert.equal(courseraLessonLink({ sourceUrl: url }, 'coursera.machine-learning.other'), null);
  assert.equal(courseraLessonLink({ sourceUrl: url }, 'coursera.other-course.iYR2y'), null);
  assert.equal(courseraLessonLink({ sourceUrl: url }, 'puh91fohvTA'), null);
  for (const bad of ['javascript:alert(1)', 'http://www.coursera.org/learn/machine-learning/lecture/iYR2y',
    'https://evil.com/learn/machine-learning/lecture/iYR2y', 'https://www.coursera.org.evil.com/learn/machine-learning/lecture/iYR2y', '', null, 42]) {
    assert.equal(courseraLessonLink({ sourceUrl: bad }, id), null, String(bad));
  }
  assert.equal(courseraLessonLink(null, id), null);
  const row = { videoId: id, source: 'coursera', sourceUrl: url };
  assert.equal(listRowSite(row).name, 'Coursera');
  assert.equal(listRowSourceLink(row), url);
  assert.equal(listRowSite({ videoId: id }), null);
  assert.equal(listRowSourceLink({ ...row, sourceUrl: 'https://evil.com/x' }), null);
});

test('netflixLessonLink is derived from the id, never from sourceUrl', () => {
  assert.equal(netflixLessonLink({ videoId: 'netflix.81234567', sourceUrl: 'https://evil.com/' }), 'https://www.netflix.com/watch/81234567');
  assert.equal(netflixLessonLink(null, 'netflix.1'), 'https://www.netflix.com/watch/1');
  assert.equal(netflixLessonLink({ videoId: 'udemy.1' }), null);
  assert.equal(netflixLessonLink({}, 'puh91fohvTA'), null);
  assert.equal(netflixLessonLink(null, null), null);
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

test('listRowSite / listRowSourceLink for Netflix rows need source=netflix', () => {
  const row = { videoId: 'netflix.81234567', source: 'netflix', sourceUrl: 'https://www.netflix.com/watch/81234567' };
  assert.equal(listRowSite(row).name, 'Netflix');
  assert.equal(listRowSourceLink(row), 'https://www.netflix.com/watch/81234567');
  assert.equal(listRowSite({ videoId: 'netflix.81234567' }), null);
  assert.equal(listRowSite({ videoId: 'netflix.81234567', source: 'udemy' }), null);
  assert.equal(listRowSite({ videoId: 'puh91fohvTA', source: 'youtube' }), null);
  assert.equal(listRowSite(null), null);
  assert.equal(listRowSourceLink({ videoId: 'netflix.81234567', source: 'netflix' }), 'https://www.netflix.com/watch/81234567');
});

test('helloLessonLink derives the learn URL from the id and ignores sourceUrl', () => {
  const want = 'https://www.hellointerview.com/learn/a/b';
  assert.equal(helloLessonLink({ videoId: 'hello.a.b', sourceUrl: 'https://evil.com/' }), want);
  assert.equal(helloLessonLink(null, 'hello.a.b'), want);
  assert.equal(helloLessonLink({ videoId: 'udemy.1' }), null);
  assert.equal(helloLessonLink({}, 'puh91fohvTA'), null);
  assert.equal(helloLessonLink({ videoId: 'hello.A' }), null);
  assert.equal(helloLessonLink(null, null), null);
});

test('listRowSourceLink needs source=hellointerview for hello rows', () => {
  const row = { videoId: 'hello.a.b', source: 'hellointerview', sourceUrl: 'https://evil.com/' };
  assert.equal(listRowSite(row).name, 'HelloInterview');
  assert.equal(listRowSourceLink(row), 'https://www.hellointerview.com/learn/a/b');
  assert.equal(listRowSourceLink({ videoId: 'hello.a.b' }), null);
  assert.equal(listRowSourceLink({ videoId: 'hello.a.b', source: 'udemy' }), null);
});

test('canBuildHere is false for hello ids', () => {
  assert.equal(canBuildHere('hello.a.b'), false);
  assert.equal(canBuildHere('hello.system-design'), false);
});
