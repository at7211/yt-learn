import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  udemyLessonLink, netflixLessonLink, listRowSourceLink, listRowSite, canBuildHere, externalSite,
  UDEMY_BUILD_MSG, UDEMY_PLAY_HINT, NETFLIX_BUILD_MSG, NETFLIX_PLAY_HINT,
} from '../../web/lesson-source.js';

const URL5 = 'https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738';

test('canBuildHere is true only for a valid YouTube id', () => {
  assert.equal(canBuildHere('puh91fohvTA'), true);
  assert.equal(canBuildHere('udemy-12345'), true); // 11 chars: a YouTube id
  assert.equal(canBuildHere('udemy.5800738'), false);
  assert.equal(canBuildHere('netflix.81234567'), false);
  for (const bad of ['bogus', '', null, undefined, 42, 'netflix.abc']) assert.equal(canBuildHere(bad), false, String(bad));
});

test('externalSite: null for YouTube and invalid ids; Udemy and Netflix carry their own copy and link', () => {
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
  for (const site of [u, n]) {
    assert.ok(site.note && site.linkText, site.name);
    assert.ok(Object.isFrozen(site), site.name);
  }
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
