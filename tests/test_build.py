import json
from pathlib import Path

import pytest

from pipeline.build import build_lesson, main
from pipeline.llm import FakeProvider, ProviderError
from pipeline.schema import validate_lesson
from pipeline.words import normalize_words

FIX = Path(__file__).parent / "fixtures"
INTRO = {"title": "生產工程演講", "lines": ["談 AI 代理"]}


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def fake_provider():
    """146 words -> chunks (0,119), (120,145): one long cue each, then one vocab item."""
    words = normalize_words(load("raw_small.json")["events"], 1378)

    def seg(a, b):
        return {"cues": [{"a": a, "b": b, "tokens": [words[i]["w"] for i in range(a, b + 1)], "zh": "譯文"}]}

    vocab = {"vocab": [{"term": "production", "pos": "n.", "ipa": "/prəˈdʌkʃən/", "zh": "正式環境", "cues": [0]}]}
    return FakeProvider([seg(0, 119), seg(120, 145), vocab, INTRO])


def test_build_with_fake_provider_matches_schema():
    lesson, stats = build_lesson(load("raw_small.json"), fake_provider())
    assert stats == {"chunks": 2, "fallback_chunks": 0, "vocab_failed": 0, "intro_failed": 0}
    assert lesson["intro"] == INTRO
    assert validate_lesson(lesson) == []
    assert lesson["videoId"] == "puh91fohvTA" and lesson["coveredSeconds"] == 1378
    assert len(lesson["words"]) == 146 and len(lesson["cues"]) == 2
    assert lesson["vocab"][0]["term"] == "production"
    assert lesson["model"] == "default" and lesson["promptVersion"] == 1


def test_build_copies_source_fields_from_raw():
    raw = dict(load("raw_small.json"), videoId="udemy.5800738", source="udemy",
               sourceUrl="https://www.udemy.com/course/30-days-of-python/learn/lecture/5800738")
    lesson, _ = build_lesson(raw, fake_provider())
    assert validate_lesson(lesson) == []
    assert lesson["videoId"] == "udemy.5800738" and lesson["source"] == "udemy"
    assert lesson["sourceUrl"] == raw["sourceUrl"]
    plain, _ = build_lesson(load("raw_small.json"), fake_provider())
    assert "source" not in plain and "sourceUrl" not in plain


def test_limit_seconds_sets_covered_seconds():
    raw = load("raw_small.json")
    words = normalize_words(raw["events"], 1378)
    n = sum(1 for w in words if w["t"] < 30)
    resp = [{"cues": [{"a": 0, "b": n - 1, "tokens": [w["w"] for w in words[:n]], "zh": "譯"}]},
            {"vocab": []}, INTRO]
    lesson, _ = build_lesson(raw, FakeProvider(resp), limit_seconds=30)
    assert validate_lesson(lesson) == []
    assert lesson["coveredSeconds"] == 30 and len(lesson["words"]) == n
    assert all(w["t"] < 30 for w in lesson["words"])
    assert build_lesson(raw, fake_provider(), limit_seconds=9999)[0]["coveredSeconds"] == 1378


def test_preview_refuses_to_overwrite_full_lesson(tmp_path, capsys):
    (tmp_path / "raw").mkdir()
    (tmp_path / "lessons").mkdir()
    (tmp_path / "raw" / "puh91fohvTA.json").write_text(json.dumps(load("raw_small.json")), encoding="utf-8")
    target = tmp_path / "lessons" / "puh91fohvTA.json"
    original = (FIX / "lesson_min.json").read_text(encoding="utf-8")
    target.write_text(original, encoding="utf-8")

    assert main(["puh91fohvTA", "--limit-seconds", "90"], data_dir=tmp_path) == 2
    assert "--force" in capsys.readouterr().err
    assert target.read_text(encoding="utf-8") == original

    assert main(["puh91fohvTA", "--limit-seconds", "90", "--force"], data_dir=tmp_path,
                provider_factory=lambda model, cache: fake_provider()) == 0
    out = json.loads(target.read_text(encoding="utf-8"))
    assert out["coveredSeconds"] == 90 and validate_lesson(out) == []
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
    (tmp_path / "raw" / "puh91fohvTA.json").write_text(json.dumps(load("raw_small.json")), encoding="utf-8")
    return tmp_path / "lessons" / "puh91fohvTA.json"


def test_build_all_chunks_failed_refuses_to_write(tmp_path, capsys):
    target = _setup(tmp_path)
    original = (FIX / "lesson_min.json").read_bytes()
    target.write_bytes(original)
    assert main(["puh91fohvTA"], data_dir=tmp_path, provider_factory=lambda m, c: AlwaysFail()) == 1
    assert target.read_bytes() == original
    assert "未寫入 lesson" in capsys.readouterr().err
    assert not list(target.parent.glob("*.tmp"))


