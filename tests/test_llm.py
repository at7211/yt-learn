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
    assert "--strict-mcp-config" in argv and argv[argv.index("--setting-sources") + 1] == ""
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


KEY = "sk-ant-test-0123456789"


def fake_transport(outcomes):
    """Each outcome: (status, headers, body_obj) or an Exception instance. Records (method, url, headers, body_obj, timeout)."""
    calls = []

    def t(method, url, headers, body, timeout):
        calls.append((method, url, headers, json.loads(body) if body else None, timeout))
        o = outcomes.pop(0)
        if isinstance(o, Exception):
            raise o
        st, hd, obj = o
        return st, hd, json.dumps(obj).encode()
    t.calls = calls
    return t


def anth_ok(obj, usage=None, stop="end_turn"):
    return (200, {}, {"content": [{"type": "thinking", "thinking": ""}, {"type": "text", "text": json.dumps(obj)}],
                      "stop_reason": stop, "usage": usage or {"input_tokens": 10, "output_tokens": 5,
                                                              "cache_read_input_tokens": 3, "cache_creation_input_tokens": 2}})


def test_anthropic_request_shape_and_usage():
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([anth_ok({"a": 1})])
    p = AnthropicApiProvider(KEY, model="claude-sonnet-5-5", effort="high", transport=t)
    assert p.complete_json("sys", "usr", {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]}) == {"a": 1}
    method, url, headers, body, timeout = t.calls[0]
    assert (method, url, timeout) == ("POST", "https://api.anthropic.com/v1/messages", 180.0)
    assert headers["x-api-key"] == KEY and headers["anthropic-version"] == "2026-10-21" and headers["user-agent"] == "yt-learn"
    assert body["system"] == "sys" and body["messages"] == [{"role": "user", "content": "usr"}]
    assert body["max_tokens"] == 16000 and "temperature" not in body and "thinking" not in body
    assert body["output_config"]["effort"] == "high" and body["output_config"]["format"]["schema"]["additionalProperties"] is False
    assert p.usage == {"input": 10, "cacheRead": 3, "cacheWrite": 2, "output": 5} and p.effortSent == "high"


def test_anthropic_cache_key_matches_claude_cli_and_hits_add_no_usage(tmp_path):
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([anth_ok({"a": 1})])
    p = AnthropicApiProvider(KEY, model="claude-sonnet-5-5", cache_dir=tmp_path, transport=t)
    p.complete_json("s", "u")
    assert "effort" not in t.calls[0][3].get("output_config", {})
    cli = ClaudeCliProvider(model="claude-sonnet-5-5", cache_dir=tmp_path)
    assert cli._cache_path("s", "u", None) == p._cache_path("s", "u", None)
    seen = []
    cli.usage_sink = seen.append
    assert cli.complete_json("s", "u") == {"a": 1}  # cache hit: no subprocess, no usage, sink not called
    assert cli.usage == {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0} and seen == []


def test_anthropic_retries_429_then_succeeds():
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([(429, {"retry-after": "0"}, {"type": "error", "error": {"type": "rate_limit_error", "message": "slow"}}), anth_ok({"a": 2})])
    p = AnthropicApiProvider(KEY, transport=t)
    p._sleep = lambda s: None
    assert p.complete_json("s", "u") == {"a": 2} and len(t.calls) == 2


def test_anthropic_truncated_then_ok_sums_usage_and_adds_suffix():
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([anth_ok({"a": 1}, stop="max_tokens"), anth_ok({"a": 1})])
    p = AnthropicApiProvider(KEY, transport=t)
    assert p.complete_json("s", "u") == {"a": 1}
    assert t.calls[1][3]["messages"][0]["content"].endswith(llm.RETRY_SUFFIX)
    assert p.usage["input"] == 20 and p.usage["output"] == 10


def test_anthropic_401_is_fatal_with_status_no_retry_no_key():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    t = fake_transport([(401, {}, {"type": "error", "error": {"type": "authentication_error", "message": "bad " + KEY}})])
    with pytest.raises(ProviderFatal) as ei:
        AnthropicApiProvider(KEY, transport=t).complete_json("s", "u")
    assert ei.value.status == 401 and KEY not in str(ei.value) and "無效" in str(ei.value) and len(t.calls) == 1


def test_anthropic_400_is_fatal_not_retried():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    t = fake_transport([(400, {}, {"type": "error", "error": {"type": "invalid_request_error", "message": "x"}})])
    with pytest.raises(ProviderFatal) as ei:
        AnthropicApiProvider(KEY, transport=t).complete_json("s", "u")
    assert ei.value.status == 400 and len(t.calls) == 1


