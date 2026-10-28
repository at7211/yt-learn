import json
from pathlib import Path

import pytest

from pipeline.build import build_lesson, main
from pipeline.llm import FakeProvider, ProviderError
from pipeline.schema import validate_lesson
from pipeline.words import normalize_words

FIX = Path(__file__).parent / "fixtures"
INTRO = {"title": "脫口秀片段", "lines": ["主持人評論一位名人"]}


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def fake_provider():
    """173 words -> chunks (0,120), (121,172): one long cue each, then one vocab item."""
    words = normalize_words(load("raw_small.json")["events"], 344)

    def seg(a, b):
        return {"cues": [{"a": a, "b": b, "tokens": [words[i]["w"] for i in range(a, b + 1)], "zh": "譯文"}]}

    vocab = {"vocab": [{"term": "clown", "pos": "n.", "ipa": "/klaʊn/", "zh": "小丑", "cues": [0]}]}
    return FakeProvider([seg(0, 120), seg(121, 172), vocab, INTRO])


def test_build_with_fake_provider_matches_schema():
    lesson, stats = build_lesson(load("raw_small.json"), fake_provider())
    assert stats == {"chunks": 2, "fallback_chunks": 0, "vocab_failed": 0, "intro_failed": 0}
    assert lesson["intro"] == INTRO
    assert validate_lesson(lesson) == []
    assert lesson["videoId"] == "CR94QQXO_4s" and lesson["coveredSeconds"] == 344
    assert len(lesson["words"]) == 173 and len(lesson["cues"]) == 2
    assert lesson["vocab"][0]["term"] == "clown"
    assert lesson["model"] == "default" and lesson["promptVersion"] == 1


def test_limit_seconds_sets_covered_seconds():
    raw = load("raw_small.json")
    words = normalize_words(raw["events"], 344)
    n = sum(1 for w in words if w["t"] < 30)
    resp = [{"cues": [{"a": 0, "b": n - 1, "tokens": [w["w"] for w in words[:n]], "zh": "譯"}]},
            {"vocab": []}, INTRO]
    lesson, _ = build_lesson(raw, FakeProvider(resp), limit_seconds=30)
    assert validate_lesson(lesson) == []
    assert lesson["coveredSeconds"] == 30 and len(lesson["words"]) == n
    assert all(w["t"] < 30 for w in lesson["words"])
    assert build_lesson(raw, fake_provider(), limit_seconds=9999)[0]["coveredSeconds"] == 344


def test_preview_refuses_to_overwrite_full_lesson(tmp_path, capsys):
    (tmp_path / "raw").mkdir()
    (tmp_path / "lessons").mkdir()
    (tmp_path / "raw" / "CR94QQXO_4s.json").write_text(json.dumps(load("raw_small.json")), encoding="utf-8")
    target = tmp_path / "lessons" / "CR94QQXO_4s.json"
    original = (FIX / "lesson_min.json").read_text(encoding="utf-8")
    target.write_text(original, encoding="utf-8")

    assert main(["CR94QQXO_4s", "--limit-seconds", "60"], data_dir=tmp_path) == 2
    assert "--force" in capsys.readouterr().err
    assert target.read_text(encoding="utf-8") == original

    assert main(["CR94QQXO_4s", "--limit-seconds", "60", "--force"], data_dir=tmp_path,
                provider_factory=lambda model, cache: fake_provider()) == 0
    out = json.loads(target.read_text(encoding="utf-8"))
    assert out["coveredSeconds"] == 60 and validate_lesson(out) == []
    assert "cues=" in capsys.readouterr().out


def test_lesson_min_fixture_is_valid():
    assert validate_lesson(load("lesson_min.json")) == []


class AlwaysFail:
    prompt_version = 1

    def complete_json(self, system, user, schema=None):
        raise ProviderError("claude CLI not found")


def _setup(tmp_path):
    (tmp_path / "raw").mkdir()
    (tmp_path / "lessons").mkdir()
    (tmp_path / "raw" / "CR94QQXO_4s.json").write_text(json.dumps(load("raw_small.json")), encoding="utf-8")
    return tmp_path / "lessons" / "CR94QQXO_4s.json"


