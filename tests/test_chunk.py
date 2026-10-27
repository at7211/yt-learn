import json
from pathlib import Path

from pipeline.chunk import chunk_words
from pipeline.words import normalize_words

FIXTURE = Path(__file__).parent / "fixtures" / "raw_small.json"


def make_words(n, gaps_after=(), gap=1.2):
    """n words, 0.2s apart, with an extra `gap` after each index in gaps_after."""
    words, t = [], 0.0
    for i in range(n):
        words.append({"t": t, "e": t + 0.2, "w": f"w{i}", "timed": True})
        t += gap if i in gaps_after else 0.2
    return words


def assert_covers(ranges, n):
    assert ranges[0][0] == 0
    assert ranges[-1][1] == n - 1
    for (_, b), (a2, _) in zip(ranges, ranges[1:]):
        assert a2 == b + 1


def test_chunks_cover_all_words_contiguously():
    raw = json.loads(FIXTURE.read_text())
    events, duration = raw["events"], raw["duration"]
    words = normalize_words(events, duration)
    ranges = chunk_words(words)
    assert words
    assert_covers(ranges, len(words))


def test_empty_input_gives_no_chunks():
    assert chunk_words([]) == []


def test_picks_gap_closest_to_target_within_window():
    words = make_words(150, gaps_after={100, 125})
    assert chunk_words(words) == [(0, 125), (126, 149)]


def test_gap_uses_next_start_minus_current_start():
    # word 100 has a long duration (e) but next start is only 0.9s later
    words = make_words(150)
    base = 10.0
    for i in range(101, 150):
        words[i]["t"] = base + 0.9 + (i - 101) * 0.2
        words[i]["e"] = words[i]["t"] + 0.2
    words[100]["t"], words[100]["e"] = base, base + 1.5
    for i in range(100):
        words[i]["t"] = base - (100 - i) * 0.2
        words[i]["e"] = words[i]["t"] + 0.2
    # e-based gap would be negative/odd; start-based gap is 0.9 -> no cut
    assert chunk_words(words) == [(0, 149)]
    # next start exactly 1.0s later -> cut point
    shift = 0.1
    for i in range(101, 150):
        words[i]["t"] += shift
        words[i]["e"] += shift
    assert chunk_words(words) == [(0, 100), (101, 149)]


def test_hard_max_forces_split_without_gap():
    words = make_words(200)
    ranges = chunk_words(words)
    assert ranges == [(0, 159), (160, 199)]
    assert all(b - a + 1 <= 160 for a, b in ranges)
    assert_covers(ranges, 200)
