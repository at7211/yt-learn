// Pure helpers for lessons that come from different sources. YouTube lessons are built and played
// here; external-site lessons (Udemy, Netflix, Coursera) are captured and played on their own site, through
// the extension, and only reviewed here.
import { lessonSource, parseUdemyUrl, parseCourseraUrl, netflixWatchUrl } from './ytid.js';

export const UDEMY_BUILD_MSG = 'Udemy 課程請在講座頁按擴充圖示產生';
export const UDEMY_PLAY_HINT = '在 Udemy 頁面上播放';
export const NETFLIX_BUILD_MSG = 'Netflix 課程要在 Netflix 播放頁按擴充圖示擷取';
export const NETFLIX_PLAY_HINT = '這是 Netflix 課程，請到 Netflix 播放頁按擴充圖示觀看';
export const COURSERA_BUILD_MSG = 'Coursera 課程請在影片頁按擴充圖示產生';
export const COURSERA_PLAY_HINT = '在 Coursera 頁面上播放';

// A lesson's sourceUrl, only if it is a valid Udemy lecture URL whose lecture id
// matches the lesson id (udemy.<digits>). Returns the URL string or null.
export function udemyLessonLink(lesson, id) {
  if (!lesson || typeof lesson !== 'object') return null;
  const lid = typeof id === 'string' ? id : lesson.videoId;
  if (lessonSource(lid) !== 'udemy') return null;
  const u = parseUdemyUrl(lesson.sourceUrl);
  if (!u || 'udemy.' + u.lectureId !== lid) return null;
  return lesson.sourceUrl;
}

// The canonical watch page of a Netflix lesson, derived from the id alone (sourceUrl is not trusted).
export function netflixLessonLink(lesson, id) {
  const lid = typeof id === 'string' ? id : (lesson && typeof lesson === 'object' ? lesson.videoId : null);
  if (lessonSource(lid) !== 'netflix') return null;
  return netflixWatchUrl(lid.slice('netflix.'.length));
}

// A lesson's sourceUrl, only if it is a valid Coursera lecture URL of that very lecture
// (coursera.<slug>.<itemId>). Returns the URL string or null.
export function courseraLessonLink(lesson, id) {
  if (!lesson || typeof lesson !== 'object') return null;
  const lid = typeof id === 'string' ? id : lesson.videoId;
  if (lessonSource(lid) !== 'coursera') return null;
  const u = parseCourseraUrl(lesson.sourceUrl);
  if (!u || 'coursera.' + u.slug + '.' + u.itemId !== lid) return null;
  return lesson.sourceUrl;
}

const SITES = Object.freeze({
  udemy: Object.freeze({
    name: 'Udemy', buildMsg: UDEMY_BUILD_MSG, playHint: UDEMY_PLAY_HINT,
    note: '這堂課只能在 Udemy 頁面上疊字幕', linkText: '回到講座頁', link: udemyLessonLink,
  }),
  netflix: Object.freeze({
    name: 'Netflix', buildMsg: NETFLIX_BUILD_MSG, playHint: NETFLIX_PLAY_HINT,
    note: '這堂課只能在 Netflix 播放頁上疊字幕', linkText: '回到播放頁', link: netflixLessonLink,
  }),
  coursera: Object.freeze({
    name: 'Coursera', buildMsg: COURSERA_BUILD_MSG, playHint: COURSERA_PLAY_HINT,
    note: '這堂課只能在 Coursera 頁面上疊字幕', linkText: '回到影片頁', link: courseraLessonLink,
  }),
});

// null for a YouTube (or invalid) id; for a lesson that lives on another site:
// { name, buildMsg, playHint, note, linkText, link(lesson, id) -> href | null }.
// Such lessons have no background mode and no player here.
export function externalSite(id) {
  return SITES[lessonSource(id)] || null;
}

// The external site of a /lessons row, only when its `source` agrees with its id.
export function listRowSite(row) {
  if (!row || typeof row !== 'object' || row.source !== lessonSource(row.videoId)) return null;
  return externalSite(row.videoId);
}

// Link for a /lessons row: the external site's validated link, else null.
export function listRowSourceLink(row) {
  const site = listRowSite(row);
  return site ? site.link(row, row.videoId) : null;
}

// Can a build be started from the local page for this lesson id? Only for a valid YouTube id.
export function canBuildHere(id) {
  return lessonSource(id) === 'youtube';
}