def test_exhausted_retries_are_fatal_with_exact_attempt_count():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    err = (503, {}, {"type": "error", "error": {"type": "overloaded_error", "message": "x"}})
    t = fake_transport([err] * 10)
    p = AnthropicApiProvider(KEY, transport=t)
    p._sleep = lambda s: None
    with pytest.raises(ProviderFatal):
        p.complete_json("s", "u")
    assert len(t.calls) == 4


def test_retry_after_beyond_budget_gives_up_without_sleeping():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    t = fake_transport([(429, {"retry-after": "600"}, {"type": "error", "error": {"type": "rate_limit_error", "message": "x"}})])
    p = AnthropicApiProvider(KEY, transport=t)
    slept = []
    p._sleep = slept.append
    with pytest.raises(ProviderFatal):
        p.complete_json("s", "u")
    assert slept == [] and len(t.calls) == 1


def test_transport_error_is_retried_then_fatal_and_scrubbed():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal, TransportError
    t = fake_transport([TransportError("dns " + KEY)] * 10)
    p = AnthropicApiProvider(KEY, transport=t)
    p._sleep = lambda s: None
    with pytest.raises(ProviderFatal) as ei:
        p.complete_json("s", "u")
    assert KEY not in str(ei.value) and len(t.calls) == 4


def test_error_messages_never_contain_key():
    from pipeline.llm import AnthropicApiProvider
    for b in [(400, {}, {"error": {"message": "x " + KEY}}), (500, {}, {"error": {"message": KEY}}), (403, {}, {"error": {"message": KEY}}), (302, {"location": "http://evil/"}, {})]:
        t = fake_transport([b] * 10)
        p = AnthropicApiProvider(KEY, transport=t)
        p._sleep = lambda s: None
        with pytest.raises(ProviderError) as ei:
            p.complete_json("s", "u")
        assert KEY not in str(ei.value)


def test_urllib_transport_refuses_redirects(monkeypatch):
    import io
    import urllib.error
    import urllib.request
    from pipeline.llm import urllib_transport
    built = {}

    class Opener:
        def open(self, req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 302, "Found", {"location": "http://evil/"}, io.BytesIO(b""))

    def build_opener(*handlers):
        built["handlers"] = handlers
        return Opener()
    monkeypatch.setattr(urllib.request, "build_opener", build_opener)
    status, headers, body = urllib_transport("GET", "https://api.anthropic.com/v1/models", {"x-api-key": KEY}, None, 5)
    assert status == 302 and headers["location"] == "http://evil/" and body == b""
    hs = [h for h in built["handlers"] if isinstance(h, urllib.request.HTTPRedirectHandler)]
    assert len(hs) == 1 and type(hs[0]) is not urllib.request.HTTPRedirectHandler
    req = urllib.request.Request("https://api.anthropic.com/v1/models")
    assert hs[0].redirect_request(req, None, 302, "Found", {}, "http://evil/") is None


def test_usage_sink_called_in_order_and_thread_safe():
    import threading
    from pipeline.llm import AnthropicApiProvider
    seen = []
    t = fake_transport([anth_ok({"a": 1})] * 8)
    p = AnthropicApiProvider(KEY, transport=t)
    p.usage_sink = seen.append
    ths = [threading.Thread(target=lambda i=i: p.complete_json("s", f"u{i}")) for i in range(8)]
    [th.start() for th in ths]
    [th.join() for th in ths]
    assert p.usage["input"] == 80 and [s["input"] for s in seen] == [10 * i for i in range(1, 9)]


def test_anthropic_schema_strips_unsupported_keywords():
    from pipeline.intro import INTRO_SCHEMA
    from pipeline.llm import anthropic_schema
    s = anthropic_schema(INTRO_SCHEMA)
    assert "maxItems" not in s["properties"]["lines"] and s["properties"]["lines"]["minItems"] == 1 and s["additionalProperties"] is False


def test_anthropic_list_models_filters_claude_single_attempt():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    t = fake_transport([(200, {}, {"data": [{"id": "claude-opus-5-5"}, {"id": "other"}, {"id": "claude-haiku-5-5"}], "has_more": False})])
    assert AnthropicApiProvider.list_models(KEY, t) == ["claude-opus-5-5", "claude-haiku-5-5"]
    assert t.calls[0][1].startswith("https://api.anthropic.com/v1/models?limit=1000") and t.calls[0][4] == 20
    t2 = fake_transport([(503, {}, {"error": {"message": "x"}})] * 5)
    with pytest.raises(ProviderFatal):
        AnthropicApiProvider.list_models(KEY, t2)
    assert len(t2.calls) == 1


