"""User settings for lesson builds: data/settings.json (model, effort, workers).

Priority for a build: an explicit CLI flag > the saved file > the YTLEARN_* environment > DEFAULTS.
``load`` returns only what the file actually holds (so a missing key falls through to the env);
``resolve`` merges it with the env into the effective settings the UI shows."""
from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

MODELS = ("claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5")
EFFORTS = ("default", "low", "medium", "high", "xhigh", "max")
WORKERS_MIN, WORKERS_MAX = 1, 8

DEFAULTS = {"model": "claude-sonnet-5-5", "effort": "default", "workers": 4}
VALID = {"model": MODELS, "effort": EFFORTS, "workers": (WORKERS_MIN, WORKERS_MAX)}
ENV = {"model": "YTLEARN_MODEL", "effort": "YTLEARN_EFFORT", "workers": "YTLEARN_WORKERS"}


def path_for(root) -> Path:
    return Path(root) / "data" / "settings.json"


def _check(key, value):
    """The value if it is valid for ``key``, else None."""
    if key == "workers":
        # bool is an int subclass and floats like 4.0 are not ints: both are rejected.
        if type(value) is int and WORKERS_MIN <= value <= WORKERS_MAX:
            return value
        return None
    return value if isinstance(value, str) and value in VALID[key] else None


def normalize(obj, partial: bool = False) -> tuple[dict, list[str]]:
    """Validate ``obj`` against the whitelist. Returns ``(settings, errors)``.

    With ``partial`` False every key is required; with True missing keys are simply left out.
    Unknown keys are errors either way, so a typo never silently does nothing."""
    if not isinstance(obj, dict):
        return {}, ["settings must be a JSON object"]
    out, errs = {}, []
    for key in DEFAULTS:
        if key not in obj:
            if not partial:
                errs.append(f"{key} is required")
            continue
        v = _check(key, obj[key])
        if v is None:
            if key == "workers":
                errs.append(f"workers must be an integer {WORKERS_MIN}-{WORKERS_MAX}")
            else:
                errs.append(f"{key} must be one of {', '.join(VALID[key])}")
        else:
            out[key] = v
    for key in obj:
        if key not in DEFAULTS:
            errs.append(f"unknown setting {key!r}")
    return out, errs


def load(root) -> dict:
    """The saved settings (only keys the file holds and that are valid).

    A missing file is ``{}``; an unreadable or invalid file yields the valid keys it does hold
    (possibly none) plus a ``warning`` string, so a build never fails because of it."""
    p = path_for(root)
    try:
        text = p.read_text("utf-8")
    except FileNotFoundError:
        return {}
    except OSError as e:
        return {"warning": f"無法讀取 {p.name}（{e}），改用預設值"}
    try:
        obj = json.loads(text)
    except ValueError:
        return {"warning": f"{p.name} 不是合法的 JSON，改用預設值"}
    settings, errs = normalize(obj, partial=True)
    if errs:
        settings["warning"] = f"{p.name} 有無效的值（{'; '.join(errs[:3])}），該項改用預設值"
    return settings


def save(root, settings: dict) -> dict:
    """Validate and atomically write the full settings; returns what was written.

    Raises ValueError (with the error list joined) if ``settings`` is not a full valid set."""
    clean, errs = normalize(settings)
    if errs:
        raise ValueError("; ".join(errs))
    p = path_for(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{uuid.uuid4().hex}.tmp")  # unique per writer, so concurrent saves never share a tmp
    try:
        tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, p)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return clean


def _from_env(env) -> dict:
    out = {}
    for key, name in ENV.items():
        raw = env.get(name)
        if raw is None or raw == "":
            continue
        if key == "workers":
            try:
                raw = int(raw)
            except ValueError:
                continue
        v = _check(key, raw)
        if v is not None:
            out[key] = v
    return out


def resolve(saved: dict, env) -> dict:
    """Effective settings: saved > env > DEFAULTS. Env values outside the whitelist are ignored here
    (the build itself may still honour them; this view only shows what the settings page can express)."""
    out = dict(DEFAULTS)
    out.update(_from_env(env))
    out.update({k: v for k, v in saved.items() if k in DEFAULTS})
    return out


def apply_to_env(saved: dict, env: dict) -> dict:
    """Return a copy of ``env`` with the saved settings applied for a build subprocess.

    Only keys present in ``saved`` touch the env (anything else is inherited as is); a saved
    ``effort`` of ``default`` removes an inherited YTLEARN_EFFORT so the CLI's own default applies."""
    env = dict(env)
    if "model" in saved:
        env[ENV["model"]] = saved["model"]
    if "effort" in saved:
        if saved["effort"] == "default":
            env.pop(ENV["effort"], None)
        else:
            env[ENV["effort"]] = saved["effort"]
    if "workers" in saved:
        env[ENV["workers"]] = str(saved["workers"])
    return env
