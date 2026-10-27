import json
from pathlib import Path

from pipeline.words import normalize_words

FIXTURE = Path(__file__).parent / "fixtures" / "raw_small.json"


def test_timed_segs_become_words_with_end_capped():
    ev = [{"t": 0, "d": 6000, "segs": [[0, "a"], [500, "b"], [5000, "c"]]}]
    words = normalize_words(ev, 10)
    assert [w["t"] for w in words] == [0, 0.5, 5.0]
    assert [w["e"] for w in words] == [0.5, 2.0, 6.0]
    assert all(w["timed"] is True for w in words)


def test_untimed_event_marks_words_untimed():
    ev = [
        {"t": 1000, "d": 2000, "segs": [[None, "we can go"]]},
        {"t": 3000, "d": 1000, "segs": [[0, "now"]]},
    ]
    words = normalize_words(ev, 10)
    assert [w["w"] for w in words] == ["we", "can", "go", "now"]
    assert [w["t"] for w in words[:3]] == [1.0, 1.0, 1.0]
    assert [w["timed"] for w in words] == [False, False, False, True]
    assert [w["e"] for w in words[:3]] == [3.0, 3.0, 3.0]


def test_last_word_end_clamped_to_duration():
    ev = [{"t": 9500, "d": 500, "segs": [[0, "end"]]}]
    words = normalize_words(ev, 10)
    assert words[-1]["t"] == 9.5
    assert words[-1]["e"] == 10.0


def test_strips_entities_newlines_and_blank():
    ev = [{"t": 0, "d": 1000, "segs": [[0, "he&#39;s"], [200, "\n"], [400, ""], [600, "ok"]]}]
    words = normalize_words(ev, 10)
    assert [w["w"] for w in words] == ["he's", "ok"]


def test_fixture_asr_words():
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    words = normalize_words(raw["events"], raw["duration"])
    assert words[0]["w"] == "pretends"
    assert words[0]["t"] == 0.28
    assert all(w["timed"] is True for w in words)
    ts = [w["t"] for w in words]
    assert ts == sorted(ts)
    assert all(w["e"] > w["t"] for w in words)
