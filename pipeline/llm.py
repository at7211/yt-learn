"""LLM providers: the locally logged-in `claude` or `codex` CLI (no API key), or a provider HTTP API
with the user key (stdlib urllib, no redirects, bounded retries, keys scrubbed from every message)."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import random
import re
import subprocess
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Protocol

from pipeline import keys
from pipeline.cost import add_usage, zero_usage

RETRY_SUFFIX = "\n\n(上一次輸出不是合法 JSON，請只輸出符合 schema 的 JSON。)"

EFFORTS = ("low", "medium", "high", "xhigh", "max")  # what `claude --effort` accepts
# Codex's model_reasoning_effort tops out at high: the two higher levels fall back to it.
CODEX_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}


class ProviderError(Exception):
    pass


class ProviderFatal(ProviderError):
    """An error no retry or fallback can fix (bad key, quota, refused redirect, retries exhausted):
    callers that degrade on ProviderError re-raise this one so the build stops."""

    def __init__(self, message, status: int | None = None):
        super().__init__(message)
        self.status = status


class _UsageMixin:
    """Token usage totals with an optional sink. The sink runs inside the lock with a copy of the
    total, so the snapshots it sees are monotonic even with concurrent calls."""

    def _init_usage(self) -> None:
        self.usage = zero_usage()
        self._usage_lock = threading.Lock()
        self.usage_sink: Callable[[dict], None] | None = None

    def record_usage(self, u: dict) -> None:
        with self._usage_lock:
            self.usage = add_usage(self.usage, u)
            if self.usage_sink is not None:
                self.usage_sink(dict(self.usage))


class Provider(Protocol):
    def complete_json(self, system: str, user: str, schema: dict | None = None) -> dict: ...


class FakeProvider(_UsageMixin):
    def __init__(self, responses: list[dict | Exception]):
        self.responses = list(responses)
        self.calls: list[tuple[str, str, dict | None]] = []
        self._init_usage()

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


def _anthropic_usage(u) -> dict:
    """Anthropic-style usage (also the claude CLI's) -> our usage keys; missing or null counts as 0."""
    u = u if isinstance(u, dict) else {}

    def n(k):
        v = u.get(k)
        return v if isinstance(v, int) and not isinstance(v, bool) else 0
    return {"input": n("input_tokens"), "cacheRead": n("cache_read_input_tokens"),
            "cacheWrite": n("cache_creation_input_tokens"), "output": n("output_tokens")}


class _CachedProvider(_UsageMixin):
    """Shared cache + one retry + usage accounting around a call; subclasses implement ``_call``."""
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
        self._init_usage()  # cache hits never call record_usage

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


_CliProvider = _CachedProvider  # old name, kept for existing imports


class ClaudeCliProvider(_CachedProvider):
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
        # No tools, no MCP servers, no user/project settings (hooks, plugins): a bare Q&A call.
        argv += ["--tools", "", "--strict-mcp-config", "--setting-sources", ""]
        try:
            proc = subprocess.run(argv, input=user, capture_output=True, text=True, timeout=self.timeout)
        except FileNotFoundError:
            raise ProviderError("claude CLI not found on PATH") from None
        except subprocess.TimeoutExpired:
            raise _Failure(f"claude CLI timed out after {self.timeout}s") from None
        if proc.returncode != 0:
            raise _Failure(f"claude CLI exit {proc.returncode}: {keys.scrub((proc.stderr or '').strip(), [])[:200]}")
        try:
            outer = json.loads(proc.stdout)
        except ValueError:
            raise _Failure("claude CLI stdout is not JSON") from None
        if not isinstance(outer, dict):
            raise _Failure("claude CLI output is not an object")
        if isinstance(outer.get("usage"), dict):
            self.record_usage(_anthropic_usage(outer["usage"]))
        if outer.get("is_error"):
            raise _Failure(f"claude CLI error: {keys.scrub(str(outer.get('result')), [])[:200]}")
        so = outer.get("structured_output")
        if isinstance(so, dict):
            return so
        text = outer.get("result")
        if not isinstance(text, str):
            raise _Failure("no result in claude CLI output")
        return _parse_object(text, "result")


class CodexCliProvider(_CachedProvider):
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
    ``additionalProperties: false`` and lists all its properties as required. The claude CLI gets the original."""
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


_ANTHROPIC_UNSUPPORTED = frozenset({"maxItems", "minLength", "maxLength", "minimum", "maximum", "multipleOf"})
_SCHEMA_MAPS = frozenset({"properties", "$defs", "definitions"})  # name -> schema maps: names are not keywords
_SCHEMA_LITERALS = frozenset({"enum", "const", "default"})  # values, not schemas


def _strip_anthropic(schema):
    if isinstance(schema, list):
        return [_strip_anthropic(x) for x in schema]
    if not isinstance(schema, dict):
        return schema
    out = {}
    for k, v in schema.items():
        if k in _ANTHROPIC_UNSUPPORTED:
            continue
        if k in _SCHEMA_MAPS and isinstance(v, dict):
            out[k] = {name: _strip_anthropic(sub) for name, sub in v.items()}
        elif k in _SCHEMA_LITERALS:
            out[k] = v
        else:
            out[k] = _strip_anthropic(v)
    mi = out.get("minItems")
    if isinstance(mi, int) and not isinstance(mi, bool) and mi > 1:
        out["minItems"] = 1  # Anthropic accepts only 0 or 1
    return out


def anthropic_schema(schema):
    """A copy of ``schema`` that Anthropic structured outputs accept: ``strict_schema`` plus the
    unsupported numeric/length/array-size keywords removed and ``minItems`` capped at 1."""
    return _strip_anthropic(strict_schema(schema))


class TransportError(Exception):
    """The request never produced an HTTP status (DNS, connect, TLS, timeout, dropped connection)."""


# (method, url, headers, body, timeout) -> (status, lower-cased headers, body bytes)
Transport = Callable[[str, str, dict, "bytes | None", float], "tuple[int, dict, bytes]"]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # never follow: the 3xx comes back as an HTTPError and _request refuses it


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None, timeout: float):
    opener = urllib.request.build_opener(_NoRedirect())  # built per call: no shared handler state
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as e:
        try:
            data = e.read() or b""
        except (OSError, http.client.HTTPException):
            data = b""
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, data
    except urllib.error.URLError as e:
        raise TransportError(str(e.reason)) from None
    except (TimeoutError, OSError, http.client.HTTPException) as e:  # socket.timeout is TimeoutError
        raise TransportError(str(e) or type(e).__name__) from None


def _retry_after(headers: dict) -> float | None:
    try:
        v = float(headers.get("retry-after"))
    except (TypeError, ValueError):
        return None  # absent, or an HTTP date: the plain backoff applies
    return v if v >= 0 else None  # NaN fails the comparison too


def _server_message(raw: bytes) -> str:
    try:
        d = json.loads(raw)
    except ValueError:
        return raw.decode("utf-8", "replace").strip()
    err = d.get("error") if isinstance(d, dict) else None
    if isinstance(err, dict) and isinstance(err.get("message"), str):
        return err["message"]
    if isinstance(err, str):
        return err
    return json.dumps(d, ensure_ascii=False)


class _HttpProvider(_CachedProvider):
    """An HTTP API behind the shared cache/retry layer. HTTP-level trouble is ProviderFatal (it stops
    the build); only content problems (truncated, refused, text not JSON) are _Failure and get the
    one suffix retry in ``complete_json``. Subclasses implement ``_headers`` and ``_call``."""
    RETRY_STATUSES = (408, 429, 500, 502, 503, 529)
    MAX_ATTEMPTS = 4
    RETRY_BUDGET_S = 120
    _sleep = time.sleep  # a builtin, so it does not bind as a method; tests replace it per instance

    def __init__(self, api_key, model=None, cache_dir=None, prompt_version=1, timeout=None, effort=None,
                 transport=urllib_transport):
        super().__init__(model, cache_dir, prompt_version, timeout, effort)
        self.api_key = api_key
        self.transport = transport

    def _headers(self) -> dict:  # pragma: no cover - abstract
        raise NotImplementedError

    def _fatal(self, msg: str, status: int | None) -> ProviderFatal:
        return ProviderFatal(keys.scrub(msg, [self.api_key])[:300], status)

    def _request(self, method: str, url: str, body: dict | None, *, attempts: int | None = None,
                 timeout: float | None = None) -> dict:
        attempts = self.MAX_ATTEMPTS if attempts is None else attempts
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = self._headers()
        t = self.timeout if timeout is None else timeout
        waited = 0.0
        status = None
        detail = ""
        for attempt in range(1, attempts + 1):
            retry_after = None
            try:
                status, hdrs, raw = self.transport(method, url, headers, data, t)
            except TransportError as e:
                status = None
                detail = "連線失敗：" + keys.scrub(str(e), [self.api_key])[:200]
            else:
                if 200 <= status < 300:
                    try:
                        out = json.loads(raw)
                    except ValueError:
                        out = None
                    if not isinstance(out, dict):
                        raise ProviderFatal("API 回應不是 JSON 物件", status)
                    return out
                if status in (401, 403):
                    raise ProviderFatal("API key 無效或沒有權限", status)
                if 300 <= status < 400:
                    raise ProviderFatal("伺服器要求重新導向，已拒絕", status)
                msg = keys.scrub(_server_message(raw or b""), [self.api_key])[:200]
                if status not in self.RETRY_STATUSES:
                    raise self._fatal(f"API 回 {status}：{msg}", status)
                detail = f"API 回 {status}：{msg}"
                retry_after = _retry_after(hdrs or {})
            if attempt >= attempts:
                break
            wait = 2 ** (attempt - 1) + random.uniform(0, 0.5)
            if retry_after is not None:
                wait = max(wait, retry_after)
            if waited + wait > self.RETRY_BUDGET_S:
                raise self._fatal(f"重試等待會超過 {self.RETRY_BUDGET_S} 秒，已放棄（{detail}）", status)
            self._sleep(wait)
            waited += wait
        raise self._fatal(f"重試 {attempts} 次仍失敗（{detail}）", status)


class AnthropicApiProvider(_HttpProvider):
    """Anthropic Messages API with the user key. ``_cache_fields`` is ClaudeCliProvider's unchanged,
    so the CLI and the API share cached answers for the same model, prompt and effort setting."""
    name = "anthropic-api"
    default_timeout = 180.0
    BASE = "https://api.anthropic.com"
    VERSION = "2026-10-21"
    MAX_TOKENS = 16000

    @property
    def effortSent(self):
        return self.effort

    def _headers(self) -> dict:
        return {"x-api-key": self.api_key, "anthropic-version": self.VERSION,
                "content-type": "application/json", "user-agent": "yt-learn"}

    def _call(self, system: str, user: str, schema: dict | None) -> dict:
        # No temperature (400 under 2026-10-21) and no thinking field (the 5.5 models default to adaptive).
        body = {"model": self.model, "max_tokens": self.MAX_TOKENS, "system": system,
                "messages": [{"role": "user", "content": user}]}
        oc = {}
        if schema is not None:
            oc["format"] = {"type": "json_schema", "schema": anthropic_schema(schema)}
        if self.effort:
            oc["effort"] = self.effort
        if oc:
            body["output_config"] = oc
        resp = self._request("POST", self.BASE + "/v1/messages", body)
        self.record_usage(_anthropic_usage(resp.get("usage")))  # billed even when the content is unusable
        stop = resp.get("stop_reason")
        if stop == "max_tokens":
            raise _Failure("回覆被截斷")
        if stop == "refusal":
            raise _Failure("模型拒答")
        for block in resp.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                return _parse_object(block["text"], "回覆文字")
        raise _Failure("回覆沒有文字內容")

    @staticmethod
    def list_models(api_key, transport=urllib_transport) -> list[str]:
        p = AnthropicApiProvider(api_key, transport=transport)
        d = p._request("GET", AnthropicApiProvider.BASE + "/v1/models?limit=1000", None, attempts=1, timeout=20)
        data = d.get("data")
        if not isinstance(data, list):
            return []
        return [m["id"] for m in data
                if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"].startswith("claude-")]


def configured_codex_model() -> str | None:
    """The `model` in $CODEX_HOME/config.toml (default ~/.codex/config.toml), or None when unset/unreadable."""
    home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    try:
        with open(Path(home) / "config.toml", "rb") as f:
            m = tomllib.load(f).get("model")
    except (OSError, ValueError):
        return None
    return m if isinstance(m, str) and m else None
