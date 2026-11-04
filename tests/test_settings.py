import json
import threading

import pytest

from pipeline import settings as st


def test_defaults_are_valid():
    clean, errs = st.normalize(st.DEFAULTS)
    assert errs == [] and clean == st.DEFAULTS


@pytest.mark.parametrize("bad", [
    {"model": "gpt-4", "effort": "default", "workers": 4},
    {"model": "claude-sonnet-5-5", "effort": "huge", "workers": 4},
    {"model": "claude-sonnet-5-5", "effort": "default", "workers": 0},
    {"model": "claude-sonnet-5-5", "effort": "default", "workers": 9},
    {"model": "claude-sonnet-5-5", "effort": "default", "workers": True},
    {"model": "claude-sonnet-5-5", "effort": "default", "workers": 4.0},
    {"model": "claude-sonnet-5-5", "effort": "default", "workers": "4"},
    {"model": "claude-sonnet-5-5", "effort": "default"},
    {"model": "claude-sonnet-5-5", "effort": "default", "workers": 4, "extra": 1},
    {**st.DEFAULTS, "provider": "gpt"},
])
def test_normalize_rejects(bad):
    _, errs = st.normalize(bad)
    assert errs


def test_normalize_non_object():
    assert st.normalize([1])[1] and st.normalize(None)[1]


def test_load_missing_is_empty(tmp_path):
    assert st.load(tmp_path) == {}


def test_save_first_write_creates_dir_and_round_trips(tmp_path):
    s = {"model": "claude-opus-5-5", "effort": "high", "workers": 2}
    full = dict(st.DEFAULTS, **s)
    assert st.save(tmp_path, s) == full
    assert json.loads((tmp_path / "data" / "settings.json").read_text("utf-8")) == full
    assert st.load(tmp_path) == full
    assert [p.name for p in (tmp_path / "data").iterdir()] == ["settings.json"]


def test_save_invalid_raises_and_writes_nothing(tmp_path):
    with pytest.raises(ValueError):
        st.save(tmp_path, {"model": "x", "effort": "default", "workers": 4})
    assert not (tmp_path / "data" / "settings.json").exists()


def test_load_broken_file_warns(tmp_path):
    p = tmp_path / "data" / "settings.json"
    p.parent.mkdir()
    p.write_text("{not json", "utf-8")
    got = st.load(tmp_path)
    assert set(got) == {"warning"}
    assert st.resolve(got, {}) == st.DEFAULTS


def test_load_partially_invalid_keeps_good_keys(tmp_path):
    p = tmp_path / "data" / "settings.json"
    p.parent.mkdir()
    p.write_text(json.dumps({"model": "claude-haiku-5-5", "workers": 99}), "utf-8")
    got = st.load(tmp_path)
    assert got["model"] == "claude-haiku-5-5" and "workers" not in got and "warning" in got


def test_concurrent_saves_leave_one_valid_file(tmp_path):
    choices = [{"model": m, "effort": e, "workers": w}
               for m, e, w in zip(st.MODELS * 4, st.EFFORTS * 2, range(1, 9))]
    threads = [threading.Thread(target=st.save, args=(tmp_path, c)) for c in choices]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    got = st.load(tmp_path)
    assert got in [dict(st.DEFAULTS, **x) for x in choices]
    assert [p.name for p in (tmp_path / "data").iterdir()] == ["settings.json"]


def test_resolve_priority():
    env = {"YTLEARN_MODEL": "claude-opus-5-5", "YTLEARN_EFFORT": "low", "YTLEARN_WORKERS": "6"}
    assert st.resolve({}, {}) == st.DEFAULTS
    assert st.resolve({}, env) == dict(st.DEFAULTS, **{"model": "claude-opus-5-5", "effort": "low", "workers": 6})
    saved = {"model": "claude-haiku-5-5", "effort": "default", "warning": "x"}
    assert st.resolve(saved, env) == dict(st.DEFAULTS, **{"model": "claude-haiku-5-5", "effort": "default", "workers": 6})
    # env values the settings page cannot express are ignored in the effective view
    assert st.resolve({}, {"YTLEARN_MODEL": "opus", "YTLEARN_WORKERS": "abc"}) == st.DEFAULTS