def test_build_all_chunks_failed_refuses_to_write(tmp_path, capsys):
    target = _setup(tmp_path)
    original = (FIX / "lesson_min.json").read_bytes()
    target.write_bytes(original)
    assert main(["CR94QQXO_4s"], data_dir=tmp_path, provider_factory=lambda m, c: AlwaysFail()) == 1
    assert target.read_bytes() == original
    assert "未寫入 lesson" in capsys.readouterr().err
    assert not list(target.parent.glob("*.tmp"))


def test_build_all_chunks_failed_writes_nothing_when_no_lesson(tmp_path):
    target = _setup(tmp_path)
    assert main(["CR94QQXO_4s"], data_dir=tmp_path, provider_factory=lambda m, c: AlwaysFail()) == 1
    assert not target.exists()


def test_build_partial_failure_still_writes(tmp_path, capsys):
    target = _setup(tmp_path)
    words = normalize_words(load("raw_small.json")["events"], 344)
    ok = {"cues": [{"a": 121, "b": 172, "tokens": [words[i]["w"] for i in range(121, 173)], "zh": "譯"}]}
    prov = FakeProvider([ProviderError("boom"), ok, ProviderError("vocab boom"), ProviderError("intro boom")])
    assert main(["CR94QQXO_4s"], data_dir=tmp_path, provider_factory=lambda m, c: prov) == 0
    out = json.loads(target.read_text(encoding="utf-8"))
    assert validate_lesson(out) == [] and out["vocab"] == []
    assert "fallback_chunks=1/2" in capsys.readouterr().out


def test_build_survives_dead_provider_via_build_lesson():
    lesson, stats = build_lesson(load("raw_small.json"), AlwaysFail())
    assert validate_lesson(lesson) == []
    assert stats["fallback_chunks"] == stats["chunks"] and stats["vocab_failed"] == 1


def test_build_survives_garbage_responses():
    lesson, stats = build_lesson(load("raw_small.json"), FakeProvider([{"x": 1}, "junk", {"vocab": 3}, {"title": "", "lines": []}]))
    assert validate_lesson(lesson) == []
    assert lesson["vocab"] == [] and stats["fallback_chunks"] == 2


def test_manual_caption_lesson_has_addressable_cues():
    raw = {
        "videoId": "AAAAAAAAAAA", "title": "T", "channel": "C", "duration": 10, "lang": "en",
        "kind": "manual",
        "events": [
            {"t": 1000, "d": 3000, "segs": [[None, "I went home. Then we"]]},
            {"t": 4000, "d": 3000, "segs": [[None, "ate dinner together."]]},
        ],
    }
    toks = ["I", "went", "home.", "Then", "we", "ate", "dinner", "together."]
    prov = FakeProvider([
        {"cues": [{"a": 0, "b": 2, "tokens": toks[0:3], "zh": "我回家了。"},
                  {"a": 3, "b": 7, "tokens": toks[3:8], "zh": "然後我們吃了晚餐。"}]},
        {"vocab": []},
        INTRO,
    ])
    lesson, _ = build_lesson(raw, prov)
    starts = [lesson["words"][c["a"]]["t"] for c in lesson["cues"]]
    assert len(starts) == 2 and starts[0] < starts[1]
    assert all(not w["timed"] for w in lesson["words"])
    assert validate_lesson(lesson) == []


def test_build_invalid_intro_is_omitted_but_lesson_still_builds():
    words = normalize_words(load("raw_small.json")["events"], 344)
    seg = {"cues": [{"a": 0, "b": 172, "tokens": [w["w"] for w in words], "zh": "譯文"}]}
    prov = FakeProvider([seg, seg, {"vocab": []}, {"title": "a\nb\nc", "lines": ["x"]}])
    lesson, stats = build_lesson(load("raw_small.json"), prov)
    assert "intro" not in lesson and stats["intro_failed"] == 1
    assert validate_lesson(lesson) == []
