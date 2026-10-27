#!/usr/bin/env python3
"""Local dev server for yt-learn.

- Serves ./web as static files (the player UI) and ./data (generated lessons).
- POST /ingest  : receives the raw transcript JSON captured from a YouTube tab
                  (see bookmarklet.js) and writes data/raw/<videoId>.json.
- GET  /lessons : lists available lesson JSON files.
"""
import json, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8765"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(ROOT, "web"), **kw)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def end_headers(self):
        self._cors()
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204); self.end_headers()

    def do_GET(self):
        if self.path.startswith("/data/"):
            # serve generated lessons from ./data
            path = os.path.normpath(os.path.join(ROOT, self.path.lstrip("/")))
            if not path.startswith(os.path.join(ROOT, "data")) or not os.path.isfile(path):
                self.send_error(404); return
            body = open(path, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body); return
        if self.path == "/lessons":
            d = os.path.join(ROOT, "data", "lessons")
            ids = sorted(f[:-5] for f in os.listdir(d)) if os.path.isdir(d) else []
            out = []
            for vid in ids:
                try:
                    j = json.load(open(os.path.join(d, vid + ".json")))
                    out.append({"videoId": vid, "title": j.get("title"), "channel": j.get("channel"),
                                "duration": j.get("duration"), "vocabCount": len(j.get("vocab", []))})
                except Exception:
                    out.append({"videoId": vid})
            self._json(out); return
        super().do_GET()

    def do_POST(self):
        if self.path != "/ingest":
            self.send_error(404); return
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n)
        try:
            j = json.loads(raw)
            vid = j["videoId"]
            assert vid.replace("-", "").replace("_", "").isalnum() and len(vid) == 11
            assert isinstance(j["words"], list) and j["words"]
        except Exception as e:
            self._json({"ok": False, "error": f"bad payload: {e}"}, 400); return
        os.makedirs(os.path.join(ROOT, "data", "raw"), exist_ok=True)
        path = os.path.join(ROOT, "data", "raw", vid + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(j, f, ensure_ascii=False)
        print(f"[ingest] {vid} {len(j['words'])} words -> {path}", flush=True)
        self._json({"ok": True, "videoId": vid, "words": len(j["words"]), "path": path})

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    print(f"yt-learn server on http://127.0.0.1:{PORT}  (player: /index.html?v=<videoId>)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
