import json
import os
import subprocess
import types

import pytest

from pipeline import llm
from pipeline.llm import ClaudeCliProvider, CodexCliProvider, FakeProvider, ProviderError


def ok(stdout_obj, returncode=0):
    return types.SimpleNamespace(returncode=returncode, stdout=json.dumps(stdout_obj), stderr="")


def install(monkeypatch, outcomes):
    """Each outcome is a SimpleNamespace (returned) or Exception (raised)."""
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        o = outcomes.pop(0)
        if isinstance(o, Exception):
            raise o
        return o

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def test_parses_result_field_and_strips_fence(monkeypatch):
    calls = install(monkeypatch, [ok({"is_error": False, "result": '```json\n{"a": 1}\n```'})])
    assert ClaudeCliProvider().complete_json("sys", "usr") == {"a": 1}
    argv, kw = calls[0]
    assert argv[:2] == ["claude", "-p"]
    assert "--bare" not in argv and "--model" not in argv and "--json-schema" not in argv
    assert argv[argv.index("--system-prompt") + 1] == "sys"
    assert argv[argv.index("--tools") + 1] == ""
    assert kw["input"] == "usr" and kw["timeout"] == 180.0


def test_structured_output_preferred_and_schema_model_flags(monkeypatch):
    calls = install(monkeypatch, [ok({"is_error": False, "structured_output": {"ok": True}, "result": "prose"})])
    schema = {"type": "object"}
    assert ClaudeCliProvider(model="m1").complete_json("s", "u", schema) == {"ok": True}
    argv = calls[0][0]
    assert argv[argv.index("--model") + 1] == "m1"
    assert json.loads(argv[argv.index("--json-schema") + 1]) == schema


def test_cache_hit_skips_subprocess(monkeypatch, tmp_path):
    calls = install(monkeypatch, [ok({"is_error": False, "result": '{"a": 1}'})])
    p = ClaudeCliProvider(model="m", cache_dir=tmp_path)
    assert p.complete_json("s", "u") == {"a": 1}
    assert p.complete_json("s", "u") == {"a": 1}
    assert len(calls) == 1
    # version bump is a miss
    install(monkeypatch, [ok({"is_error": False, "result": '{"a": 2}'})])
    p2 = ClaudeCliProvider(model="m", cache_dir=tmp_path, prompt_version=2)
    assert p2.complete_json("s", "u") == {"a": 2}


def test_cache_key_includes_model(monkeypatch, tmp_path):
    install(monkeypatch, [ok({"is_error": False, "result": '{"a": 1}'}), ok({"is_error": False, "result": '{"a": 2}'})])
    assert ClaudeCliProvider(model="m1", cache_dir=tmp_path).complete_json("s", "u") == {"a": 1}
    assert ClaudeCliProvider(model="m2", cache_dir=tmp_path).complete_json("s", "u") == {"a": 2}
    assert len(list(tmp_path.glob("*.json"))) == 2


def _key_path(p, system, user, schema=None):
    return p._cache_path(system, user, schema)


def test_cache_mismatched_model_is_miss(monkeypatch, tmp_path):
    calls = install(monkeypatch, [ok({"is_error": False, "result": '{"a": 1}'})])
    p = ClaudeCliProvider(model="m", cache_dir=tmp_path)
    _key_path(p, "s", "u").write_text(json.dumps({"model": "other", "promptVersion": 1, "response": {"a": 9}}))
    assert p.complete_json("s", "u") == {"a": 1}
    assert len(calls) == 1


def test_cache_corrupt_file_is_miss(monkeypatch, tmp_path):
    calls = install(monkeypatch, [ok({"is_error": False, "result": '{"a": 1}'})])
    p = ClaudeCliProvider(model="m", cache_dir=tmp_path)
    _key_path(p, "s", "u").write_bytes(b"\xff\x00garbage")
    assert p.complete_json("s", "u") == {"a": 1}
    assert len(calls) == 1


def test_cache_write_failure_does_not_lose_response(monkeypatch, tmp_path):
    install(monkeypatch, [ok({"is_error": False, "result": '{"a": 1}'})])
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert ClaudeCliProvider(cache_dir=blocker / "sub").complete_json("s", "u") == {"a": 1}
    install(monkeypatch, [ok({"is_error": False, "result": '{"a": 2}'})])
    def boom(*a, **k):
        raise OSError("nope")
    monkeypatch.setattr(os, "replace", boom)
    d = tmp_path / "c"
    assert ClaudeCliProvider(cache_dir=d).complete_json("s", "u") == {"a": 2}
    assert list(d.glob("*")) == []


