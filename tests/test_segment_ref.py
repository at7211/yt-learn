"""Netflix step 7: the official zh-Hant subtitle track (raw["ref"]) as a translation reference.

`ref` is always the raw["ref"] dict ({"lang","kind","events":[{"t","d","text"}]}, ms). With ref=None
the segmentation prompt and system prompt are byte-identical to before (see also test_golden.py)."""
import json
from pathlib import Path

from pipeline.build import build_lesson
from pipeline.chunk import chunk_words
from pipeline.llm import FakeProvider
from pipeline.schema import validate_lesson, validate_raw
from pipeline.segment import _clock
from pipeline.segment import (
    SEGMENT_REF_ADDENDUM,
    SEGMENT_SCHEMA,
    SEGMENT_SYSTEM,
    make_cues,
    segment_user_prompt,
)
from pipeline.words import normalize_words
from tests.test_build import INTRO

FIX = Path(__file__).parent / "fixtures"
HEAD = "官方繁中字幕（參考）："


def w(t, e, word, ev=None):
    d = {"t": t, "e": e, "w": word, "timed": True}
    if ev is not None:
        d["ev"] = ev
    return d


def ref(*events):
    return {"lang": "zh-Hant", "kind": "official",
            "events": [{"t": t, "d": d, "text": text} for t, d, text in events]}


# Words 0..5 across three source events; times in seconds.
WORDS = [
    w(1.0, 1.3, "we", 0), w(1.3, 1.6, "walked", 0), w(1.6, 2.0, "home", 0),
    w(2.5, 2.8, "it", 1), w(2.8, 3.2, "rained", 1),
    w(4.0, 4.5, "again", 2),
]


def one_cue(a, b):
    return {"cues": [{"a": a, "b": b, "tokens": [f"T{i}" for i in range(a, b + 1)], "zh": "譯"}]}


# --- ref=None: nothing changes --------------------------------------------------------------

def test_no_ref_prompt_identical_to_plain_call():
    assert segment_user_prompt(WORDS, 0, 5, ref=None) == segment_user_prompt(WORDS, 0, 5)
    assert segment_user_prompt(WORDS, 0, 5) == "\n".join(
        ["索引範圍 0..5，共 6 個單字："] + [f"{i}: {x['w']}" for i, x in enumerate(WORDS)])


def test_make_cues_without_ref_sends_the_same_three_arguments():
    prov = FakeProvider([one_cue(0, 5), one_cue(0, 5)])
    make_cues(WORDS, (0, 5), prov)
    make_cues(WORDS, (0, 5), prov, ref=None)
    expected = (SEGMENT_SYSTEM, segment_user_prompt(WORDS, 0, 5), SEGMENT_SCHEMA)
    assert prov.calls[0] == expected and prov.calls[1] == expected
    assert prov.calls[0][0] == SEGMENT_SYSTEM  # equal, no addendum


def test_make_cues_with_ref_uses_addendum_and_ref_prompt():
    r = ref((1000, 1000, "我們走回家"))
    prov = FakeProvider([one_cue(0, 5)])
    make_cues(WORDS, (0, 5), prov, ref=r)
    system, user, schema = prov.calls[0]
    assert system == SEGMENT_SYSTEM + SEGMENT_REF_ADDENDUM
    assert system.startswith(SEGMENT_SYSTEM) and SEGMENT_REF_ADDENDUM in system
    assert user == segment_user_prompt(WORDS, 0, 5, ref=r)
    assert schema is SEGMENT_SCHEMA


def test_addendum_content():
    a = SEGMENT_REF_ADDENDUM
    assert "@" in a and "時間標記" in a
    assert HEAD.rstrip("：") in a
    assert "英文語意優先" in a
    assert "不得" in a and "zh" in a
    assert "索引" in a  # reference lines are not part of the index range


# --- time markers ---------------------------------------------------------------------------

def test_markers_before_first_line_and_on_each_ev_change():
    out = segment_user_prompt(WORDS, 0, 5, ref=ref((90_000_000, 1000, "遠處")))
    assert out.split("\n") == [
        "索引範圍 0..5，共 6 個單字：",
        "@00:01.0", "0: we", "1: walked", "2: home",
        "@00:02.5", "3: it", "4: rained",
        "@00:04.0", "5: again",
    ]


