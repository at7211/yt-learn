"""User settings for lesson builds: data/settings.json (provider, model, effort, workers, budgetUsd).

Priority for a build: an explicit CLI flag > the saved file > the YTLEARN_* environment > DEFAULTS.
``load`` returns only what the file actually holds (so a missing key falls through to the env);
``resolve`` merges it with the env into the effective settings the UI shows.

Which ``model`` is valid depends on ``provider``: the CLI whitelist for ``claude-cli``, the
whitelist or the cached Anthropic list (data/models.json) for ``anthropic-api``, the cached OpenAI
list for ``openai-api``, and any non-empty string for ``codex-cli`` (the build ignores it there).
Stdlib only: pipeline/keys.py imports ``KEY_OF`` from here, so this module never imports keys or llm."""
from __future__ import annotations

import json
import math
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

PROVIDERS = ("claude-cli", "codex-cli", "anthropic-api", "openai-api")
PROVIDER_ALIASES = {"claude": "claude-cli", "codex": "codex-cli"}
API_PROVIDERS = ("anthropic-api", "openai-api")
KEY_OF = {"anthropic-api": "anthropic", "openai-api": "openai"}

MODELS = ("claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5")
EFFORTS = ("default", "low", "medium", "high", "xhigh", "max")
WORKERS_MIN, WORKERS_MAX = 1, 8

DEFAULTS = {"provider": "claude-cli", "model": "claude-sonnet-5-5", "effort": "default", "workers": 4, "budgetUsd": None}
VALID = {"provider": PROVIDERS, "model": MODELS, "effort": EFFORTS, "workers": (WORKERS_MIN, WORKERS_MAX)}
ENV = {"provider": "YTLEARN_PROVIDER", "model": "YTLEARN_MODEL", "effort": "YTLEARN_EFFORT",
       "workers": "YTLEARN_WORKERS", "budgetUsd": "YTLEARN_BUDGET_USD"}
# Keys that may be absent from a full (non-partial) settings object: older three-key clients
# (and web/settings.js until it learns them) still save, getting these defaults.
OPTIONAL = ("provider", "budgetUsd")
INCONSISTENT = "來源與模型不一致，改用預設"
DROPPED = "provider 與 model 不一致，兩者都改用預設"

_BAD = object()  # "invalid" sentinel: None is a valid budgetUsd


def path_for(root) -> Path:
    return Path(root) / "data" / "settings.json"


def models_path(root) -> Path:
    return Path(root) / "data" / "models.json"