def test_retries_once_on_invalid_json_then_succeeds(monkeypatch):
    calls = install(monkeypatch, [
        ok({"is_error": False, "result": "sorry, no json"}),
        ok({"is_error": False, "result": '{"a": 1}'}),
    ])
    assert ClaudeCliProvider().complete_json("s", "u", {"type": "object"}) == {"a": 1}
    assert len(calls) == 2
    assert calls[0][1]["input"] == "u"
    assert calls[1][0][calls[1][0].index("--json-schema") + 1] == calls[0][0][calls[0][0].index("--json-schema") + 1]
    assert calls[1][1]["input"] == "u\n\n(上一次輸出不是合法 JSON，請只輸出符合 schema 的 JSON。)"


def test_raises_provider_error_after_two_failures(monkeypatch):
    calls = install(monkeypatch, [ok({"is_error": True, "result": "Not logged in"}), ok({"is_error": False, "result": "[1]"})])
    with pytest.raises(ProviderError):
        ClaudeCliProvider().complete_json("s", "u")
    assert len(calls) == 2


def test_nonzero_exit_is_failure(monkeypatch):
    calls = install(monkeypatch, [
        types.SimpleNamespace(returncode=1, stdout="", stderr="boom"),
        types.SimpleNamespace(returncode=1, stdout="", stderr="boom"),
    ])
    with pytest.raises(ProviderError):
        ClaudeCliProvider().complete_json("s", "u")
    assert len(calls) == 2


def test_timeout_is_failure(monkeypatch):
    calls = install(monkeypatch, [subprocess.TimeoutExpired("claude", 1), subprocess.TimeoutExpired("claude", 1)])
    with pytest.raises(ProviderError):
        ClaudeCliProvider(timeout=1).complete_json("s", "u")
    assert len(calls) == 2


def test_missing_cli_raises_provider_error(monkeypatch):
    calls = install(monkeypatch, [FileNotFoundError("claude")])
    with pytest.raises(ProviderError):
        ClaudeCliProvider().complete_json("s", "u")
    assert len(calls) == 1


def test_fake_provider_records_and_raises():
    fp = FakeProvider([{"x": 1}, ProviderError("no")])
    assert fp.complete_json("s", "u", {"t": 1}) == {"x": 1}
    with pytest.raises(ProviderError):
        fp.complete_json("s2", "u2")
    assert fp.calls == [("s", "u", {"t": 1}), ("s2", "u2", None)]
    with pytest.raises(AssertionError):
        fp.complete_json("s", "u")


@pytest.mark.skipif(not os.environ.get("YTLEARN_LIVE"), reason="set YTLEARN_LIVE=1 to call the real claude CLI")
def test_live_cli_smoke():
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
    out = ClaudeCliProvider(model="claude-haiku-5-5").complete_json("Reply with JSON only.", 'Return {"ok": true}', schema)
    assert out == {"ok": True}


def test_counts_calls_and_cache_hits(monkeypatch, tmp_path):
    install(monkeypatch, [ok({"result": '{"x": 1}'})])
    p = ClaudeCliProvider(cache_dir=tmp_path)
    assert (p.calls, p.cache_hits) == (0, 0)
    p.complete_json("s", "u")
    p.complete_json("s", "u")
    assert (p.calls, p.cache_hits) == (1, 1)


# ---------------------------------------------------------------- codex