def test_marker_format_floors_tenths_pads_and_exceeds_59_minutes():
    words = [w(72 * 60 + 3.49, 72 * 60 + 3.9, "late", 0), w(5.05, 5.5, "x", 1), w(0.0, 0.3, "y", 2),
             w(659.99, 660.2, "z", 3)]
    lines = segment_user_prompt(words, 0, 3, ref=ref((0, 1, "零"))).split("\n")
    assert [ln for ln in lines if ln.startswith("@")] == ["@72:03.4", "@00:05.0", "@00:00.0", "@10:59.9"]


def test_chunk_starting_mid_event_still_gets_leading_marker():
    out = segment_user_prompt(WORDS, 1, 4, ref=ref((90_000_000, 1000, "遠處")))
    assert out.split("\n")[:3] == ["索引範圍 1..4，共 4 個單字：", "@00:01.3", "1: walked"]
    assert out.count("@") == 2  # 1.3 (start) and 2.5 (ev change)


def test_missing_ev_counts_as_same_event_as_previous():
    words = [w(1.0, 1.2, "a"), w(1.2, 1.4, "b"), w(1.4, 1.6, "c", 7), w(1.6, 1.8, "d"), w(2.0, 2.2, "e", 8)]
    lines = segment_user_prompt(words, 0, 4, ref=ref((90_000_000, 1000, "遠處"))).split("\n")
    assert lines == ["索引範圍 0..4，共 5 個單字：",
                     "@00:01.0", "0: a", "1: b",
                     "@00:01.4", "2: c", "3: d",
                     "@00:02.0", "4: e"]


# --- ref block: half-open overlap, formatting ----------------------------------------------

def ref_lines(out):
    lines = out.split("\n")
    if HEAD not in lines:
        return None
    return lines[lines.index(HEAD) + 1:]


def test_half_open_overlap_boundaries():
    # chunk 0..5 spans [1.0, 4.5) s = [1000, 4500) ms
    r = ref((0, 1000, "剛好在開始前結束"),      # ends at 1000 -> excluded
            (4500, 500, "剛好在結束時開始"))     # starts at 4500 -> excluded
    out = segment_user_prompt(WORDS, 0, 5, ref=r)
    assert ref_lines(out) is None
    r = ref((0, 1001, "碰到一毫秒"), (4499, 500, "尾端一毫秒"))
    assert ref_lines(segment_user_prompt(WORDS, 0, 5, ref=r)) == [
        "00:00.0–00:01.0 碰到一毫秒", "00:04.4–00:04.9 尾端一毫秒"]


def test_ref_text_whitespace_and_newlines_collapse_to_one_line():
    r = ref((61_000, 1_000, "  第一行\n12: 像索引\n@00:00.0  也像標記 "))
    out = segment_user_prompt([w(61.0, 62.0, "later", 0)], 0, 0, ref=r)
    assert ref_lines(out) == ["01:01.0–01:02.0 第一行 12: 像索引 @00:00.0 也像標記"]


def test_explicit_none_ev_counts_as_same_event_as_previous():
    words = [w(1.0, 1.2, "a", 3), dict(w(1.2, 1.4, "b"), ev=None), w(1.4, 1.6, "c", 3)]
    lines = segment_user_prompt(words, 0, 2, ref=ref((90_000_000, 1000, "遠處"))).split("\n")
    assert lines == ["索引範圍 0..2，共 3 個單字：", "@00:01.0", "0: a", "1: b", "2: c"]


def test_ref_range_is_ms_to_seconds_with_en_dash():
    r = ref((61_234, 2_345, "一分鐘之後"))
    out = segment_user_prompt([w(61.0, 62.0, "later", 0)], 0, 0, ref=r)
    assert ref_lines(out) == ["01:01.2–01:03.5 一分鐘之後"]
    assert out.split("\n")[-2] == HEAD