def test_apply_to_env():
    base = {"PATH": "/bin", "YTLEARN_EFFORT": "max", "YTLEARN_MODEL": "opus"}
    assert st.apply_to_env({}, base) == base
    out = st.apply_to_env({"model": "claude-haiku-5-5", "effort": "default", "workers": 8}, base)
    assert out == {"PATH": "/bin", "YTLEARN_MODEL": "claude-haiku-5-5", "YTLEARN_WORKERS": "8"}
    assert base["YTLEARN_EFFORT"] == "max"  # input not mutated
    assert st.apply_to_env({"effort": "high"}, base)["YTLEARN_EFFORT"] == "high"


def test_defaults_include_provider_and_budget():
    assert st.DEFAULTS["provider"] == "claude-cli" and st.DEFAULTS["budgetUsd"] is None
    assert st.normalize(st.DEFAULTS) == (st.DEFAULTS, [])


def test_three_key_client_still_accepted():
    clean, errs = st.normalize({"model": "claude-opus-5-5", "effort": "high", "workers": 2})
    assert errs == [] and clean == {"provider": "claude-cli", "model": "claude-opus-5-5", "effort": "high", "workers": 2, "budgetUsd": None}


def test_old_settings_file_without_provider_loads_as_claude_cli(tmp_path):
    st.path_for(tmp_path).parent.mkdir(parents=True)
    st.path_for(tmp_path).write_text(json.dumps({"model": "claude-opus-5-5", "effort": "high", "workers": 2}))
    r = st.resolve(st.load(tmp_path), {})
    assert r["provider"] == "claude-cli" and r["model"] == "claude-opus-5-5"


def test_load_drops_provider_and_model_together_when_inconsistent(tmp_path):
    st.path_for(tmp_path).parent.mkdir(parents=True)
    st.path_for(tmp_path).write_text(json.dumps(dict(st.DEFAULTS, provider="openai-api", model="gpt-6-astra")))
    saved = st.load(tmp_path)  # no data/models.json
    assert "provider" not in saved and "model" not in saved and "warning" in saved
    assert st.resolve(saved, {})["provider"] == "claude-cli"


def test_env_provider_alias_and_budget_in_resolve():
    assert st.resolve({}, {"YTLEARN_PROVIDER": "codex"})["provider"] == "codex-cli"
    r = st.resolve({}, {"YTLEARN_PROVIDER": "openai-api"})  # no usable OpenAI model: falls back with a warning
    assert r["provider"] == "claude-cli" and "warning" in r
    r = st.resolve({}, {"YTLEARN_PROVIDER": "openai-api", "YTLEARN_MODEL": "gpt-6-astra"}, models={"openai": ["gpt-6-astra"], "anthropic": []})
    assert r["provider"] == "openai-api" and r["model"] == "gpt-6-astra" and "warning" not in r
    assert st.resolve({}, {"YTLEARN_PROVIDER": "nope"})["provider"] == "claude-cli"
    assert "warning" not in st.resolve({}, {"YTLEARN_MODEL": "opus"})  # CLI source never warns
    assert st.resolve({}, {"YTLEARN_BUDGET_USD": "2.5"})["budgetUsd"] == 2.5
    assert st.resolve({}, {"YTLEARN_BUDGET_USD": "x"})["budgetUsd"] is None


def test_resolve_rejects_inconsistent_provider_model_combo(tmp_path):
    r = st.resolve({}, {"YTLEARN_PROVIDER": "openai-api", "YTLEARN_MODEL": "gpt-6-astra"})
    assert r["provider"] == "claude-cli" and r["model"] == "claude-sonnet-5-5" and "warning" in r
    r = st.resolve({"model": "claude-opus-5-5"}, {"YTLEARN_PROVIDER": "openai-api"})
    assert r["provider"] == "claude-cli" and r["model"] == "claude-sonnet-5-5" and "warning" in r
    r = st.resolve({}, {"YTLEARN_PROVIDER": "openai-api", "YTLEARN_MODEL": "gpt-6-astra"}, models={"openai": ["gpt-6-astra"], "anthropic": []})
    assert r["provider"] == "openai-api" and r["model"] == "gpt-6-astra" and "warning" not in r


