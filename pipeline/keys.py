"""API keys for the API providers: data/keys.json (0600 from creation), env fallback, masking, scrubbing.

Stdlib only; imports ``KEY_OF`` from settings (settings never imports this module). A key must
never reach a browser response, log, argv or error message: callers show ``public`` and run any
text that may carry one through ``scrub``."""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

from pipeline import settings

KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
_MIN_SCRUB = 8
_SK = re.compile(r"sk-[A-Za-z0-9_-]{8,}")
_LEGAL = re.compile(r"[\x21-\x7e]+")  # printable ASCII without space: anything else breaks the HTTP header
BAD_CHARS = "API key 含不允許的字元"


def legal(key: str) -> bool:
    """Whether ``key`` can go into an HTTP header as is (printable ASCII, no spaces or control characters)."""
    return isinstance(key, str) and _LEGAL.fullmatch(key) is not None


def path_for(root) -> Path:
    return Path(root) / "data" / "keys.json"


def load(root) -> dict[str, str]:
    try:
        raw = json.loads(path_for(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in KEY_ENV and isinstance(v, str) and v}


def save(root, updates: dict) -> dict:
    """Merge ``updates`` into the file ("" deletes a provider); return the stored keys. Raises
    ValueError(BAD_CHARS) before writing anything if a key is not ``legal``."""
    if any(name in KEY_ENV and isinstance(v, str) and v and not legal(v) for name, v in updates.items()):
        raise ValueError(BAD_CHARS)
    merged = load(root)
    for name, value in updates.items():
        if name not in KEY_ENV:
            continue
        if isinstance(value, str) and value:
            merged[name] = value
        else:
            merged.pop(name, None)
    p = path_for(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(merged, f)
        os.replace(tmp, p)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return merged


def resolve(root, env) -> dict[str, tuple]:
    """{vendor: (key | None, "file" | "env" | None)}; the file wins over the environment."""
    stored = load(root)
    out = {}
    for name, var in KEY_ENV.items():
        if stored.get(name):
            out[name] = (stored[name], "file")
        elif env.get(var):
            out[name] = (env[var], "env")
        else:
            out[name] = (None, None)
    return out


def public(root, env) -> dict:
    out = {}
    for name, (key, source) in resolve(root, env).items():
        out[name] = {"set": bool(key), "tail": key[-4:] if key else None, "source": source}
    return out


def env_for_build(root, env, provider: str) -> dict:
    """Environment for the build subprocess. CLI providers inherit it untouched; API providers
    get both key variables removed and only their own vendor's resolved key injected."""
    out = dict(env)
    vendor = settings.KEY_OF.get(provider)
    if vendor is None:
        return out
    for var in KEY_ENV.values():
        out.pop(var, None)
    key = resolve(root, env)[vendor][0]
    if key:
        out[KEY_ENV[vendor]] = key
    return out


def all_keys(root, env) -> list[str]:
    return [k for k, _ in resolve(root, env).values() if k]


def scrub(text: str, keys) -> str:
    for k in sorted((k for k in keys if k and len(k) >= _MIN_SCRUB), key=len, reverse=True):
        text = text.replace(k, "<key>")
    return _SK.sub("<key>", text)
