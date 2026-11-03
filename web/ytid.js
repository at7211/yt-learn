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
// YouTube 11-char id, `udemy.<lectureId>` for a Udemy lecture, `netflix.<movieId>` for a Netflix title,
// `hello.<path>` for a HelloInterview learn page (path after /learn/, `/` -> `.`, 1-6 segments, <= 120 chars;
// the length cap lives only in the LESSON_ID_RE / HELLO_ID_RE lookahead), or `coursera.<courseSlug>.<itemId>`
// for a Coursera lecture.
const LESSON_ID_RE = /^(?:[A-Za-z0-9_-]{11}|udemy\.[0-9]{1,12}|netflix\.[0-9]{1,12}|hello\.(?=[a-z0-9.-]{1,120}$)[a-z0-9-]+(?:\.[a-z0-9-]+){0,5}|coursera\.[A-Za-z0-9_-]{1,120}\.[A-Za-z0-9_-]{1,32})$/;
const UDEMY_ID_RE = /^udemy\.[0-9]{1,12}$/;
const NETFLIX_ID_RE = /^netflix\.[0-9]{1,12}$/;
const HELLO_ID_RE = /^hello\.((?=[a-z0-9.-]{1,120}$)[a-z0-9-]+(?:\.[a-z0-9-]+){0,5})$/;
const COURSERA_ID_RE = /^coursera\.[A-Za-z0-9_-]{1,120}\.[A-Za-z0-9_-]{1,32}$/;
const NETFLIX_URL_RE = /^https:\/\/www\.netflix\.com\/watch\/([0-9]{1,12})\/?(?:[?#]\S*)?$/;
const HELLO_URL_RE = /^https:\/\/www\.hellointerview\.com\/learn\/((?:[a-z0-9-]+\/){0,5}[a-z0-9-]+)\/?(?:[?#]\S*)?$/;
const UDEMY_URL_RE = /^https:\/\/www\.udemy\.com\/course\/([A-Za-z0-9_-]+)\/learn\/lecture\/([0-9]{1,12})\/?(?:[?#]\S*)?$/;
const COURSERA_URL_RE = /^https:\/\/www\.coursera\.org\/learn\/([A-Za-z0-9_-]{1,120})\/lecture\/([A-Za-z0-9_-]{1,32})(?:\/[A-Za-z0-9_.~%-]*)?\/?(?:[?#]\S*)?$/;

// https://www.udemy.com/course/<slug>/learn/lecture/<digits>[/][?...][#...] -> {slug, lectureId} | null
export function parseUdemyUrl(url) {
  if (typeof url !== 'string') return null;
  const m = UDEMY_URL_RE.exec(url);
  return m ? { slug: m[1], lectureId: m[2] } : null;
}

// https://www.netflix.com/watch/<digits>[/][?...][#...] -> movieId | null
export function parseNetflixUrl(url) {
  if (typeof url !== 'string') return null;
  const m = NETFLIX_URL_RE.exec(url);
  return m ? m[1] : null;
}

// Canonical sourceUrl of a Netflix lesson.
export function netflixWatchUrl(movieId) {
  return 'https://www.netflix.com/watch/' + movieId;
}

// https://www.hellointerview.com/learn/<path>[/][?...][#...] -> path ('a/b/c', <= 120 chars) | null.
// An explicit :443, userinfo, other hosts/ports, uppercase and %-escapes are all rejected.
export function parseHelloUrl(url) {
  if (typeof url !== 'string') return null;
  const m = HELLO_URL_RE.exec(url);
  return m && LESSON_ID_RE.test('hello.' + m[1].replace(/\//g, '.')) ? m[1] : null;
}

// Canonical sourceUrl of a HelloInterview lesson (no query, hash or trailing slash); null if not a hello id.
export function helloLearnUrl(id) {
  const m = typeof id === 'string' ? HELLO_ID_RE.exec(id) : null;
  return m ? 'https://www.hellointerview.com/learn/' + m[1].replace(/\./g, '/') : null;
}

// https://www.coursera.org/learn/<slug>/lecture/<itemId>[/<title>][/][?...][#...] -> {slug, itemId} | null
export function parseCourseraUrl(url) {
  if (typeof url !== 'string') return null;
  const m = COURSERA_URL_RE.exec(url);
  return m ? { slug: m[1], itemId: m[2] } : null;
}

// Bare lesson id, YouTube URL, Udemy lecture URL, Netflix watch URL, HelloInterview learn URL or Coursera
// lecture URL -> lesson id | null
export function parseLessonId(s) {
  if (typeof s !== 'string') return null;
  s = s.trim();
  if (LESSON_ID_RE.test(s)) return s;
  const u = parseUdemyUrl(s);
  if (u) return 'udemy.' + u.lectureId;
  const n = parseNetflixUrl(s);
  if (n) return 'netflix.' + n;
  const h = parseHelloUrl(s);
  if (h) return 'hello.' + h.replace(/\//g, '.');
  const c = parseCourseraUrl(s);
  if (c) return 'coursera.' + c.slug + '.' + c.itemId;
  return parseVideoId(s);
}

// 'youtube' | 'udemy' | 'netflix' | 'hellointerview' | 'coursera' for a valid lesson id, else null
export function lessonSource(id) {
  if (typeof id !== 'string' || !LESSON_ID_RE.test(id)) return null;
  if (UDEMY_ID_RE.test(id)) return 'udemy';
  if (NETFLIX_ID_RE.test(id)) return 'netflix';
  if (HELLO_ID_RE.test(id)) return 'hellointerview';
  if (COURSERA_ID_RE.test(id)) return 'coursera';
  return 'youtube';
}