def test_block_layout_after_word_lines():
    r = ref((2400, 900, "又下雨了"))
    assert segment_user_prompt(WORDS, 3, 5, ref=r).split("\n") == [
        "索引範圍 3..5，共 3 個單字：",
        "@00:02.5", "3: it", "4: rained",
        "@00:04.0", "5: again",
        "",
        HEAD,
        "00:02.4–00:03.3 又下雨了",
    ]


def test_one_ref_spanning_two_chunks_appears_in_both():
    r = ref((1500, 1500, "跨兩段的一句"))  # [1.5, 3.0)
    assert ref_lines(segment_user_prompt(WORDS, 0, 2, ref=r)) == ["00:01.5–00:03.0 跨兩段的一句"]
    assert ref_lines(segment_user_prompt(WORDS, 3, 5, ref=r)) == ["00:01.5–00:03.0 跨兩段的一句"]


def test_many_refs_inside_one_chunk_in_time_order():
    r = ref((1000, 600, "我們"), (1600, 400, "走回家"), (2500, 700, "下雨"), (4000, 400, "又來"),
            (9000, 500, "不相干"))
    assert ref_lines(segment_user_prompt(WORDS, 0, 5, ref=r)) == [
        "00:01.0–00:01.6 我們", "00:01.6–00:02.0 走回家", "00:02.5–00:03.2 下雨", "00:04.0–00:04.4 又來"]


def test_no_coverage_omits_block_but_keeps_markers():
    out = segment_user_prompt(WORDS, 0, 5, ref=ref((60_000, 1000, "很久以後")))
    assert HEAD not in out and "參考" not in out
    assert out.split("\n")[1] == "@00:01.0"
    assert out.split("\n")[-1] == "5: again"


# --- build_lesson end to end ----------------------------------------------------------------

def _raw_with_ref():
    raw = json.loads((FIX / "raw_small.json").read_text("utf-8"))
    words = normalize_words(raw["events"], raw["duration"])
    chunks = list(chunk_words(words))
    assert len(chunks) == 2
    (a2, b2) = chunks[1]
    # One reference line strictly inside chunk 2 (and after chunk 1's end).
    start_ms = round(words[a2]["t"] * 1000)
    assert start_ms >= round(words[chunks[0][1]]["e"] * 1000)
    raw["ref"] = ref((start_ms, 400, "第二段的參考句"))
    raw["refStatus"] = "failed"  # nonsense alongside ref, but schema-legal; must not reach lesson
    assert validate_raw(raw) == []
    return raw, words, chunks


def test_build_lesson_passes_ref_to_every_chunk_and_lesson_has_no_ref():
    raw, words, chunks = _raw_with_ref()

    def seg(a, b):
        return {"cues": [{"a": a, "b": b, "tokens": [words[i]["w"] for i in range(a, b + 1)], "zh": "譯"}]}

    vocab = {"vocab": [{"term": "production", "pos": "n.", "ipa": "/x/", "zh": "正式環境", "cues": [0]}]}
    prov = FakeProvider([seg(*chunks[0]), seg(*chunks[1]), vocab, INTRO])
    lesson, stats = build_lesson(raw, prov)
    seg_calls = prov.calls[:2]
    for (system, user, schema), (a, b) in zip(seg_calls, chunks):
        assert system == SEGMENT_SYSTEM + SEGMENT_REF_ADDENDUM
        assert schema is SEGMENT_SCHEMA
        assert user.startswith(f"索引範圍 {a}..{b}，") and "\n@" in user
    assert HEAD not in seg_calls[0][1]
    assert seg_calls[1][1].endswith(HEAD + "\n" + seg_calls[1][1].split("\n")[-1])
    start_ms = round(words[chunks[1][0]]["t"] * 1000)
    assert seg_calls[1][1].split("\n")[-1] == f"{_clock(start_ms)}\u2013{_clock(start_ms + 400)} 第二段的參考句"
    assert "ref" not in lesson and "refStatus" not in lesson
    assert validate_lesson(lesson) == []
    assert [stats[k] for k in ("chunks", "fallback_chunks", "vocab_failed", "intro_failed")] == [2, 0, 0, 0]
    assert all("ev" not in x for x in lesson["words"])
