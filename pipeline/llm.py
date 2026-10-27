"""LLM provider: wraps the locally logged-in `claude` CLI (no API key)."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Protocol

RETRY_SUFFIX = "\n\n(上一次輸出不是合法 JSON，請只輸出符合 schema 的 JSON。)"


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


class ClaudeCliProvider:
    def __init__(self, model: str | None = None, cache_dir: Path | None = None,
                 prompt_version: int = 1, timeout: float = 180.0):
        self.model = model
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.prompt_version = prompt_version
        self.timeout = timeout
        self.calls = 0
        self.cache_hits = 0

    def _cache_path(self, system: str, user: str, schema: dict | None) -> Path:
        key = hashlib.sha256(json.dumps({
            "model": self.model or "default", "promptVersion": self.prompt_version,
            "system": system, "user": user, "schema": schema,
        }, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        return self.cache_dir / f"{key}.json"

    def _cache_get(self, path: Path) -> dict | None:
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if (isinstance(d, dict) and d.get("model") == (self.model or "default")
                and d.get("promptVersion") == self.prompt_version and isinstance(d.get("response"), dict)):
            return d["response"]
        return None

    def _cache_put(self, path: Path, resp: dict) -> None:
        tmp = None
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps({"model": self.model or "default", "promptVersion": self.prompt_version,
                                       "response": resp}, ensure_ascii=False), encoding="utf-8")
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

    def _call(self, system: str, user: str, schema: dict | None) -> dict:
        argv = ["claude", "-p", "--no-session-persistence", "--output-format", "json"]
        if self.model:
            argv += ["--model", self.model]
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
        text = text.strip()
        m = _FENCE.match(text)
        if m:
            text = m.group(1)
        try:
            val = json.loads(text)
        except ValueError:
            raise _Failure("result is not valid JSON") from None
        if not isinstance(val, dict):
            raise _Failure("result JSON is not an object")
        return val