def test_build_all_chunks_failed_writes_nothing_when_no_lesson(tmp_path):
    target = _setup(tmp_path)
    assert main(["puh91fohvTA"], data_dir=tmp_path, provider_factory=lambda m, c: AlwaysFail()) == 1
    assert not target.exists()


def test_build_partial_failure_still_writes(tmp_path, capsys):
    target = _setup(tmp_path)
    words = normalize_words(load("raw_small.json")["events"], 1378)
    ok = {"cues": [{"a": 120, "b": 145, "tokens": [words[i]["w"] for i in range(120, 146)], "zh": "譯"}]}
    prov = FakeProvider([ProviderError("boom"), ok, ProviderError("vocab boom"), ProviderError("intro boom")])
    assert main(["puh91fohvTA"], data_dir=tmp_path, provider_factory=lambda m, c: prov) == 0
    out = json.loads(target.read_text(encoding="utf-8"))
    assert validate_lesson(out) == [] and out["vocab"] == []
    assert "fallback_chunks=1/2" in capsys.readouterr().out


def test_build_survives_dead_provider_via_build_lesson():
    lesson, stats = build_lesson(load("raw_small.json"), AlwaysFail())
    assert validate_lesson(lesson) == []
    assert stats["fallback_chunks"] == stats["chunks"] and stats["vocab_failed"] == 1


def test_build_survives_garbage_responses():
    lesson, stats = build_lesson(load("raw_small.json"), FakeProvider([{"x": 1}, "junk", {"vocab": 3}, {"title": "", "lines": []}, "junk"]))
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
    words = normalize_words(load("raw_small.json")["events"], 1378)
    seg = {"cues": [{"a": 0, "b": len(words) - 1, "tokens": [w["w"] for w in words], "zh": "譯文"}]}
    bad = {"title": "a\nb\nc", "lines": ["x"]}
    prov = FakeProvider([seg, seg, {"vocab": []}, bad, bad])  # rejected, retried once, rejected again
    lesson, stats = build_lesson(load("raw_small.json"), prov)
    assert "intro" not in lesson and stats["intro_failed"] == 1 and len(prov.calls) == 5
    assert validate_lesson(lesson) == []


def test_build_reports_weighted_progress():
    calls = []
    build_lesson(load("raw_small.json"), fake_provider(), progress=lambda phase, done, total: calls.append((phase, done, total)))
    assert calls == [("segment", 1, 5), ("segment", 2, 5), ("vocab", 2, 5), ("intro", 4, 5), ("finish", 5, 5)]


def test_progress_file_written_by_cli(tmp_path, monkeypatch):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "puh91fohvTA.json").write_text(json.dumps(load("raw_small.json")), "utf-8")
    prog = tmp_path / "jobs" / "puh91fohvTA.progress.json"
    assert main(["puh91fohvTA", "--progress-file", str(prog)], data_dir=tmp_path, provider_factory=lambda m, c: fake_provider()) == 0
    assert json.loads(prog.read_text("utf-8")) == {"phase": "finish", "done": 5, "total": 5}
    assert not list(prog.parent.glob("*.tmp"))
    # the env var is the default for the flag
    monkeypatch.setenv("YTLEARN_PROGRESS_FILE", str(tmp_path / "env.json"))
    assert main(["puh91fohvTA", "--force"], data_dir=tmp_path, provider_factory=lambda m, c: fake_provider()) == 0
    assert json.loads((tmp_path / "env.json").read_text("utf-8"))["phase"] == "finish"


def _spy_factory(seen):
    def factory(model, cache_dir, provider="claude"):
        seen.update(model=model, provider=provider)
        return fake_provider()
    return factory