def test_claude_cli_collects_usage_and_scrubs_stderr(monkeypatch):
    install(monkeypatch, [ok({"is_error": False, "result": '{"a": 1}', "usage": {"input_tokens": 7, "output_tokens": 3}})])
    p = ClaudeCliProvider()
    p.complete_json("s", "u")
    assert p.usage == {"input": 7, "cacheRead": 0, "cacheWrite": 0, "output": 3}
    bad = types.SimpleNamespace(returncode=1, stdout="", stderr="leak sk-ant-api03-ABCDEFGH12 x")
    install(monkeypatch, [bad, bad])
    with pytest.raises(ProviderError) as ei:
        ClaudeCliProvider().complete_json("s", "u")
    assert "ABCDEFGH12" not in str(ei.value)


def test_retry_waits_at_least_retry_after_and_max_attempts_override():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    err = (429, {"retry-after": "3"}, {"type": "error", "error": {"type": "rate_limit_error", "message": "x"}})
    t = fake_transport([err, anth_ok({"a": 1})])
    p = AnthropicApiProvider(KEY, transport=t)
    slept = []
    p._sleep = slept.append
    assert p.complete_json("s", "u") == {"a": 1}
    assert len(slept) == 1 and slept[0] >= 3
    t2 = fake_transport([(503, {}, {"error": {"message": "x"}})] * 5)
    p2 = AnthropicApiProvider(KEY, transport=t2)
    p2._sleep = lambda s: None
    p2.MAX_ATTEMPTS = 2
    with pytest.raises(ProviderFatal):
        p2.complete_json("s", "u")
    assert len(t2.calls) == 2


def test_claude_cli_is_error_result_is_scrubbed(monkeypatch):
    bad = ok({"is_error": True, "result": "boom sk-ant-api03-ABCDEFGH12"})
    install(monkeypatch, [bad, bad])
    with pytest.raises(ProviderError) as ei:
        ClaudeCliProvider().complete_json("s", "u")
    assert "ABCDEFGH12" not in str(ei.value)


OKEY = "sk-openai-test-0123456789"


def oa_ok(obj, status="completed", refusal=None):
    content = [{"type": "refusal", "refusal": refusal}] if refusal else [{"type": "output_text", "text": json.dumps(obj)}]
    return (200, {}, {"status": status, "incomplete_details": None if status == "completed" else {"reason": "max_output_tokens"},
                      "output": [{"type": "reasoning", "summary": []}, {"type": "message", "content": content}],
                      "usage": {"input_tokens": 12, "input_tokens_details": {"cached_tokens": 4, "cache_write_tokens": 2},
                                "output_tokens": 6, "output_tokens_details": {"reasoning_tokens": 2}}})


def test_openai_request_shape_and_usage():
    from pipeline.llm import OpenAiApiProvider
    t = fake_transport([oa_ok({"a": 1})])
    p = OpenAiApiProvider(OKEY, model="gpt-6-astra", effort="xhigh", transport=t)
    assert p.complete_json("sys", "usr", {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]}) == {"a": 1}
    method, url, headers, body, timeout = t.calls[0]
    assert (method, url, timeout) == ("POST", "https://api.openai.com/v1/responses", 300.0)
    assert headers["authorization"] == "Bearer " + OKEY
    assert body["instructions"] == "sys" and body["input"] == "usr" and body["store"] is False and body["max_output_tokens"] == 16000
    assert body["text"]["format"]["strict"] is True and body["text"]["format"]["schema"]["additionalProperties"] is False
    assert body["reasoning"] == {"effort": "xhigh"} and "temperature" not in body
    assert p.usage == {"input": 6, "cacheRead": 4, "cacheWrite": 2, "output": 6} and p.effortSent == "xhigh"


def test_openai_effort_400_falls_back_to_high_once():
    from pipeline.llm import OpenAiApiProvider
    t = fake_transport([(400, {}, {"error": {"type": "invalid_request_error", "message": "Unsupported reasoning effort"}}), oa_ok({"a": 1}), oa_ok({"a": 2})])
    p = OpenAiApiProvider(OKEY, model="m", effort="max", transport=t)
    assert p.complete_json("s", "u") == {"a": 1} and t.calls[1][3]["reasoning"] == {"effort": "high"} and p.effortSent == "high"
    assert p.complete_json("s", "u2") == {"a": 2} and t.calls[2][3]["reasoning"] == {"effort": "high"} and len(t.calls) == 3