def test_openai_model_requires_models_cache():
    s = dict(st.DEFAULTS, provider="openai-api", model="gpt-6-astra")
    assert any("測試連線" in e for e in st.normalize(s, models={})[1])
    assert st.normalize(s, models={"openai": ["gpt-6-astra"], "anthropic": []}) == (s, [])


def test_save_validates_with_models_cache(tmp_path):
    s = dict(st.DEFAULTS, provider="openai-api", model="gpt-6-astra")
    with pytest.raises(ValueError):
        st.save(tmp_path, s)
    st.save_models(tmp_path, "openai", ["gpt-6-astra"])
    assert st.save(tmp_path, s) == s and st.load(tmp_path)["model"] == "gpt-6-astra"


def test_anthropic_api_accepts_whitelist_or_cached_list():
    s = dict(st.DEFAULTS, provider="anthropic-api", model="claude-sonnet-5-5")
    assert st.normalize(s, models={})[1] == []
    s["model"] = "claude-opus-6-0"
    assert st.normalize(s, models={})[1]
    assert st.normalize(s, models={"anthropic": ["claude-opus-6-0"], "openai": []})[1] == []


def test_codex_cli_model_not_validated():
    assert st.normalize(dict(st.DEFAULTS, provider="codex-cli", model="anything"))[1] == []


@pytest.mark.parametrize("bad", [0, -1, True, "5", float("nan"), float("inf"), 10**400])
def test_budget_rejects(bad):
    assert st.normalize(dict(st.DEFAULTS, budgetUsd=bad))[1]


def test_apply_to_env_writes_provider_and_budget():
    env = st.apply_to_env({"provider": "openai-api", "budgetUsd": 3}, {"YTLEARN_BUDGET_USD": "9"})
    assert env["YTLEARN_PROVIDER"] == "openai-api" and env["YTLEARN_BUDGET_USD"] == "3"
    assert "YTLEARN_BUDGET_USD" not in st.apply_to_env({"budgetUsd": None}, {"YTLEARN_BUDGET_USD": "9"})


def test_models_cache_round_trip(tmp_path):
    assert st.load_models(tmp_path) == {}
    out = st.save_models(tmp_path, "openai", ["gpt-6-astra", "gpt-5-mini"])
    assert out["openai"] == ["gpt-6-astra", "gpt-5-mini"] and out["fetchedAt"]
    out = st.save_models(tmp_path, "anthropic", ["claude-opus-5-5"])
    assert st.load_models(tmp_path)["openai"] == ["gpt-6-astra", "gpt-5-mini"] and out["anthropic"] == ["claude-opus-5-5"]


def test_load_huge_budget_int_does_not_crash(tmp_path):
    st.path_for(tmp_path).parent.mkdir(parents=True)
    st.path_for(tmp_path).write_text('{"model": "claude-opus-5-5", "budgetUsd": ' + "9" * 400 + "}")
    got = st.load(tmp_path)
    assert "budgetUsd" not in got and got["model"] == "claude-opus-5-5" and "warning" in got


@pytest.mark.parametrize("obj", [
    {"provider": "openai-api", "model": 5, "effort": "high", "workers": 2},
    {"provider": "openai-api", "effort": "high", "workers": 2},
])
def test_load_drops_api_provider_without_usable_model(tmp_path, obj):
    st.path_for(tmp_path).parent.mkdir(parents=True)
    st.path_for(tmp_path).write_text(json.dumps(obj))
    got = st.load(tmp_path)
    assert "provider" not in got and "warning" in got and got["effort"] == "high"


def test_inconsistency_note_only_when_provider_dropped():
    _, errs = st.normalize({"provider": "gpt", "model": "gpt-6-astra"}, partial=True, models={})
    assert not any("不一致" in e for e in errs)
    _, errs = st.normalize({"provider": "openai-api", "model": "gpt-6-astra"}, partial=True, models={})
    assert any("不一致" in e for e in errs)


def test_resolve_env_model_for_anthropic_api_is_whitelist_only():
    r = st.resolve({}, {"YTLEARN_PROVIDER": "anthropic-api", "YTLEARN_MODEL": "claude-x"}, models={"anthropic": ["claude-x"], "openai": []})
    assert r["provider"] == "anthropic-api" and r["model"] == st.DEFAULTS["model"] and "warning" not in r
