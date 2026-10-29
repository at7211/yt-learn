"""LLM providers: wrap the locally logged-in `claude` or `codex` CLI (no API key)."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import tomllib
from pathlib import Path
from typing import Protocol

RETRY_SUFFIX = "\n\n(上一次輸出不是合法 JSON，請只輸出符合 schema 的 JSON。)"

EFFORTS = ("low", "medium", "high", "xhigh", "max")  # what `claude --effort` accepts
# Codex's model_reasoning_effort tops out at high: the two higher levels fall back to it.
CODEX_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}


class ProviderError(Exception):
    pass


class Provider(Protocol):
    def complete_json(self, system: str, user: str, schema: dict | None = None) -> dict: ...


class FakeProvider:
    def __init__(self, responses: list[dict | Exception]):
        self.responses = list(responses)
        self.calls: list[tuple[str, str, dict | None]] = []

    def complete_json(self, system: str, user: str, schema: dict | None = None) -> dict:
        self.calls.append((system, user, schema))
        if not self.responses:
            raise AssertionError("FakeProvider called more times than responses given")
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


class _Failure(Exception):
    pass


_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)


def _parse_object(text: str, what: str) -> dict:
    """A JSON object from model text, tolerating a ```json fence; anything else is a _Failure."""
    text = text.strip()
    m = _FENCE.match(text)
    if m:
        text = m.group(1)
    try:
        val = json.loads(text)
    except ValueError:
        raise _Failure(f"{what} is not valid JSON") from None
    if not isinstance(val, dict):
        raise _Failure(f"{what} JSON is not an object")
    return val


class _CliProvider:
    """Shared cache + one retry around a CLI call; subclasses implement ``_call``."""
    name = "claude"
    default_timeout = 180.0

    def __init__(self, model: str | None = None, cache_dir: Path | None = None,
                 prompt_version: int = 1, timeout: float | None = None, effort: str | None = None):
        self.model = model
        self.effort = effort or None  # None = the CLI's own default (no flag passed)
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.prompt_version = prompt_version
        self.timeout = self.default_timeout if timeout is None else timeout
        self.calls = 0
        self.cache_hits = 0

    def _cache_fields(self, system: str, user: str, schema: dict | None) -> dict:
        # Claude keeps the original key shape so caches built before CodexCliProvider existed still hit.
        # With no explicit effort the key is exactly what it was before effort existed, so old caches hit.
        fields = {"model": self.model or "default", "promptVersion": self.prompt_version,
                  "system": system, "user": user, "schema": schema}
        if self.effort:
            fields["effort"] = self.effort
        return fields

    def _cache_path(self, system: str, user: str, schema: dict | None) -> Path:
        key = hashlib.sha256(json.dumps(self._cache_fields(system, user, schema),
                                        sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        return self.cache_dir / f"{key}.json"

    def _cache_get(self, path: Path) -> dict | None:
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if (isinstance(d, dict) and d.get("model") == (self.model or "default")
                and d.get("effort", "default") == (self.effort or "default")
                and d.get("promptVersion") == self.prompt_version and isinstance(d.get("response"), dict)):
            return d["response"]
        return None

    def _cache_put(self, path: Path, resp: dict) -> None:
        tmp = None
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps({"model": self.model or "default", "effort": self.effort or "default",
                                       "promptVersion": self.prompt_version, "response": resp},
                                      ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            try:
                if tmp is not None:
                    tmp.unlink()
            except OSError:
                pass

    def complete_json(self, system: str, user: str, schema: dict | None = None) -> dict:
        path = None
        if self.cache_dir:
            path = self._cache_path(system, user, schema)
            hit = self._cache_get(path)
            if hit is not None:
                self.cache_hits += 1
                return hit
        self.calls += 1  # logical completions; a call with a retry counts once
        try:
            try:
                resp = self._call(system, user, schema)
            except _Failure:
                resp = self._call(system, user + RETRY_SUFFIX, schema)
        except _Failure as e:
            raise ProviderError(str(e)) from None
        if path:
            self._cache_put(path, resp)
        return resp

    def _call(self, system: str, user: str, schema: dict | None) -> dict:  # pragma: no cover - abstract
        raise NotImplementedError


class ClaudeCliProvider(_CliProvider):
    name = "claude"

    def _call(self, system: str, user: str, schema: dict | None) -> dict:
        argv = ["claude", "-p", "--no-session-persistence", "--output-format", "json"]
        if self.model:
            argv += ["--model", self.model]
        if self.effort:
            argv += ["--effort", self.effort]
        argv += ["--system-prompt", system]
        if schema is not None:
            argv += ["--json-schema", json.dumps(schema, ensure_ascii=False)]
        argv += ["--tools", ""]
        try:
            proc = subprocess.run(argv, input=user, capture_output=True, text=True, timeout=self.timeout)
        except FileNotFoundError:
            raise ProviderError("claude CLI not found on PATH") from None
        except subprocess.TimeoutExpired:
            raise _Failure(f"claude CLI timed out after {self.timeout}s") from None
        if proc.returncode != 0:
            raise _Failure(f"claude CLI exit {proc.returncode}: {(proc.stderr or '').strip()[:200]}")
        try:
            outer = json.loads(proc.stdout)
        except ValueError:
            raise _Failure("claude CLI stdout is not JSON") from None
        if not isinstance(outer, dict):
            raise _Failure("claude CLI output is not an object")
        if outer.get("is_error"):
            raise _Failure(f"claude CLI error: {str(outer.get('result'))[:200]}")
        so = outer.get("structured_output")
        if isinstance(so, dict):
            return so
        text = outer.get("result")
        if not isinstance(text, str):
            raise _Failure("no result in claude CLI output")
        return _parse_object(text, "result")


class CodexCliProvider(_CliProvider):
    """`codex exec` in non-interactive mode. There is no system-prompt flag, so the system text leads
    the stdin prompt. The schema goes in via --output-schema; the final message is read from the -o
    file (stdout's last non-empty line is the fallback). The call runs read-only, ephemeral, inside an
    empty temp directory so the agent has nothing to look at but the prompt."""
    name = "codex"
    default_timeout = 300.0
    # A pure question-and-answer call: no shell tool, no hooks, no web search, never ask for approval.
    ISOLATION = ["-c", 'approval_policy="never"', "-c", "features.shell_tool=false",
                 "-c", "features.hooks=false", "-c", 'web_search="disabled"']

    def __init__(self, model: str | None = None, cache_dir: Path | None = None,
                 prompt_version: int = 1, timeout: float | None = None, effort: str | None = None):
        # Resolve the user's configured default model up front so the cache key names the real model
        # (a bare "default" would keep serving old answers after the user changes ~/.codex/config.toml).
        # ``effort`` is stored as the level Codex actually gets (xhigh/max -> high).
        super().__init__(model or configured_codex_model(), cache_dir, prompt_version, timeout,
                         CODEX_EFFORT.get(effort) if effort else None)

    def _cache_fields(self, system, user, schema):
        return {"provider": "codex", **super()._cache_fields(system, user, schema)}

    def _call(self, system: str, user: str, schema: dict | None) -> dict:
        try:
            with tempfile.TemporaryDirectory(prefix="ytlearn-codex-") as tmp:
                return self._call_in(tmp, system, user, schema)
        except OSError as e:  # temp dir, schema file or output file trouble
            raise _Failure(f"codex CLI workspace error: {e}") from None

    def _call_in(self, tmp: str, system: str, user: str, schema: dict | None) -> dict:
        last = Path(tmp) / "last.txt"
        argv = ["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
                "--color", "never", *self.ISOLATION, "-C", tmp, "-o", str(last)]
        if schema is not None:
            schema_path = Path(tmp) / "schema.json"
            schema_path.write_text(json.dumps(strict_schema(schema), ensure_ascii=False), encoding="utf-8")
            argv += ["--output-schema", str(schema_path)]
        if self.model:
            argv += ["-m", self.model]
        if self.effort:
            argv += ["-c", f'model_reasoning_effort="{self.effort}"']
        argv.append("-")
        prompt = system + "\n\n---\n\n" + user
        try:
            proc = subprocess.run(argv, input=prompt, capture_output=True, text=True, encoding="utf-8",
                                  timeout=self.timeout)
        except FileNotFoundError:
            raise ProviderError("codex CLI not found on PATH") from None
        except subprocess.TimeoutExpired:
            raise _Failure(f"codex CLI timed out after {self.timeout}s") from None
        if proc.returncode != 0:
            raise _Failure(f"codex CLI exit {proc.returncode}: {(proc.stderr or '').strip()[-200:]}")
        text = ""
        try:
            text = last.read_text(encoding="utf-8")
        except OSError:
            pass
        if text.strip():
            return _parse_object(text, "codex final message")
        # stdout fallback: the final message is the latest tail of stdout that parses as an object
        # (it may be fenced and span several lines; the banner lines above it never parse).
        lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
        for i in range(len(lines) - 1, -1, -1):
            if not lines[i].lstrip().startswith(("{", "```")):
                continue
            try:
                return _parse_object("\n".join(lines[i:]), "codex final message")
            except _Failure:
                continue
        raise _Failure("no final message from codex CLI")


def strict_schema(schema):
    """A copy of ``schema`` that OpenAI strict structured outputs accept: every object carries
    ``additionalProperties: false`` and lists all its properties as required. Claude gets the original."""
    if isinstance(schema, list):
        return [strict_schema(x) for x in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: strict_schema(v) if k != "enum" else v for k, v in schema.items()}
    if out.get("type") == "object" or "properties" in out:
        props = out.get("properties") or {}
        out["properties"] = {k: strict_schema(v) for k, v in props.items()}
        out["required"] = list(props.keys())
        out["additionalProperties"] = False
    return out


def configured_codex_model() -> str | None:
    """The `model` in $CODEX_HOME/config.toml (default ~/.codex/config.toml), or None when unset/unreadable."""
    home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    try:
        with open(Path(home) / "config.toml", "rb") as f:
            m = tomllib.load(f).get("model")
    except (OSError, ValueError):
        return None
    return m if isinstance(m, str) and m else None
