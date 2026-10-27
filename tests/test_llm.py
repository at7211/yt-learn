import json
import os
import subprocess
import types

import pytest

from pipeline import llm
from pipeline.llm import ClaudeCliProvider, FakeProvider, ProviderError


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
