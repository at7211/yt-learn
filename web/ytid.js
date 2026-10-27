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
