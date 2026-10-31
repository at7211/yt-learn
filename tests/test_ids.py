import json
from pathlib import Path

from pipeline.ids import LESSON_ID_RE, parse_lesson_id, parse_udemy_url, source_of

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


def test_source_of_table():
    for inp, want in TABLE["source"]:
        assert source_of(inp) == want, inp


def test_non_strings():
    for bad in (None, 42, ["udemy.1"], b"udemy.1"):
        assert parse_lesson_id(bad) is None
        assert parse_udemy_url(bad) is None
        assert source_of(bad) is None


def test_lesson_id_re_is_anchored():
    assert LESSON_ID_RE.fullmatch("udemy.5800738")
    assert not LESSON_ID_RE.fullmatch("udemy.5800738\n")
    assert not LESSON_ID_RE.fullmatch("../udemy.1")
