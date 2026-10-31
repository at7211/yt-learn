// Pure helpers for lessons that come from different sources (YouTube / Udemy).
import { lessonSource, parseUdemyUrl } from './ytid.js';

export const UDEMY_BUILD_MSG = 'Udemy 課程請在講座頁按擴充圖示產生';
export const UDEMY_PLAY_HINT = '在 Udemy 頁面上播放';

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

// Link for a /lessons row: validated sourceUrl for udemy rows, else null.
export function listRowSourceLink(row) {
  if (!row || row.source !== 'udemy') return null;
  return udemyLessonLink(row, row.videoId);
}

// Can a build be started from the local page for this lesson id?
export function canBuildHere(id) {
  return lessonSource(id) !== 'udemy';
}
