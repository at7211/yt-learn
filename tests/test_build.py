import json
from pathlib import Path

import pytest

from pipeline.build import build_lesson, main
from pipeline.llm import FakeProvider
from pipeline.schema import validate_lesson
from pipeline.words import normalize_words

FIX = Path(__file__).parent / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def fake_provider():
    """173 words -> chunks (0,120), (121,172): one long cue each, then one vocab item."""
    words = normalize_words(load("raw_small.json")["events"], 344)

    def seg(a, b):
        return {"cues": [{"a": a, "b": b, "tokens": [words[i]["w"] for i in range(a, b + 1)], "zh": "譯文"}]}

    vocab = {"vocab": [{"term": "clown", "pos": "n.", "ipa": "/klaʊn/", "zh": "小丑", "cues": [0]}]}
    return FakeProvider([seg(0, 120), seg(121, 172), vocab])


def test_build_with_fake_provider_matches_schema():
    lesson = build_lesson(load("raw_small.json"), fake_provider())
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
            {"vocab": []}]
    lesson = build_lesson(raw, FakeProvider(resp), limit_seconds=30)
    assert validate_lesson(lesson) == []
    assert lesson["coveredSeconds"] == 30 and len(lesson["words"]) == n
    assert all(w["t"] < 30 for w in lesson["words"])
    assert build_lesson(raw, fake_provider(), limit_seconds=9999)["coveredSeconds"] == 344


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
