// YouTube URL -> video id. Rules mirror pipeline/jobs.py::parse_video_id
// (both are checked against tests/fixtures/urls.json).
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ok = (s) => (s && ID_RE.test(s) ? s : null);

export function parseVideoId(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (ID_RE.test(s)) return s;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com') {
    if (u.pathname === '/watch') return ok(u.searchParams.get('v'));
    if (host !== 'm.youtube.com' && parts.length === 2 && (parts[0] === 'shorts' || parts[0] === 'embed')) return ok(parts[1]);
  } else if (host === 'youtu.be' && parts.length === 1) {
    return ok(parts[0]);
  }
  return null;
}

export function canonicalUrl(id) {
  return 'https://www.youtube.com/watch?v=' + id;
}

// Lesson ids (mirror pipeline/ids.py; shared table tests/fixtures/lesson_ids.json):
// YouTube 11-char id, or `udemy.<lectureId>` for a Udemy lecture.
const LESSON_ID_RE = /^(?:[A-Za-z0-9_-]{11}|udemy\.[0-9]{1,12})$/;
const UDEMY_ID_RE = /^udemy\.[0-9]{1,12}$/;
const UDEMY_URL_RE = /^https:\/\/www\.udemy\.com\/course\/([A-Za-z0-9_-]+)\/learn\/lecture\/([0-9]{1,12})\/?(?:[?#]\S*)?$/;

// https://www.udemy.com/course/<slug>/learn/lecture/<digits>[/][?...][#...] -> {slug, lectureId} | null
export function parseUdemyUrl(url) {
  if (typeof url !== 'string') return null;
  const m = UDEMY_URL_RE.exec(url);
  return m ? { slug: m[1], lectureId: m[2] } : null;
}

// Bare lesson id, YouTube URL or Udemy lecture URL -> lesson id | null
export function parseLessonId(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (LESSON_ID_RE.test(s)) return s;
  const u = parseUdemyUrl(s);
  if (u) return 'udemy.' + u.lectureId;
  return parseVideoId(s);
}

// 'youtube' | 'udemy' for a valid lesson id, else null
export function lessonSource(id) {
  if (typeof id !== 'string' || !LESSON_ID_RE.test(id)) return null;
  return UDEMY_ID_RE.test(id) ? 'udemy' : 'youtube';
}
