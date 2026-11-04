#!/usr/bin/env python3
"""Local dev server for yt-learn (binds 127.0.0.1 only).

- Serves <root>/web as static files (the player UI).
- GET  /data/lessons/<id>.json : generated lessons from <root>/data/lessons.
- GET  /lessons                : lists lesson summaries.
- POST /ingest                 : validates raw captions (see bookmarklet.js) and
                                 writes <root>/data/raw/<videoId>.json.
- GET/POST /settings           : build settings (provider, model, effort, workers, budgetUsd) in
                                 <root>/data/settings.json; GET also returns the masked keys and the
                                 cached model lists.
- GET/POST /keys               : masked API keys / save keys to <root>/data/keys.json (never echoed).
- POST /keys/test              : list the vendor's models with a key; on success saves the key and list.
- GET  /usage                  : this month's ledger totals plus the budget state.
- POST /add                    : new build attempts pass the monthly API budget gate (402 code "budget";
                                 "override": true skips it once); a re-/ingest that starts an attempt
                                 without /add passes the same gate.

Request hardening (every route): the Host header must name this server (127.0.0.1 / localhost /
[::1] on our port) so DNS-rebinding pages are refused; a POST must be Content-Type: application/json
(no CORS-"simple" form/text posts); a request carrying an Origin must come from the local UI, from a
Chrome extension (the yt-learn worker's POSTs carry Origin: chrome-extension://<id>), or from
https://www.youtube.com, and that last one only for POST /ingest (the bookmarklet) and preflights.
"""
import json
import math
import os
import sys
import threading
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from pipeline import keys, llm, settings, usage
from pipeline.ids import parse_lesson_id
from pipeline.jobs import BudgetBlocked, BuildQueue, IllegalTransition, JobStore
from pipeline.schema import validate_lesson, validate_raw

