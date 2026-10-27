import pytest

from pipeline.llm import FakeProvider, ProviderError
from pipeline.segment import (
    SEGMENT_SCHEMA,
    SEGMENT_SYSTEM,
    finalize_cues,
    make_cues,
    rule_cues,
    segment_user_prompt,
    validate_cues,
)


def mk(n, gaps_after=(), gap=1.5, start=0):
    words, t = [], 0.0
    for i in range(n):
        words.append({"t": t, "e": t + 0.2, "w": f"w{start + i}", "timed": True})
        t += gap if i in gaps_after else 0.2
    return words


def cue(a, b, tokens=None, zh="中"):
    return {"a": a, "b": b, "tokens": tokens if tokens is not None else [f"W{i}" for i in range(a, b + 1)], "zh": zh}


def test_cues_cover_chunk_and_tokens_align():
    words = mk(8)
    resp = {"cues": [cue(4, 7), cue(0, 3)]}
    out = validate_cues(resp, 0, 7)
    assert [(c["a"], c["b"]) for c in out] == [(0, 3), (4, 7)]
    assert out[0]["tokens"] == ["W0", "W1", "W2", "W3"]
    fin = finalize_cues(out, words)
    assert fin[1]["en"] == "W4 W5 W6 W7"
    assert fin[0]["zh"] == "中"


def test_token_count_mismatch_falls_back_to_raw():
    words = mk(6)
    prov = FakeProvider([{"cues": [cue(0, 2, tokens=["A", "B"], zh="壞"), cue(3, 5, zh="好")]}])
    out = make_cues(words, (0, 5), prov)
    assert out[0]["tokens"] == ["w0", "w1", "w2"] and out[0]["zh"] == "壞"
    assert out[1]["tokens"] == ["W3", "W4", "W5"] and out[1]["zh"] == "好"


def test_overlapping_cues_reject_batch_to_rule_cues(capsys):
    words = mk(6)
    prov = FakeProvider([{"cues": [cue(0, 3), cue(3, 5)]}])
    out = make_cues(words, (0, 5), prov)
    assert out == rule_cues(words, 0, 5)
    assert "rule" in capsys.readouterr().err.lower()


def test_out_of_range_index_rejects_batch():
    assert validate_cues({"cues": [cue(0, 2), cue(3, 6)]}, 0, 5) is None
    assert validate_cues({"cues": [cue(-1, 2), cue(3, 5)]}, 0, 5) is None
    assert validate_cues({"cues": [cue(0, 2)]}, 0, 5) is None  # does not reach b
    assert validate_cues({"cues": [cue(1, 5)]}, 0, 5) is None  # does not start at a
    assert validate_cues({"cues": [cue(0, 1), cue(3, 5)]}, 0, 5) is None  # gap


def test_bad_types_reject_batch():
    good = cue(0, 5)
    assert validate_cues({}, 0, 5) is None
    assert validate_cues({"cues": []}, 0, 5) is None
    assert validate_cues({"cues": "x"}, 0, 5) is None
    assert validate_cues({"cues": [dict(good, a="0")]}, 0, 5) is None
    assert validate_cues({"cues": [dict(good, a=True)]}, 0, 5) is None
    assert validate_cues({"cues": [dict(good, tokens="abc")]}, 0, 5) is None
    assert validate_cues({"cues": [dict(good, tokens=[1] * 6)]}, 0, 5) is None
    assert validate_cues({"cues": [dict(good, zh=3)]}, 0, 5) is None
    assert validate_cues({"cues": [5]}, 0, 5) is None
    assert validate_cues({"cues": [cue(3, 2)]}, 0, 5) is None
    assert validate_cues({"cues": [good]}, 0, 5) is not None


def test_provider_error_uses_rule_cues_with_empty_zh(capsys):
    words = mk(5)
    out = make_cues(words, (0, 4), FakeProvider([ProviderError("x")]))
    assert out == [{"a": 0, "b": 4, "tokens": ["w0", "w1", "w2", "w3", "w4"], "zh": ""}]
    assert "x" in capsys.readouterr().err


def test_rule_cues_split_on_gap_or_14_words():
    words = mk(6, gaps_after=(1,))
    out = rule_cues(words, 0, 5)
    assert [(c["a"], c["b"]) for c in out] == [(0, 1), (2, 5)]
    long = mk(30, gap=0.2)
    out = rule_cues(long, 0, 29)
    assert [(c["a"], c["b"]) for c in out] == [(0, 13), (14, 27), (28, 29)]
    assert rule_cues(long, 5, 9)[0]["tokens"] == ["w5", "w6", "w7", "w8", "w9"]


def test_user_prompt_uses_global_indices_and_make_cues_passes_schema():
    words = mk(10)
    p = segment_user_prompt(words, 4, 7)
    assert "4..7" in p and "4 個" in p
    lines = p.splitlines()
    assert "4: w4" in lines and "7: w7" in lines and "3: w3" not in lines
    prov = FakeProvider([{"cues": [cue(4, 7)]}])
    make_cues(words, (4, 7), prov)
    system, user, schema = prov.calls[0]
    assert system == SEGMENT_SYSTEM and user == p and schema == SEGMENT_SCHEMA


def test_finalize_requires_full_contiguous_coverage():
    words = mk(6)
    c = [cue(0, 2), cue(3, 5)]
    assert finalize_cues(list(reversed(c)), words)[0]["a"] == 0
    with pytest.raises(ValueError):
        finalize_cues([cue(0, 2), cue(4, 5)], words)
    with pytest.raises(ValueError):
        finalize_cues([cue(0, 2)], words)
