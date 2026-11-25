import json
import os
import stat

import pytest


def test_save_merges_deletes_and_is_0600_from_creation(tmp_path, monkeypatch):
    from pipeline import keys
    opened = []
    real_open = os.open

    def spy_open(path, flags, mode=0o777, *a, **k):
        opened.append((str(path), flags, mode))
        return real_open(path, flags, mode, *a, **k)
    monkeypatch.setattr(os, "open", spy_open)
    for name in ("chmod", "fchmod"):
        monkeypatch.setattr(os, name, lambda *a, **k: (_ for _ in ()).throw(AssertionError(name + " must not be needed")))
    out = keys.save(tmp_path, {"anthropic": "sk-ant-abcdef1234"})
    assert out == {"anthropic": "sk-ant-abcdef1234"}
    assert stat.S_IMODE(keys.path_for(tmp_path).stat().st_mode) == 0o600
    creates = [(f, m) for p, f, m in opened if "keys.json" in p and f & os.O_CREAT]
    assert creates and all(f & os.O_EXCL and m == 0o600 for f, m in creates)
    assert set(keys.save(tmp_path, {"openai": "sk-openai-xyz7890"})) == {"anthropic", "openai"}
    out = keys.save(tmp_path, {"anthropic": ""})
    assert out == {"openai": "sk-openai-xyz7890"} and keys.load(tmp_path) == out
    assert [p.name for p in keys.path_for(tmp_path).parent.iterdir()] == ["keys.json"]


def test_save_cleans_tmp_when_replace_fails(tmp_path, monkeypatch):
    from pipeline import keys
    def boom(a, b):
        raise OSError("boom")
    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        keys.save(tmp_path, {"anthropic": "sk-ant-abcdef1234"})
    assert not keys.path_for(tmp_path).parent.exists() or list(keys.path_for(tmp_path).parent.iterdir()) == []


def test_resolve_prefers_file_then_env(tmp_path):
    from pipeline import keys
    keys.save(tmp_path, {"anthropic": "sk-file-00001234"})
    r = keys.resolve(tmp_path, {"ANTHROPIC_API_KEY": "sk-env-00005678", "OPENAI_API_KEY": "sk-env-oa-9999"})
    assert r["anthropic"] == ("sk-file-00001234", "file") and r["openai"] == ("sk-env-oa-9999", "env")
    assert keys.resolve(tmp_path, {})["openai"] == (None, None)


def test_public_never_returns_whole_key(tmp_path):
    from pipeline import keys
    keys.save(tmp_path, {"anthropic": "sk-file-00001234"})
    pub = keys.public(tmp_path, {})
    assert pub == {"anthropic": {"set": True, "tail": "1234", "source": "file"}, "openai": {"set": False, "tail": None, "source": None}}
    assert "sk-file" not in json.dumps(pub)


def test_env_for_build_api_provider_strips_and_injects_cli_provider_inherits(tmp_path):
    from pipeline import keys
    keys.save(tmp_path, {"openai": "sk-openai-xyz7890", "anthropic": "sk-ant-abcdef1234"})
    inherited = {"PATH": "/bin", "ANTHROPIC_API_KEY": "sk-env-inherited-1", "OPENAI_API_KEY": "sk-env-inherited-2"}
    env = keys.env_for_build(tmp_path, inherited, "openai-api")
    assert env["OPENAI_API_KEY"] == "sk-openai-xyz7890" and "ANTHROPIC_API_KEY" not in env and env["PATH"] == "/bin"
    env = keys.env_for_build(tmp_path, inherited, "claude-cli")
    assert env == inherited and env is not inherited  # CLI builds inherit the environment untouched
    assert inherited["ANTHROPIC_API_KEY"] == "sk-env-inherited-1"


def test_scrub_replaces_whole_keys_and_sk_prefixes():
    from pipeline import keys
    assert keys.scrub("bad key sk-openai-xyz7890 here", ["sk-openai-xyz7890", "short"]) == "bad key <key> here"
    assert keys.scrub("got sk-ant-api03-ABCDEFGH12 back", []) == "got <key> back"


def test_load_tolerates_bad_file(tmp_path):
    from pipeline import keys
    keys.path_for(tmp_path).parent.mkdir(parents=True)
    keys.path_for(tmp_path).write_text("{not json")
    assert keys.load(tmp_path) == {}


def test_save_rejects_keys_outside_printable_ascii(tmp_path):
    import pytest
    from pipeline import keys
    for bad in ("sk-ant-abc​def12345", "sk-ant-abc def12345", "sk-ant-abc\ndef12345", "sk-ant-é12345678"):
        with pytest.raises(ValueError, match="API key 含不允許的字元"):
            keys.save(tmp_path, {"anthropic": bad})
    assert keys.load(tmp_path) == {}
    keys.save(tmp_path, {"anthropic": "sk-ant-00001234"})
    assert keys.save(tmp_path, {"anthropic": ""}) == {}  # "" still deletes