def codex_run(monkeypatch, answers):
    """Fake `codex exec`: each answer is a dict (written to the -o file), a str (stdout only), or an Exception."""
    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        if isinstance(a, dict):
            (lambda p: open(p, "w", encoding="utf-8").write(json.dumps(a, ensure_ascii=False)))(argv[argv.index("-o") + 1])
            return types.SimpleNamespace(returncode=0, stdout="", stderr="banner")
        return types.SimpleNamespace(returncode=0, stdout=a, stderr="banner")

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def test_codex_argv_schema_file_and_prompt(monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "no-config"))  # no configured default model
    seen = {}

    def spy(argv, **kwargs):
        sp = argv[argv.index("--output-schema") + 1]
        seen["schema"] = json.loads(open(sp, encoding="utf-8").read())
        seen["argv"], seen["kw"] = argv, kwargs
        open(argv[argv.index("-o") + 1], "w").write('{"a": 1}')
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", spy)
    assert CodexCliProvider().complete_json("sys", "usr", {"type": "object"}) == {"a": 1}
    argv, kw = seen["argv"], seen["kw"]
    assert argv[:2] == ["codex", "exec"] and argv[-1] == "-"
    assert argv[argv.index("--sandbox") + 1] == "read-only" and "--ephemeral" in argv and "--skip-git-repo-check" in argv
    assert "-m" not in argv and seen["schema"] == {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
    assert kw["input"].startswith("sys") and kw["input"].endswith("usr") and kw["timeout"] == 300.0


def test_strict_schema_adds_additional_properties_false_everywhere():
    from pipeline.llm import strict_schema
    from pipeline.vocab import VOCAB_SCHEMA
    out = strict_schema(VOCAB_SCHEMA)
    assert out["additionalProperties"] is False and out["required"] == ["vocab"]
    item = out["properties"]["vocab"]["items"]
    assert item["additionalProperties"] is False and item["required"] == ["term", "pos", "ipa", "zh", "cues"]
    assert item["properties"]["pos"]["enum"] == VOCAB_SCHEMA["properties"]["vocab"]["items"]["properties"]["pos"]["enum"]
    assert "additionalProperties" not in VOCAB_SCHEMA  # the original is untouched (Claude cache keys depend on it)


def test_codex_model_flag_and_no_schema(monkeypatch):
    calls = codex_run(monkeypatch, [{"a": 2}])
    assert CodexCliProvider(model="gpt-6-astra").complete_json("s", "u") == {"a": 2}
    argv = calls[0][0]
    assert argv[argv.index("-m") + 1] == "gpt-6-astra" and "--output-schema" not in argv


def test_codex_falls_back_to_last_stdout_line_and_strips_fence(monkeypatch):
    codex_run(monkeypatch, ["OpenAI Codex v0\nworkdir: x\n```json\n{\"a\": 3}\n```"])
    assert CodexCliProvider().complete_json("s", "u") == {"a": 3}


def test_codex_retries_then_fails(monkeypatch):
    calls = codex_run(monkeypatch, [types.SimpleNamespace(returncode=1, stdout="", stderr="boom") if False else "not json", {"a": 4}])
    assert CodexCliProvider().complete_json("s", "u") == {"a": 4}
    assert calls[1][1]["input"].endswith(llm.RETRY_SUFFIX)
    codex_run(monkeypatch, ["junk", "junk"])
    with pytest.raises(ProviderError):
        CodexCliProvider().complete_json("s", "u")
    codex_run(monkeypatch, [FileNotFoundError()])
    with pytest.raises(ProviderError, match="codex"):
        CodexCliProvider().complete_json("s", "u")


def test_codex_nonzero_exit_reports_stderr_tail(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda argv, **k: types.SimpleNamespace(returncode=2, stdout="", stderr="x" * 300 + "TAIL"))
    with pytest.raises(ProviderError, match="TAIL"):
        CodexCliProvider().complete_json("s", "u")


def test_cache_keys_differ_by_provider_and_claude_key_is_unchanged(tmp_path):
    c = ClaudeCliProvider(model="m", cache_dir=tmp_path)
    x = CodexCliProvider(model="m", cache_dir=tmp_path)
    assert c._cache_path("s", "u", None) != x._cache_path("s", "u", None)
    import hashlib
    legacy = hashlib.sha256(json.dumps({"model": "m", "promptVersion": 1, "system": "s", "user": "u", "schema": None},
                                       sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    assert c._cache_path("s", "u", None).name == legacy + ".json"


def test_codex_isolation_flags_and_configured_model(monkeypatch, tmp_path):
    (tmp_path / "config.toml").write_text('model = "gpt-test"\nmodel_reasoning_effort = "low"\n', "utf-8")
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    calls = codex_run(monkeypatch, [{"a": 1}])
    p = CodexCliProvider(cache_dir=tmp_path / "cache")
    assert p.model == "gpt-test"
    assert p.complete_json("s", "u") == {"a": 1}
    argv = calls[0][0]
    assert argv[argv.index("-m") + 1] == "gpt-test"
    cfg = [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]
    assert 'approval_policy="never"' in cfg and "features.shell_tool=false" in cfg and "features.hooks=false" in cfg
    assert calls[0][1]["encoding"] == "utf-8"
    # explicit model wins; no config file -> None and no -m
    assert CodexCliProvider(model="other").model == "other"
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "nowhere"))
    calls = codex_run(monkeypatch, [{"a": 2}])
    p2 = CodexCliProvider()
    assert p2.model is None and p2.complete_json("s", "u") == {"a": 2} and "-m" not in calls[0][0]


# ---------------------------------------------------------------- effort


def test_claude_effort_flag(monkeypatch):
    calls = install(monkeypatch, [ok({"is_error": False, "result": '{"a": 1}'})] * 2)
    ClaudeCliProvider(model="m", effort="low").complete_json("s", "u")
    argv = calls[0][0]
    assert argv[argv.index("--effort") + 1] == "low"
    assert argv.index("--effort") == argv.index("--model") + 2
    ClaudeCliProvider(model="m").complete_json("s", "u")
    assert "--effort" not in calls[1][0]


def test_codex_effort_config_caps_at_high(monkeypatch):
    calls = codex_run(monkeypatch, [{"a": 1}, {"a": 1}, {"a": 1}])
    for effort in ("medium", "max", None):
        p = CodexCliProvider(model="g", effort=effort)
        p.complete_json("s", "u")
    efforts = [[a for a in argv if a.startswith("model_reasoning_effort=")] for argv, _ in calls]
    assert efforts == [['model_reasoning_effort="medium"'], ['model_reasoning_effort="high"'], []]
    assert CodexCliProvider(model="g", effort="xhigh").effort == "high"


def _key_fields_hash(p):
    return p._cache_path("s", "u", None).name


def test_cache_default_effort_keeps_old_key_and_hits_old_record(monkeypatch, tmp_path):
    # A record written before effort existed: no "effort" field, key without effort.
    old = ClaudeCliProvider(model="m", cache_dir=tmp_path)
    path = old._cache_path("s", "u", None)
    path.write_text(json.dumps({"model": "m", "promptVersion": 1, "response": {"old": True}}), "utf-8")
    calls = install(monkeypatch, [])
    assert ClaudeCliProvider(model="m", cache_dir=tmp_path).complete_json("s", "u") == {"old": True}
    assert calls == []
    # an explicit effort uses a different key and does not reuse the old record
    install(monkeypatch, [ok({"is_error": False, "result": '{"new": 1}'})])
    p = ClaudeCliProvider(model="m", cache_dir=tmp_path, effort="high")
    assert _key_fields_hash(p) != path.name
    assert p.complete_json("s", "u") == {"new": 1}


def test_cache_record_effort_must_match(monkeypatch, tmp_path):
    p = ClaudeCliProvider(model="m", cache_dir=tmp_path, effort="low")
    path = p._cache_path("s", "u", None)
    path.write_text(json.dumps({"model": "m", "effort": "high", "promptVersion": 1, "response": {"x": 1}}), "utf-8")
    install(monkeypatch, [ok({"is_error": False, "result": '{"x": 2}'})])
    assert p.complete_json("s", "u") == {"x": 2}
    assert json.loads(path.read_text("utf-8"))["effort"] == "low"


def test_cache_low_high_low_reuses_low(monkeypatch, tmp_path):
    calls = install(monkeypatch, [ok({"is_error": False, "result": '{"e": "low"}'}),
                                  ok({"is_error": False, "result": '{"e": "high"}'})])
    assert ClaudeCliProvider(model="m", cache_dir=tmp_path, effort="low").complete_json("s", "u") == {"e": "low"}
    assert ClaudeCliProvider(model="m", cache_dir=tmp_path, effort="high").complete_json("s", "u") == {"e": "high"}
    p = ClaudeCliProvider(model="m", cache_dir=tmp_path, effort="low")
    assert p.complete_json("s", "u") == {"e": "low"} and p.cache_hits == 1
    assert len(calls) == 2
    # records name their effort; a no-effort record says "default"
    install(monkeypatch, [ok({"is_error": False, "result": '{"e": "d"}'})])
    d = ClaudeCliProvider(model="m", cache_dir=tmp_path)
    d.complete_json("s", "u")
    assert json.loads(d._cache_path("s", "u", None).read_text("utf-8"))["effort"] == "default"
