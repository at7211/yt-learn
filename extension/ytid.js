/* ytLearnParseVideoId 與 pipeline/jobs.py::parse_video_id 同一張表（tests/fixtures/urls.json）；改一邊請同步另一邊。 */
(function (g) {
  const ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const ok = (s) => (typeof s === 'string' && ID_RE.test(s) ? s : null);
  g.ytLearnParseVideoId = function (s) {
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
  };
  g.ytLearnCanonicalUrl = (id) => 'https://www.youtube.com/watch?v=' + id;

  /* Lesson ids（與 pipeline/ids.py 同一張表 tests/fixtures/lesson_ids.json）：YouTube 11 碼、udemy.<lectureId>、netflix.<movieId> 或 coursera.<課程 slug>.<itemId>。 */
  const LESSON_ID_RE = /^(?:[A-Za-z0-9_-]{11}|udemy\.[0-9]{1,12}|netflix\.[0-9]{1,12}|coursera\.[A-Za-z0-9_-]{1,120}\.[A-Za-z0-9_-]{1,32})$/;
  const UDEMY_ID_RE = /^udemy\.[0-9]{1,12}$/;
  const NETFLIX_ID_RE = /^netflix\.[0-9]{1,12}$/;
  const COURSERA_ID_RE = /^coursera\.[A-Za-z0-9_-]{1,120}\.[A-Za-z0-9_-]{1,32}$/;
  const NETFLIX_URL_RE = /^https:\/\/www\.netflix\.com\/watch\/([0-9]{1,12})\/?(?:[?#]\S*)?$/;
  const UDEMY_URL_RE = /^https:\/\/www\.udemy\.com\/course\/([A-Za-z0-9_-]+)\/learn\/lecture\/([0-9]{1,12})\/?(?:[?#]\S*)?$/;
  const COURSERA_URL_RE = /^https:\/\/www\.coursera\.org\/learn\/([A-Za-z0-9_-]{1,120})\/lecture\/([A-Za-z0-9_-]{1,32})(?:\/[A-Za-z0-9_.~%-]*)?\/?(?:[?#]\S*)?$/;
  g.ytLearnParseUdemyUrl = function (url) {
    if (typeof url !== 'string') return null;
    const m = UDEMY_URL_RE.exec(url);
    return m ? { slug: m[1], lectureId: m[2] } : null;
  };
  g.ytLearnParseNetflixUrl = function (url) {
    if (typeof url !== 'string') return null;
    const m = NETFLIX_URL_RE.exec(url);
    return m ? m[1] : null;
  };
  g.ytLearnNetflixWatchUrl = (movieId) => 'https://www.netflix.com/watch/' + movieId;
  g.ytLearnParseCourseraUrl = function (url) {
    if (typeof url !== 'string') return null;
    const m = COURSERA_URL_RE.exec(url);
    return m ? { slug: m[1], itemId: m[2] } : null;
  };
  g.ytLearnParseLessonId = function (s) {
    if (typeof s !== 'string') return null;
    s = s.trim();
    if (LESSON_ID_RE.test(s)) return s;
    const u = g.ytLearnParseUdemyUrl(s);
    if (u) return 'udemy.' + u.lectureId;
    const n = g.ytLearnParseNetflixUrl(s);
    if (n) return 'netflix.' + n;
    const c = g.ytLearnParseCourseraUrl(s);
    if (c) return 'coursera.' + c.slug + '.' + c.itemId;
    return g.ytLearnParseVideoId(s);
  };
  g.ytLearnLessonSource = function (id) {
    if (typeof id !== 'string' || !LESSON_ID_RE.test(id)) return null;
    if (UDEMY_ID_RE.test(id)) return 'udemy';
    if (NETFLIX_ID_RE.test(id)) return 'netflix';
    if (COURSERA_ID_RE.test(id)) return 'coursera';
    return 'youtube';
  };
})(globalThis);
