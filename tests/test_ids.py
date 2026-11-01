import json
from pathlib import Path

from pipeline.ids import (LESSON_ID_RE, hello_learn_url, netflix_watch_url, parse_coursera_url, parse_hello_url,
                          parse_lesson_id, parse_netflix_url, parse_udemy_url, source_of)

TABLE = json.loads((Path(__file__).parent / "fixtures" / "lesson_ids.json").read_text("utf-8"))
URLS = json.loads((Path(__file__).parent / "fixtures" / "urls.json").read_text("utf-8"))


def test_parse_lesson_id_table():
    assert len(TABLE["parse"]) >= 30
    for inp, want in TABLE["parse"]:
        assert parse_lesson_id(inp) == want, inp


def test_parse_lesson_id_accepts_every_youtube_url_fixture():
    for inp, vid in URLS["accept"]:
        assert parse_lesson_id(inp) == vid, inp
    for inp in URLS["reject"]:
        assert parse_lesson_id(inp) is None, inp


def test_parse_udemy_url_table():
    for inp, want in TABLE["udemyUrl"]:
        assert parse_udemy_url(inp) == (tuple(want) if want else None), inp


def test_parse_netflix_url_table():
    assert len(TABLE["netflixUrl"]) >= 8
    for inp, want in TABLE["netflixUrl"]:
        assert parse_netflix_url(inp) == want, inp
    assert netflix_watch_url("81234567") == "https://www.netflix.com/watch/81234567"


def test_parse_hello_url_table():
    assert len(TABLE["helloUrl"]) >= 25
    for inp, want in TABLE["helloUrl"]:
        assert parse_hello_url(inp) == want, inp


def test_hello_url_length_boundary():
    rows = TABLE["helloUrlLength"]
    assert {len(w) for _, w in rows if w} == {120} and sum(w is None for _, w in rows) == 4
    for inp, want in rows:
        assert parse_hello_url(inp) == want, inp
        assert parse_lesson_id(inp) == (want and "hello." + want.replace("/", ".")), inp


def test_hello_learn_url():
    url = "https://www.hellointerview.com/learn/system-design/patterns/dealing-with-contention"
    assert hello_learn_url("hello.system-design.patterns.dealing-with-contention") == url
    assert hello_learn_url("hello.system-design") == "https://www.hellointerview.com/learn/system-design"
    for lid in ("hello.a", "hello.a.b.c.d.e.f", "hello." + ".".join(["x" * 19] * 6)):
        assert parse_lesson_id(lid) == lid
        assert parse_lesson_id(hello_learn_url(lid)) == lid
        assert parse_hello_url(hello_learn_url(lid)) == lid[len("hello."):].replace(".", "/")
    for bad in ("hello.A", "hello.", "hello.a..b", "hello.a.b.c.d.e.f.g", "netflix.1", "udemy.1", "puh91fohvTA"):
        assert hello_learn_url(bad) is None, bad


def test_parse_coursera_url_table():
    assert len(TABLE["courseraUrl"]) >= 8
    for inp, want in TABLE["courseraUrl"]:
        assert parse_coursera_url(inp) == (tuple(want) if want else None), inp


def test_source_of_table():
    for inp, want in TABLE["source"]:
        assert source_of(inp) == want, inp


def test_non_strings():
    for bad in (None, 42, ["udemy.1"], b"udemy.1"):
        assert parse_lesson_id(bad) is None
        assert parse_udemy_url(bad) is None
        assert parse_netflix_url(bad) is None
        assert parse_hello_url(bad) is None
        assert hello_learn_url(bad) is None
        assert parse_coursera_url(bad) is None
        assert source_of(bad) is None


def test_lesson_id_re_is_anchored():
    assert LESSON_ID_RE.fullmatch("udemy.5800738")
    assert not LESSON_ID_RE.fullmatch("udemy.5800738\n")
    assert not LESSON_ID_RE.fullmatch("../udemy.1")
    assert LESSON_ID_RE.fullmatch("netflix.81234567")
    assert not LESSON_ID_RE.fullmatch("netflix.81234567\n")
    assert LESSON_ID_RE.fullmatch("hello.a")
    assert not LESSON_ID_RE.fullmatch("hello.a\n")
    assert not LESSON_ID_RE.fullmatch("hello.a/../b")
    assert LESSON_ID_RE.fullmatch("coursera.machine-learning.iYR2y")
    assert not LESSON_ID_RE.fullmatch("coursera.machine-learning.iYR2y\n")
    assert not LESSON_ID_RE.fullmatch("coursera.a/../b.iYR2y")