ROOT = Path(__file__).resolve().parent
MAX_BODY = 4 * 1024 * 1024  # a 40-min json3 capture is ~150 KB
VENDORS = {"anthropic": "Anthropic", "openai": "OpenAI"}
LIST_MODELS = {"anthropic": llm.AnthropicApiProvider.list_models, "openai": llm.OpenAiApiProvider.list_models}
# keys.json and models.json are read-merge-write files: concurrent /keys and /keys/test saves take turns
_SAVE_LOCK = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    root: Path = ROOT
    jobs: JobStore = None
    queue: BuildQueue = None
    transport = staticmethod(llm.urllib_transport)

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(self.root / "web"), **kw)

    YOUTUBE = "https://www.youtube.com"

    def _allowed_origins(self):
        port = self.server.server_address[1]
        return {self.YOUTUBE, f"http://127.0.0.1:{port}", f"http://localhost:{port}"}

    def _youtube_route_ok(self):
        """youtube.com pages may only preflight and POST /ingest (the bookmarklet)."""
        path = urlsplit(self.path).path
        return self.command == "OPTIONS" or (self.command == "POST" and path == "/ingest")

    def _cors_origin(self):
        """The Origin to echo in Access-Control-Allow-Origin, or None."""
        origin = self.headers.get("Origin")
        if origin not in self._allowed_origins():
            return None
        if origin == self.YOUTUBE and urlsplit(self.path).path != "/ingest":
            return None
        return origin

    def _reject(self):
        """Host / Origin / Content-Type gate. Sends the error and returns True when refused."""
        port = self.server.server_address[1]
        host = self.headers.get("Host")
        if host is None:
            self.send_error(400, "Host header required")
            return True
        if host.lower() not in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}:
            self.send_error(421, "Unexpected Host")
            return True
        origin = self.headers.get("Origin")
        if origin is not None:
            if origin.startswith("chrome-extension://"):
                pass  # the extension's service worker (unpacked ids vary, so no pinning)
            elif origin not in self._allowed_origins():
                self.send_error(403, "Origin not allowed")
                return True
            elif origin == self.YOUTUBE and not self._youtube_route_ok():
                self.send_error(403, "Origin not allowed for this route")
                return True
        if self.command == "POST":
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                self.send_error(415, "Content-Type must be application/json")
                return True
        return False

    def end_headers(self):
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        if self._reject():
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_HEAD(self):
        if self._reject():
            return
        super().do_HEAD()

    def do_GET(self):
        if self._reject():
            return
        path = unquote(urlsplit(self.path).path)
        if path.startswith("/data/"):
            return self._serve_data(path)
        if path == "/lessons":
            return self._json(self._lessons())
        if path == "/settings":
            return self._get_settings()
        if path == "/keys":
            return self._json(keys.public(self.root, os.environ))
        if path == "/usage":
            return self._usage()
        parts = path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "jobs":
            job = self.jobs.get(parts[1])
            if job is None:
                return self._json({"ok": False, "error": "no such job"}, 404)
            pub = JobStore.to_public(job)
            if job["state"] == "building":
                prog = self.queue.progress(parts[1])
                if prog is not None:
                    pub["progress"] = prog
            return self._json({"job": pub})
        super().do_GET()

    def _serve_data(self, path):
        base = (self.root / "data" / "lessons").resolve()
        target = (self.root / path.lstrip("/")).resolve()
        if not target.is_relative_to(base) or target.suffix != ".json" or not target.is_file():
            return self.send_error(404)
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _lessons(self):
        out = []
        for f in sorted((self.root / "data" / "lessons").glob("*.json")):
            try:
                j = json.loads(f.read_text("utf-8"))
                row = {"videoId": f.stem, "title": j.get("title"), "channel": j.get("channel"),
                       "duration": j.get("duration"), "vocabCount": len(j.get("vocab", [])),
                       "coveredSeconds": j.get("coveredSeconds")}
                row.update({k: j[k] for k in ("source", "sourceUrl", "costUsd", "provider") if k in j})  # omitted when absent
                out.append(row)
            except (OSError, ValueError, AttributeError, TypeError):
                out.append({"videoId": f.stem})
        return out

    def _read_json(self):
        """Returns (obj, None) or (None, error-response-sent)."""
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if not 0 < n <= MAX_BODY:
            self._json({"ok": False, "errors": ["missing or oversized body"]}, 400)
            return None, True
        try:
            return json.loads(self.rfile.read(n)), None
        except ValueError as e:
            self._json({"ok": False, "errors": [f"invalid JSON: {e}"]}, 400)
            return None, True

    def do_POST(self):
        if self._reject():
            return
        sp = urlsplit(self.path)
        parts = sp.path.strip("/").split("/")
        if sp.path == "/ingest":
            return self._ingest(parse_qs(sp.query))
        if sp.path == "/add":
            return self._add()
        if sp.path == "/settings":
            return self._post_settings()
        if sp.path == "/keys":
            return self._post_keys()
        if sp.path == "/keys/test":
            return self._test_key()
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] in ("claim", "fail"):
            return self._claim(parts[1]) if parts[2] == "claim" else self._fail(parts[1])
        self.send_error(404)

    def _resolved(self) -> dict:
        """The effective settings a new attempt builds with (may carry a provider/model ``warning``)."""
        return self._resolved_and_load_warning()[0]

    def _resolved_and_load_warning(self):
        """``(resolved, load warning | None, saved)``: resolve() drops the settings-file warning, so it is
        kept apart; ``saved`` is what the file holds (without the warning)."""
        models = settings.load_models(self.root)
        saved = settings.load(self.root, models)
        load_warning = saved.pop("warning", None)
        return settings.resolve(saved, os.environ, models=models), load_warning, saved

    @staticmethod
    def _snapshot(resolved, load_warning, saved):
        """The job's settings snapshot; its ``warning`` is the settings-file warning ``_run`` logs and its
        ``saved`` the file-held settings a CLI build applies (ruling R11). Only called once ``resolved``
        has no inconsistency warning of its own."""
        snap = dict(resolved, saved=dict(saved))
        if load_warning:
            snap["warning"] = load_warning
        return snap

    def _budget(self, resolved=None, totals=None) -> dict:
        """This month's API spend against the budget. ``state`` is "none" for a CLI provider or no budget."""
        resolved = self._resolved() if resolved is None else resolved
        totals = usage.month_totals(self.root) if totals is None else totals
        provider, budget, api = resolved["provider"], resolved.get("budgetUsd"), totals["apiUsd"]
        out = {"provider": provider, "budgetUsd": budget, "apiUsd": api, "pct": 0, "state": "none"}
        if provider in settings.API_PROVIDERS and budget is not None:
            pct = math.floor(api / budget * 100)
            out["pct"] = pct
            out["state"] = "over" if pct >= 100 else "warn" if pct >= 80 else "ok"
        return out

    def _gate(self, override, resolved=None):
        """``(blocked | None, warning | None)`` for a new attempt. Reads files only: it runs under the
        JobStore lock (JobStore.add), so it must never call into the store."""
        totals = usage.month_totals(self.root)
        b = self._budget(resolved, totals)
        if b["state"] == "over" and not override:
            return {"error": f"本月 API 費用已達上限 ${b['budgetUsd']:.2f}（本機估算）", "code": "budget",
                    "usage": totals}, None
        warning = None
        if b["state"] == "warn":
            warning = f"本月 API 費用已用 {b['pct']}%（約 ${b['apiUsd']:.2f}／${b['budgetUsd']:.2f}，本機估算）"
        n = totals.get("unpricedApiRows", 0)
        if n and b["state"] != "none":  # never blocks (spec decision 10): the cap just cannot see them
            warning = _join(warning, f"本月有 {n} 次產課牌價未知，未計入上限")
        return None, warning

    def _usage(self):
        totals = usage.month_totals(self.root)
        b = self._budget(totals=totals)
        self._json({**totals, "budgetUsd": b["budgetUsd"], "budgetState": b["state"], "pct": b["pct"]})

    def _get_settings(self):
        """The effective settings (saved > env > defaults): what the next build will use."""
        models = settings.load_models(self.root)
        saved = settings.load(self.root, models)
        resolved = settings.resolve(saved, os.environ, models=models)
        warnings = [w for w in (saved.get("warning"), resolved.pop("warning", None)) if w]
        out = {"settings": resolved, "keys": keys.public(self.root, os.environ), "models": models}
        if warnings:
            out["warning"] = "；".join(warnings)
        self._json(out)

    def _post_settings(self):
        obj, err = self._read_json()
        if err:
            return
        models = settings.load_models(self.root)
        clean, errs = settings.normalize(obj, models=models)
        if errs:
            return self._json({"ok": False, "errors": errs}, 400)
        vendor = settings.KEY_OF.get(clean["provider"])
        if vendor is not None and keys.resolve(self.root, os.environ)[vendor][0] is None:
            return self._json({"ok": False, "errors": [f"請先貼上 {VENDORS[vendor]} 的 API key"]}, 400)
        try:
            saved = settings.save(self.root, clean, models=models)
        except OSError as e:
            return self._json({"ok": False, "errors": [f"無法寫入設定檔：{e}"]}, 500)
        self._json({"ok": True, "settings": saved})

    def _post_keys(self):
        obj, err = self._read_json()
        if err:
            return
        if not isinstance(obj, dict):
            return self._json({"ok": False, "errors": ["body must be a JSON object"]}, 400)
        errs = [f"unknown key provider {k!r}" for k in obj if k not in VENDORS]
        errs += [f"{k} must be a string" for k in VENDORS if k in obj and not isinstance(obj[k], str)]
        errs += [f"{VENDORS[k]} 的 API key 是空白" for k in VENDORS
                 if isinstance(obj.get(k), str) and obj[k] and not obj[k].strip()]  # "" (explicit) deletes
        if not errs and any(obj[k].strip() and not keys.legal(obj[k].strip()) for k in VENDORS if k in obj):
            errs.append(keys.BAD_CHARS)
        if errs:
            return self._json({"ok": False, "errors": errs}, 400)
        try:
            with _SAVE_LOCK:
                keys.save(self.root, {k: obj[k].strip() for k in VENDORS if k in obj})
        except OSError as e:
            return self._json({"ok": False, "errors": [f"無法寫入 key 檔：{type(e).__name__}"]}, 500)
        self._json({"ok": True, "keys": keys.public(self.root, os.environ)})

    def _test_key(self):
        obj, err = self._read_json()
        if err:
            return
        vendor = obj.get("provider") if isinstance(obj, dict) else None
        if vendor not in VENDORS:
            return self._json({"ok": False, "error": "provider must be anthropic or openai"}, 400)
        pasted = obj.get("key")
        if pasted is not None and not isinstance(pasted, str):
            return self._json({"ok": False, "error": "key must be a string"}, 400)
        pasted = (pasted or "").strip() or None
        if pasted and not keys.legal(pasted):
            return self._json({"ok": False, "error": keys.BAD_CHARS}, 400)
        key = pasted or keys.resolve(self.root, os.environ)[vendor][0]
        if not key:
            return self._json({"ok": False, "error": "請先貼上 API key"}, 400)
        try:
            models = LIST_MODELS[vendor](key, self.transport)
        except (llm.ProviderError, llm.TransportError) as e:
            known = [key, *keys.all_keys(self.root, os.environ)]
            return self._json({"ok": False, "error": keys.scrub(str(e), known)}, 400)
        try:
            with _SAVE_LOCK:
                if pasted:
                    keys.save(self.root, {vendor: pasted})
                settings.save_models(self.root, vendor, models)
        except OSError as e:
            return self._json({"ok": False, "error": f"無法寫入檔案：{type(e).__name__}"}, 500)
        self._json({"ok": True, "models": models, "keys": keys.public(self.root, os.environ)})

    def _lesson_ok(self, vid):
        try:
            lesson = json.loads((self.root / "data" / "lessons" / f"{vid}.json").read_text("utf-8"))
            return (not validate_lesson(lesson)) and lesson["coveredSeconds"] >= lesson["duration"]
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def _add(self):
        obj, err = self._read_json()
        if err:
            return
        vid = parse_lesson_id(obj.get("url") if isinstance(obj, dict) else None)
        if vid is None:
            return self._json({"ok": False, "errors": ["無法辨識的 YouTube、Udemy、Netflix 或 HelloInterview 網址"]}, 400)
        resolved, load_warning, saved = self._resolved_and_load_warning()
        lesson_ok = self._lesson_ok(vid)
        if resolved.get("warning") and not lesson_ok:  # a finished lesson still opens: nothing builds
            return self._json({"ok": False, "errors": [resolved["warning"] + "，請到設定頁重新儲存"]}, 400)
        override = obj.get("override") is True

        def gate():
            blocked, warning = self._gate(override, resolved)
            return blocked, _join(load_warning, warning)
        try:
            job = self.jobs.add(vid, lesson_ok, gate=gate, snapshot=self._snapshot(resolved, load_warning, saved))
        except BudgetBlocked as e:
            return self._json({"ok": False, **e.info}, 402)
        out = {"job": JobStore.to_public(job)}
        if job.get("warning"):
            out["warning"] = job["warning"]
        self._json(out)

    def _claim(self, vid):
        if self.jobs.get(vid) is None:
            return self._json({"ok": False, "error": "no such job"}, 404)
        try:
            self._json({"attempt": self.jobs.claim(vid)})
        except IllegalTransition as e:
            self._json({"ok": False, "error": str(e)}, 409)

    def _fail(self, vid):
        obj, err = self._read_json()
        if err:
            return
        if not isinstance(obj, dict) or type(obj.get("attempt")) is not int:
            return self._json({"ok": False, "errors": ["attempt (int) required"]}, 400)
        if self.jobs.get(vid) is None:
            return self._json({"ok": False, "error": "no such job"}, 404)
        try:
            self.jobs.fail(vid, obj["attempt"], str(obj.get("message", ""))[:500])
        except IllegalTransition as e:
            return self._json({"ok": False, "error": str(e)}, 409)
        self._json({"ok": True})

    def _ingest(self, query):
        obj, err = self._read_json()
        if err:
            return
        errs = validate_raw(obj)
        if errs:
            return self._json({"ok": False, "errors": errs}, 400)
        vid = obj["videoId"]
        attempt = None
        if "attempt" in query:
            try:
                attempt = int(query["attempt"][0])
            except ValueError:
                return self._json({"ok": False, "errors": ["attempt must be an int"]}, 400)
        enqueue = False
        if self.jobs.get(vid) is not None or attempt is not None:
            try:
                enqueue = self.jobs.ingested(vid, attempt)
            except IllegalTransition as e:
                return self._json({"ok": False, "error": str(e)}, 409)
        raw_dir = self.root / "data" / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        dest = raw_dir / f"{vid}.json"
        tmp = dest.with_suffix(f".json.{uuid.uuid4().hex}.tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, dest)
        print(f"[ingest] {vid} {len(obj['events'])} events -> {dest}", flush=True)
        if enqueue and self.jobs.needs_approval(vid):
            # a new attempt that never went through /add (re-ingest after an error): same gate as /add
            resolved, load_warning, saved = self._resolved_and_load_warning()
            refused = None
            if resolved.get("warning"):
                msg = resolved["warning"] + "，請到設定頁重新儲存"
                refused = (400, msg, {"errors": [msg]})
            else:
                blocked, warning = self._gate(False, resolved)
                if blocked is not None:
                    refused = (402, blocked["error"], blocked)
                else:
                    self.jobs.approve(vid, self._snapshot(resolved, load_warning, saved), _join(load_warning, warning))
            if refused is not None:
                code, msg, body = refused
                try:
                    self.jobs.fail_captured(vid, msg)
                except IllegalTransition as e:
                    return self._json({"ok": False, "error": str(e)}, 409)
                return self._json({"ok": False, **body, "job": JobStore.to_public(self.jobs.get(vid))}, code)
        if enqueue:
            self.queue.enqueue(vid)
        out = {"ok": True, "videoId": vid, "events": len(obj["events"]),
               "next": f"python3 -m pipeline.build {vid}"}
        job = self.jobs.get(vid)
        if job is not None:
            out["job"] = JobStore.to_public(job)
        self._json(out)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def _join(*warnings):
    """Non-empty warnings joined with "；", or None."""
    return "；".join(w for w in warnings if w) or None


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def server_close(self):
        self.handler_class.queue.shutdown()
        super().server_close()


def make_server(root, port=8765, transport=None) -> ThreadingHTTPServer:
    """``transport`` replaces the HTTP transport of /keys/test (tests inject a fake)."""
    root = Path(root).resolve()
    store = JobStore()
    attrs = {"root": root, "jobs": store, "queue": BuildQueue(store, root)}  # BuildQueue sweeps orphans
    if transport is not None:
        attrs["transport"] = staticmethod(transport)
    handler = type("BoundHandler", (Handler,), attrs)
    srv = _Server(("127.0.0.1", port), handler)
    srv.handler_class = handler
    return srv


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    print(f"yt-learn server on http://127.0.0.1:{port}  (player: /index.html?v=<videoId>)", flush=True)
    make_server(ROOT, port).serve_forever()
