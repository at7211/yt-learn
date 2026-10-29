#!/usr/bin/env python3
"""Local dev server for yt-learn (binds 127.0.0.1 only).

- Serves <root>/web as static files (the player UI).
- GET  /data/lessons/<id>.json : generated lessons from <root>/data/lessons.
- GET  /lessons                : lists lesson summaries.
- POST /ingest                 : validates raw captions (see bookmarklet.js) and
                                 writes <root>/data/raw/<videoId>.json.
- GET/POST /settings           : build settings (model, effort, workers) in <root>/data/settings.json.

Request hardening (every route): the Host header must name this server (127.0.0.1 / localhost /
[::1] on our port) so DNS-rebinding pages are refused; a POST must be Content-Type: application/json
(no CORS-"simple" form/text posts); a request carrying an Origin must come from the local UI, from a
Chrome extension (the yt-learn worker's POSTs carry Origin: chrome-extension://<id>), or from
https://www.youtube.com, and that last one only for POST /ingest (the bookmarklet) and preflights.
"""
import json
import os
import sys
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from pipeline import settings
from pipeline.jobs import BuildQueue, IllegalTransition, JobStore, parse_video_id
from pipeline.schema import validate_lesson, validate_raw

ROOT = Path(__file__).resolve().parent
MAX_BODY = 4 * 1024 * 1024  # a 40-min json3 capture is ~150 KB


class Handler(SimpleHTTPRequestHandler):
    root: Path = ROOT
    jobs: JobStore = None
    queue: BuildQueue = None

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
                out.append({"videoId": f.stem, "title": j.get("title"), "channel": j.get("channel"),
                            "duration": j.get("duration"), "vocabCount": len(j.get("vocab", [])),
                            "coveredSeconds": j.get("coveredSeconds")})
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
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] in ("claim", "fail"):
            return self._claim(parts[1]) if parts[2] == "claim" else self._fail(parts[1])
        self.send_error(404)

    def _get_settings(self):
        """The effective settings (saved > env > defaults): what the next build will use."""
        saved = settings.load(self.root)
        out = {"settings": settings.resolve(saved, os.environ)}
        if "warning" in saved:
            out["warning"] = saved["warning"]
        self._json(out)

    def _post_settings(self):
        obj, err = self._read_json()
        if err:
            return
        clean, errs = settings.normalize(obj)
        if errs:
            return self._json({"ok": False, "errors": errs}, 400)
        try:
            saved = settings.save(self.root, clean)
        except OSError as e:
            return self._json({"ok": False, "errors": [f"無法寫入設定檔：{e}"]}, 500)
        self._json({"ok": True, "settings": saved})

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
        vid = parse_video_id(obj.get("url") if isinstance(obj, dict) else None)
        if vid is None:
            return self._json({"ok": False, "errors": ["無法辨識的 YouTube 網址"]}, 400)
        job = self.jobs.add(vid, self._lesson_ok(vid))
        self._json({"job": JobStore.to_public(job)})

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
        if enqueue:
            self.queue.enqueue(vid)
        print(f"[ingest] {vid} {len(obj['events'])} events -> {dest}", flush=True)
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


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def server_close(self):
        self.handler_class.queue.shutdown()
        super().server_close()


def make_server(root, port=8765) -> ThreadingHTTPServer:
    root = Path(root).resolve()
    store = JobStore()
    handler = type("BoundHandler", (Handler,), {"root": root, "jobs": store,
                                                "queue": BuildQueue(store, root)})
    srv = _Server(("127.0.0.1", port), handler)
    srv.handler_class = handler
    return srv


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    print(f"yt-learn server on http://127.0.0.1:{port}  (player: /index.html?v=<videoId>)", flush=True)
    make_server(ROOT, port).serve_forever()
