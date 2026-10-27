#!/usr/bin/env python3
"""Local dev server for yt-learn (binds 127.0.0.1 only).

- Serves <root>/web as static files (the player UI).
- GET  /data/lessons/<id>.json : generated lessons from <root>/data/lessons.
- GET  /lessons                : lists lesson summaries.
- POST /ingest                 : validates raw captions (see bookmarklet.js) and
                                 writes <root>/data/raw/<videoId>.json.
"""
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from pipeline.schema import validate_raw

ROOT = Path(__file__).resolve().parent
MAX_BODY = 20 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    root: Path = ROOT

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(self.root / "web"), **kw)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path.startswith("/data/"):
            return self._serve_data(path)
        if path == "/lessons":
            return self._json(self._lessons())
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

    def do_POST(self):
        if urlsplit(self.path).path != "/ingest":
            return self.send_error(404)
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if not 0 < n <= MAX_BODY:
            return self._json({"ok": False, "errors": ["missing or oversized body"]}, 400)
        try:
            obj = json.loads(self.rfile.read(n))
        except ValueError as e:
            return self._json({"ok": False, "errors": [f"invalid JSON: {e}"]}, 400)
        errs = validate_raw(obj)
        if errs:
            return self._json({"ok": False, "errors": errs}, 400)
        vid = obj["videoId"]
        raw_dir = self.root / "data" / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        dest = raw_dir / f"{vid}.json"
        tmp = dest.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, dest)
        print(f"[ingest] {vid} {len(obj['events'])} events -> {dest}", flush=True)
        self._json({"ok": True, "videoId": vid, "events": len(obj["events"]),
                    "next": f"python3 -m pipeline.build {vid}"})

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def make_server(root, port=8765) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"root": Path(root).resolve()})
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    print(f"yt-learn server on http://127.0.0.1:{port}  (player: /index.html?v=<videoId>)", flush=True)
    make_server(ROOT, port).serve_forever()
