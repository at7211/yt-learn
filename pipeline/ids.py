"""Lesson ids: the one place that knows which ids exist.

YouTube ids are the 11-char `[A-Za-z0-9_-]` video id; Udemy lectures are `udemy.<lectureId>`
(the dot is outside the YouTube alphabet, so the two can never collide; also filename-safe).
JS mirrors: web/ytid.js (ESM) and extension/ytid.js (globals); all three are checked against
tests/fixtures/lesson_ids.json.
"""
from __future__ import annotations

import re
from urllib.parse import parse_qs, urlsplit

YOUTUBE_ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
UDEMY_ID_RE = re.compile(r"udemy\.([0-9]{1,12})")
LESSON_ID_RE = re.compile(r"^(?:[A-Za-z0-9_-]{11}|udemy\.[0-9]{1,12})$")
# https only, host exactly www.udemy.com, no port/userinfo; optional trailing slash, query, hash.
UDEMY_URL_RE = re.compile(
    r"https://www\.udemy\.com/course/([A-Za-z0-9_-]+)/learn/lecture/([0-9]{1,12})/?(?:[?#]\S*)?")


def _yt_ok(s):
    return s if s and YOUTUBE_ID_RE.fullmatch(s) else None


def parse_youtube_id(s) -> str | None:
    """YouTube URL or bare 11-char id -> id. Contract of pipeline.jobs.parse_video_id (tests/fixtures/urls.json)."""
    if not isinstance(s, str):
        return None
    s = s.strip()
    if YOUTUBE_ID_RE.fullmatch(s):
        return s
    try:
        u = urlsplit(s)
        host = (u.hostname or "").lower()
    except ValueError:
        return None
    if u.scheme not in ("http", "https"):
        return None
    parts = [p for p in u.path.split("/") if p]
    if host in ("youtube.com", "www.youtube.com", "m.youtube.com"):
        if u.path == "/watch":
            v = parse_qs(u.query).get("v")
            return _yt_ok(v[0]) if v else None
        if host != "m.youtube.com" and len(parts) == 2 and parts[0] in ("shorts", "embed"):
            return _yt_ok(parts[1])
    elif host == "youtu.be" and len(parts) == 1:
        return _yt_ok(parts[0])
    return None


def parse_udemy_url(url) -> tuple[str, str] | None:
    """`https://www.udemy.com/course/<slug>/learn/lecture/<digits>[/][?...][#...]` -> (slug, lectureId)."""
    if not isinstance(url, str):
        return None
    m = UDEMY_URL_RE.fullmatch(url)
    return (m.group(1), m.group(2)) if m else None


def parse_lesson_id(s) -> str | None:
    """Bare lesson id, YouTube URL, or Udemy lecture URL -> lesson id; None if unrecognised."""
    if not isinstance(s, str):
        return None
    s = s.strip()
    if LESSON_ID_RE.fullmatch(s):
        return s
    u = parse_udemy_url(s)
    if u:
        return f"udemy.{u[1]}"
    return parse_youtube_id(s)


def source_of(lesson_id) -> str | None:
    """'youtube' | 'udemy' for a valid lesson id, else None."""
    if not isinstance(lesson_id, str) or not LESSON_ID_RE.fullmatch(lesson_id):
        return None
    return "udemy" if UDEMY_ID_RE.fullmatch(lesson_id) else "youtube"
