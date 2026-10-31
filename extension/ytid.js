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

  /* Lesson ids（與 pipeline/ids.py 同一張表 tests/fixtures/lesson_ids.json）：YouTube 11 碼或 udemy.<lectureId>。 */
  const LESSON_ID_RE = /^(?:[A-Za-z0-9_-]{11}|udemy\.[0-9]{1,12})$/;
  const UDEMY_ID_RE = /^udemy\.[0-9]{1,12}$/;
  const UDEMY_URL_RE = /^https:\/\/www\.udemy\.com\/course\/([A-Za-z0-9_-]+)\/learn\/lecture\/([0-9]{1,12})\/?(?:[?#]\S*)?$/;
  g.ytLearnParseUdemyUrl = function (url) {
    if (typeof url !== 'string') return null;
    const m = UDEMY_URL_RE.exec(url);
    return m ? { slug: m[1], lectureId: m[2] } : null;
  };
  g.ytLearnParseLessonId = function (s) {
    if (typeof s !== 'string') return null;
    s = s.trim();
    if (LESSON_ID_RE.test(s)) return s;
    const u = g.ytLearnParseUdemyUrl(s);
    if (u) return 'udemy.' + u.lectureId;
    return g.ytLearnParseVideoId(s);
  };
  g.ytLearnLessonSource = function (id) {
    if (typeof id !== 'string' || !LESSON_ID_RE.test(id)) return null;
    return UDEMY_ID_RE.test(id) ? 'udemy' : 'youtube';
  };
})(globalThis);
