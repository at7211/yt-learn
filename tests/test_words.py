import json
from pathlib import Path

import pytest

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
    assert [w["t"] for w in words[:3]] == pytest.approx([1.0, 1.667, 2.556], abs=1e-3)
    assert [w["timed"] for w in words] == [False, False, False, True]
    assert [w["e"] for w in words[:3]] == pytest.approx([1.667, 2.556, 3.0], abs=1e-3)


def test_untimed_words_spread_by_char_length():
    ev = [{"t": 0, "d": 10000, "segs": [[None, "aa bbbbbbbb c"]]}]  # 2 + 1 + 8 + 1 + 1 = 13 chars
    words = normalize_words(ev, 20)
    assert [w["t"] for w in words] == pytest.approx([0.0, 10 * 3 / 13, 10 * 12 / 13], abs=1e-3)
    assert words[0]["e"] == words[1]["t"] and words[1]["e"] == words[2]["t"]
    assert words[2]["e"] == 10.0
    assert all(w["timed"] is False for w in words)


def test_untimed_words_strictly_increasing_and_two_cues_in_one_event_distinct():
    ev = [{"t": 1000, "d": 3000, "segs": [[None, "I went home. Then we"]]}]
    words = normalize_words(ev, 10)
    ts = [w["t"] for w in words]
    assert all(b > a for a, b in zip(ts, ts[1:]))
    # a cue boundary after "home." (index 2) gives distinct cue starts
    assert words[3]["t"] > words[0]["t"]


def test_untimed_tiny_event_still_strictly_increasing():
    ev = [{"t": 1000, "d": 1, "segs": [[None, "a b c"]]}]
    ts = [w["t"] for w in normalize_words(ev, 10)]
    assert all(b > a for a, b in zip(ts, ts[1:]))


def test_untimed_zero_duration_event_shares_start():
    ev = [{"t": 4000, "d": 0, "segs": [[None, "x y"]]}]
    words = normalize_words(ev, 10)
    assert [(w["t"], w["e"]) for w in words] == [(4.0, 4.0), (4.0, 4.0)]


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
    assert words[0]["w"] == "Bonjour"
    assert words[0]["t"] == 10.8
    assert all(w["timed"] is True for w in words)
    ts = [w["t"] for w in words]
    assert ts == sorted(ts)
    assert all(w["e"] > w["t"] for w in words)


def test_timed_word_without_later_greater_t_gets_one_second_span():
    ev = [{"t": 1000, "d": 500, "segs": [[0, "a"], [0, "b"]]}]
    words = normalize_words(ev, 10)
    assert [w["e"] for w in words] == [2.0, 2.0]


def test_end_never_before_start():
    ev = [{"t": 4000, "d": 0, "segs": [[None, "x y"]]}]
    words = normalize_words(ev, 10)
    assert [(w["t"], w["e"]) for w in words] == [(4.0, 4.0), (4.0, 4.0)]


def test_non_monotonic_t_uses_next_greater():
    ev = [{"t": 0, "d": 5000, "segs": [[2000, "a"], [1000, "b"], [3000, "c"]]}]
    words = normalize_words(ev, 10)
    # b (t=1.0): next greater later t is 3.0, capped at 1.0 + 1.5 = 2.5
    assert [w["e"] for w in words] == [3.0, 2.5, 4.0]


def test_unescapes_amp_and_drops_whitespace_only_untimed_seg():
    ev = [{"t": 0, "d": 1000, "segs": [[0, "a&amp;b"], [None, "&#32;&#32;"], [500, "z"]]}]
    words = normalize_words(ev, 10)
    assert [w["w"] for w in words] == ["a&b", "z"]


def test_leading_untimed_run_stops_at_the_next_timed_word_and_drops_speaker_marker():
    # Real ASR event: ">> I" untimed, then timed words 200/360/520 ms into the event.
    ev = [{"t": 40200, "d": 2520, "segs": [[None, ">> I"], [200, "can"], [360, "go"], [520, "lower."]]},
          {"t": 42720, "d": 1000, "segs": [[0, "next"]]}]
    w = normalize_words(ev, 60)
    assert [x["w"] for x in w] == ["I", "can", "go", "lower.", "next"]
    assert w[0] == {"t": 40.2, "e": 40.4, "w": "I", "timed": False}
    assert w[1]["t"] == 40.4
    assert all(w[i]["t"] >= w[i - 1]["t"] for i in range(1, len(w)))


def test_untimed_run_after_timed_words_starts_just_after_them():
    ev = [{"t": 1000, "d": 2000, "segs": [[0, "a"], [500, "b"], [None, "c dd"]]}]
    w = normalize_words(ev, 60)
    assert [x["w"] for x in w] == ["a", "b", "c", "dd"]
    assert w[1]["t"] == 1.5 and w[2]["t"] == 1.501 and w[2]["t"] < w[3]["t"] <= 3.0
    assert w[3]["e"] == 3.0


def test_trailing_untimed_run_stops_at_the_next_event_start():
    # Real ASR: event 1 ends after event 2 starts; its trailing untimed run must not overtake event 2's words.
    ev = [{"t": 218760, "d": 2920, "segs": [[0, "a"], [None, "um er"]]},
          {"t": 219440, "d": 1000, "segs": [[0, "an"], [120, "application"]]}]
    w = normalize_words(ev, 300)
    assert [x["w"] for x in w] == ["a", "um", "er", "an", "application"]
    assert all(w[i]["t"] >= w[i - 1]["t"] for i in range(1, len(w)))
    assert w[2]["e"] <= 219.44


def test_bracketed_sound_tags_are_dropped():
    ev = [{"t": 1000, "d": 2000, "segs": [[0, "a"], [None, "[clears throat]"]]},
          {"t": 3000, "d": 1000, "segs": [[None, ">> [Music]"], [100, "b"], [300, "[Applause]"]]}]
    w = normalize_words(ev, 60)
    assert [x["w"] for x in w] == ["a", "b"]