def test_openai_cache_key_uses_requested_effort_and_provider(tmp_path):
    from pipeline.llm import OpenAiApiProvider
    p = OpenAiApiProvider(OKEY, model="m", effort="max", cache_dir=tmp_path, transport=fake_transport([]))
    f = p._cache_fields("s", "u", None)
    assert f["provider"] == "openai" and f["effort"] == "max"


def test_openai_incomplete_and_refusal_fail_but_bill():
    from pipeline.llm import OpenAiApiProvider
    t = fake_transport([oa_ok({"a": 1}, status="incomplete"), oa_ok({"a": 1}, refusal="no")])
    p = OpenAiApiProvider(OKEY, transport=t)
    with pytest.raises(ProviderError):
        p.complete_json("s", "u")
    assert p.usage["output"] == 12 and len(t.calls) == 2


def test_openai_quota_429_is_fatal_not_retried():
    from pipeline.llm import OpenAiApiProvider, ProviderFatal
    t = fake_transport([(429, {}, {"error": {"type": "insufficient_quota", "code": "insufficient_quota", "message": "x"}})])
    with pytest.raises(ProviderFatal) as ei:
        OpenAiApiProvider(OKEY, transport=t).complete_json("s", "u")
    assert len(t.calls) == 1 and "額度" in str(ei.value) and ei.value.status == 429


def test_openai_list_models_filters_and_sorts():
    from pipeline.llm import OpenAiApiProvider
    data = [{"id": "gpt-5-mini", "created": 1}, {"id": "gpt-6-astra", "created": 3}, {"id": "gpt-4o-realtime", "created": 5},
            {"id": "text-embedding-3", "created": 9}, {"id": "o3", "created": 2}, {"id": "gpt-image-1", "created": 8}, {"id": "gpt-5.5-pro", "created": 7}]
    t = fake_transport([(200, {}, {"object": "list", "data": data})])
    assert OpenAiApiProvider.list_models(OKEY, t) == ["gpt-6-astra", "o3", "gpt-5-mini"] and t.calls[0][4] == 20


@pytest.mark.parametrize("bad", ["sk-ant-abc\ndef-123456", "sk-ant-abc​def-123456"])
def test_urllib_transport_header_with_illegal_characters_is_a_scrubbed_transport_error(bad):
    from pipeline.llm import TransportError, urllib_transport
    with pytest.raises(TransportError) as ei:
        urllib_transport("GET", "http://127.0.0.1:9/v1/models", {"x-api-key": bad}, None, 2)
    assert str(ei.value) == "API key 含不允許的字元" and "sk-ant" not in str(ei.value) and "def" not in str(ei.value)


def test_504_is_retried():
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([(504, {}, {"error": {"message": "gateway timeout"}}), anth_ok({"a": 3})])
    p = AnthropicApiProvider(KEY, transport=t)
    p._sleep = lambda s: None
    assert p.complete_json("s", "u") == {"a": 3} and len(t.calls) == 2


@pytest.mark.parametrize("status", [401, 403])
def test_auth_errors_name_where_to_check(status):
    from pipeline.llm import AnthropicApiProvider, OpenAiApiProvider, ProviderFatal
    for cls, key, where in ((AnthropicApiProvider, KEY, "，請到 Anthropic Console 檢查"), (OpenAiApiProvider, OKEY, "，請到 OpenAI 後台檢查")):
        t = fake_transport([(status, {}, {"error": {"message": "bad " + key}})])
        with pytest.raises(ProviderFatal) as ei:
            cls(key, transport=t).complete_json("s", "u")
        assert str(ei.value) == "API key 無效或沒有權限" + where and ei.value.status == status


def test_openai_quota_message_names_where_to_check():
    from pipeline.llm import OpenAiApiProvider, ProviderFatal
    t = fake_transport([(429, {}, {"error": {"type": "insufficient_quota", "code": "insufficient_quota", "message": "x"}})])
    with pytest.raises(ProviderFatal) as ei:
        OpenAiApiProvider(OKEY, transport=t).complete_json("s", "u")
    assert str(ei.value) == "OpenAI 額度或花費上限已到，請到 OpenAI 後台檢查"