def test_provider_flag_defaults_to_claude_and_switches_to_codex(tmp_path, monkeypatch):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "puh91fohvTA.json").write_text(json.dumps(load("raw_small.json")), "utf-8")
    monkeypatch.delenv("YTLEARN_PROVIDER", raising=False)
    seen = {}
    assert main(["puh91fohvTA"], data_dir=tmp_path, provider_factory=_spy_factory(seen)) == 0
    assert seen == {"model": "claude-sonnet-5-5", "provider": "claude"}
    assert json.loads((tmp_path / "lessons" / "puh91fohvTA.json").read_text("utf-8"))["model"] == "claude-sonnet-5-5"
    seen = {}
    assert main(["puh91fohvTA", "--provider", "codex", "--force"], data_dir=tmp_path, provider_factory=_spy_factory(seen)) == 0
    assert seen == {"model": None, "provider": "codex"}
    assert json.loads((tmp_path / "lessons" / "puh91fohvTA.json").read_text("utf-8"))["model"] == "codex:default"
    seen = {}
    monkeypatch.setenv("YTLEARN_PROVIDER", "codex")
    assert main(["puh91fohvTA", "--force", "--model", "gpt-6-astra"], data_dir=tmp_path, provider_factory=_spy_factory(seen)) == 0
    assert seen == {"model": "gpt-6-astra", "provider": "codex"}
    assert json.loads((tmp_path / "lessons" / "puh91fohvTA.json").read_text("utf-8"))["model"] == "codex:gpt-6-astra"
    seen = {}
    assert main(["puh91fohvTA", "--force", "--provider", "claude"], data_dir=tmp_path, provider_factory=_spy_factory(seen)) == 0
    assert seen["provider"] == "claude"


def test_unknown_provider_from_env_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("YTLEARN_PROVIDER", "typo")
    with pytest.raises(SystemExit) as e:
        main(["puh91fohvTA"], data_dir=tmp_path)
    assert e.value.code == 2


def _effort_spy(seen):
    def factory(model, cache_dir, provider="claude", **kw):
        seen.update(model=model, provider=provider, **kw)
        return fake_provider()
    return factory


def _lesson(tmp_path):
    return json.loads((tmp_path / "lessons" / "puh91fohvTA.json").read_text("utf-8"))


@pytest.fixture
def raw_dir(tmp_path, monkeypatch):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "puh91fohvTA.json").write_text(json.dumps(load("raw_small.json")), "utf-8")
    for k in ("YTLEARN_PROVIDER", "YTLEARN_MODEL", "YTLEARN_EFFORT"):
        monkeypatch.delenv(k, raising=False)
    return tmp_path


def test_effort_and_model_from_env_reach_factory_and_lesson(raw_dir, monkeypatch, capsys):
    monkeypatch.setenv("YTLEARN_MODEL", "claude-haiku-5-5")
    monkeypatch.setenv("YTLEARN_EFFORT", "low")
    seen = {}
    assert main(["puh91fohvTA"], data_dir=raw_dir, provider_factory=_effort_spy(seen)) == 0
    assert seen == {"model": "claude-haiku-5-5", "provider": "claude", "effort": "low"}
    les = _lesson(raw_dir)
    assert les["model"] == "claude-haiku-5-5" and les["effort"] == "low" and not validate_lesson(les)
    assert "settings: provider=claude model=claude-haiku-5-5 effort=low workers=1" in capsys.readouterr().out


def test_cli_flags_beat_env(raw_dir, monkeypatch):
    monkeypatch.setenv("YTLEARN_MODEL", "claude-haiku-5-5")
    monkeypatch.setenv("YTLEARN_EFFORT", "low")
    seen = {}
    assert main(["puh91fohvTA", "--model", "claude-opus-5-5", "--effort", "max"], data_dir=raw_dir,
                provider_factory=_effort_spy(seen)) == 0
    assert seen == {"model": "claude-opus-5-5", "provider": "claude", "effort": "max"}
    assert _lesson(raw_dir)["effort"] == "max"


def test_effort_default_is_none_and_old_two_arg_factory_still_works(raw_dir, monkeypatch, capsys):
    monkeypatch.setenv("YTLEARN_EFFORT", "default")
    assert main(["puh91fohvTA"], data_dir=raw_dir, provider_factory=lambda m, c: fake_provider()) == 0
    assert _lesson(raw_dir)["effort"] == "default"
    assert "effort=default" in capsys.readouterr().out


def test_codex_ignores_ytlearn_model_and_caps_effort(raw_dir, monkeypatch, capsys):
    monkeypatch.setenv("YTLEARN_MODEL", "claude-opus-5-5")
    monkeypatch.setenv("YTLEARN_EFFORT", "xhigh")
    seen = {}
    assert main(["puh91fohvTA", "--provider", "codex"], data_dir=raw_dir, provider_factory=_effort_spy(seen)) == 0
    assert seen == {"model": None, "provider": "codex", "effort": "xhigh"}  # the provider caps it itself
    les = _lesson(raw_dir)
    assert les["model"] == "codex:default" and les["effort"] == "high"
    assert "effort=high" in capsys.readouterr().out


def test_unknown_effort_from_env_is_rejected(raw_dir, monkeypatch):
    monkeypatch.setenv("YTLEARN_EFFORT", "huge")
    with pytest.raises(SystemExit) as e:
        main(["puh91fohvTA"], data_dir=raw_dir)
    assert e.value.code == 2
