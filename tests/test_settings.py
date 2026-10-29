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
    assert st.save(tmp_path, s) == s
    assert json.loads((tmp_path / "data" / "settings.json").read_text("utf-8")) == s
    assert st.load(tmp_path) == s
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
    assert got in choices
    assert [p.name for p in (tmp_path / "data").iterdir()] == ["settings.json"]


def test_resolve_priority():
    env = {"YTLEARN_MODEL": "claude-opus-5-5", "YTLEARN_EFFORT": "low", "YTLEARN_WORKERS": "6"}
    assert st.resolve({}, {}) == st.DEFAULTS
    assert st.resolve({}, env) == {"model": "claude-opus-5-5", "effort": "low", "workers": 6}
    saved = {"model": "claude-haiku-5-5", "effort": "default", "warning": "x"}
    assert st.resolve(saved, env) == {"model": "claude-haiku-5-5", "effort": "default", "workers": 6}
    # env values the settings page cannot express are ignored in the effective view
    assert st.resolve({}, {"YTLEARN_MODEL": "opus", "YTLEARN_WORKERS": "abc"}) == st.DEFAULTS


def test_apply_to_env():
    base = {"PATH": "/bin", "YTLEARN_EFFORT": "max", "YTLEARN_MODEL": "opus"}
    assert st.apply_to_env({}, base) == base
    out = st.apply_to_env({"model": "claude-haiku-5-5", "effort": "default", "workers": 8}, base)
    assert out == {"PATH": "/bin", "YTLEARN_MODEL": "claude-haiku-5-5", "YTLEARN_WORKERS": "8"}
    assert base["YTLEARN_EFFORT"] == "max"  # input not mutated
    assert st.apply_to_env({"effort": "high"}, base)["YTLEARN_EFFORT"] == "high"
