/* 與 pipeline/jobs.py::parse_video_id 同一張表（tests/fixtures/urls.json）；改一邊請同步另一邊。 */
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
})(globalThis);