def _write_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{uuid.uuid4().hex}.tmp")  # unique per writer, so concurrent saves never share a tmp
    try:
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, p)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def load_models(root) -> dict:
    """The cached model lists ``{"anthropic": [...], "openai": [...], "fetchedAt": iso}``; missing or broken file is ``{}``."""
    try:
        obj = json.loads(models_path(root).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return obj if isinstance(obj, dict) else {}


def save_models(root, provider_key: str, ids) -> dict:
    """Replace one provider's cached model list (keeping the other) and stamp ``fetchedAt``; returns the whole cache."""
    if provider_key not in KEY_OF.values():
        raise ValueError(f"unknown provider key {provider_key!r}")
    cache = load_models(root)
    cache[provider_key] = [str(i) for i in ids]
    cache["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _write_json(models_path(root), cache)
    return cache


def _ids(models, key) -> tuple:
    got = (models or {}).get(key)
    return tuple(i for i in got if isinstance(i, str)) if isinstance(got, list) else ()


def _model_ok(provider, model, models) -> bool:
    """Whether ``model`` is usable with ``provider`` given the cached lists ``models``."""
    if not isinstance(model, str) or not model:
        return False
    if provider == "codex-cli":
        return True
    if provider == "openai-api":
        return model in _ids(models, "openai")
    if provider == "anthropic-api":
        return model in MODELS or model in _ids(models, "anthropic")
    return model in MODELS


def _model_error(provider) -> str:
    if provider == "openai-api":
        return "model 不在 OpenAI 模型清單裡，請先測試連線取得模型清單"
    if provider == "anthropic-api":
        return f"model must be one of {', '.join(MODELS)} or in the Anthropic model list"
    if provider == "codex-cli":
        return "model must be a non-empty string"
    return f"model must be one of {', '.join(MODELS)}"


def _check(key, value):
    """The value if it is valid for ``key`` (any key but ``model``), else ``_BAD``."""
    if key == "workers":
        # bool is an int subclass and floats like 4.0 are not ints: both are rejected.
        if type(value) is int and WORKERS_MIN <= value <= WORKERS_MAX:
            return value
        return _BAD
    if key == "budgetUsd":
        if value is None:
            return None
        try:
            ok = type(value) in (int, float) and math.isfinite(value) and value > 0
        except OverflowError:  # a huge JSON int cannot become a float
            ok = False
        return value if ok else _BAD
    return value if isinstance(value, str) and value in VALID[key] else _BAD


def normalize(obj, partial: bool = False, models=None) -> tuple[dict, list[str]]:
    """Validate ``obj``. Returns ``(settings, errors)``.

    With ``partial`` False every key is required except ``provider`` (missing → ``claude-cli``) and
    ``budgetUsd`` (missing → None); with True missing keys are simply left out. ``model`` is checked
    against the provider's rules (missing provider → ``claude-cli``) using the cached lists ``models``
    (None → none cached). In partial mode a model the provider rejects drops ``provider`` too, and
    so does an API provider left without a valid model, so a load never yields half a pair. Unknown keys are errors
    either way, so a typo never silently does nothing."""
    if not isinstance(obj, dict):
        return {}, ["settings must be a JSON object"]
    out, errs = {}, []
    for key in DEFAULTS:  # provider precedes model, so the model check sees the validated provider
        if key not in obj:
            if not partial:
                if key in OPTIONAL:
                    out[key] = DEFAULTS[key]
                else:
                    errs.append(f"{key} is required")
            continue
        value = obj[key]
        if key == "model":
            provider = out.get("provider", "claude-cli")
            if _model_ok(provider, value, models):
                out[key] = value
                continue
            errs.append(_model_error(provider))
            if partial and isinstance(value, str) and value and out.pop("provider", None) is not None:
                errs.append(DROPPED)
            continue
        v = _check(key, value)
        if v is not _BAD:
            out[key] = v
        elif key == "workers":
            errs.append(f"workers must be an integer {WORKERS_MIN}-{WORKERS_MAX}")
        elif key == "budgetUsd":
            errs.append("budgetUsd must be null or a positive number")
        else:
            errs.append(f"{key} must be one of {', '.join(VALID[key])}")
    if partial and out.get("provider") in API_PROVIDERS and "model" not in out:
        # an API provider without a model it accepts would reach the build half-configured
        out.pop("provider")
        errs.append(DROPPED)
    for key in obj:
        if key not in DEFAULTS:
            errs.append(f"unknown setting {key!r}")
    return out, errs


def load(root, models=None) -> dict:
    """The saved settings (only keys the file holds and that are valid).

    A missing file is ``{}``; an unreadable or invalid file yields the valid keys it does hold
    (possibly none) plus a ``warning`` string, so a build never fails because of it.
    ``models`` None reads data/models.json."""
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
    if models is None:
        models = load_models(root)
    settings, errs = normalize(obj, partial=True, models=models)
    if errs:
        settings["warning"] = f"{p.name} 有無效的值（{'; '.join(errs[:3])}），該項改用預設值"
    return settings


def save(root, settings: dict, models=None) -> dict:
    """Validate and atomically write the full settings; returns what was written.

    Raises ValueError (with the error list joined) if ``settings`` is not a full valid set.
    ``models`` None reads data/models.json."""
    if models is None:
        models = load_models(root)
    clean, errs = normalize(settings, models=models)
    if errs:
        raise ValueError("; ".join(errs))
    _write_json(path_for(root), clean)
    return clean


def _from_env(env) -> dict:
    """Valid env values for every key but ``model`` (whose rule depends on the final provider)."""
    out = {}
    for key, name in ENV.items():
        raw = env.get(name)
        if key == "model" or raw is None or raw == "":
            continue
        if key == "provider":
            raw = PROVIDER_ALIASES.get(raw, raw)
        elif key == "workers":
            try:
                raw = int(raw)
            except ValueError:
                continue
        elif key == "budgetUsd":
            try:
                raw = float(raw)
            except ValueError:
                continue
        v = _check(key, raw)
        if v is not _BAD and v is not None:
            out[key] = v
    return out


def resolve(saved: dict, env, models=None) -> dict:
    """Effective settings: saved > env > DEFAULTS. Env values outside what the settings page can
    express (e.g. YTLEARN_MODEL=opus, YTLEARN_WORKERS=12) are dropped here in favour of DEFAULTS. A CLI
    build the server starts still honours them, because it applies only the file-held settings to its
    inherited env (ruling R11); an API build gets this resolved result, so they never reach it. YTLEARN_MODEL is judged by
    the final provider (for anthropic-api only the MODELS whitelist, as for claude-cli). If the merged provider and model do not fit together (only possible with an
    API provider), both fall back to DEFAULTS and ``warning`` says so; a CLI provider never warns."""
    saved = {k: v for k, v in saved.items() if k in DEFAULTS}
    from_env = _from_env(env)
    provider = saved.get("provider", from_env.get("provider", DEFAULTS["provider"]))
    raw_model = env.get(ENV["model"])
    # env model: claude-cli and anthropic-api keep the plain MODELS whitelist (no cached list)
    if _model_ok(provider, raw_model, None if provider == "anthropic-api" else models):
        from_env["model"] = raw_model
    out = {**DEFAULTS, **from_env, **saved}
    if not _model_ok(out["provider"], out["model"], models):
        out["provider"], out["model"] = DEFAULTS["provider"], DEFAULTS["model"]
        out["warning"] = INCONSISTENT
    return out


def apply_to_env(saved: dict, env: dict) -> dict:
    """Return a copy of ``env`` with the saved settings applied for a build subprocess.

    Only keys present in ``saved`` touch the env (anything else is inherited as is; ``warning`` is
    ignored); a saved ``effort`` of ``default`` removes an inherited YTLEARN_EFFORT so the CLI's own
    default applies, and a ``budgetUsd`` of None removes an inherited YTLEARN_BUDGET_USD."""
    env = dict(env)
    if "provider" in saved:
        env[ENV["provider"]] = saved["provider"]
    if "model" in saved:
        env[ENV["model"]] = saved["model"]
    if "effort" in saved:
        if saved["effort"] == "default":
            env.pop(ENV["effort"], None)
        else:
            env[ENV["effort"]] = saved["effort"]
    if "workers" in saved:
        env[ENV["workers"]] = str(saved["workers"])
    if "budgetUsd" in saved:
        if saved["budgetUsd"] is None:
            env.pop(ENV["budgetUsd"], None)
        else:
            env[ENV["budgetUsd"]] = str(saved["budgetUsd"])
    return env
