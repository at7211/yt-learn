"""In-memory job state machine + serial auto-build queue for yt-learn."""
from __future__ import annotations

import json
import os
import queue
import re
import shlex
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from pipeline.schema import validate_lesson

ID_RE = re.compile(r"[A-Za-z0-9_-]{11}")
STALE_CAPTURE_SECONDS = 60
IN_PROGRESS = ("queued", "capturing", "captured", "building")


def canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _ok(s):
    return s if s and ID_RE.fullmatch(s) else None


def parse_video_id(s) -> str | None:
    if not isinstance(s, str):
        return None
    s = s.strip()
    if ID_RE.fullmatch(s):
        return s
    try:
        u = urlsplit(s)
        host = (u.hostname or "").lower()
    except ValueError:
        return None
    if u.scheme not in ("http", "https"):
        return None
    parts = [p for p in u.path.split("/") if p]
    if host in ("youtube.com", "www.youtube.com", "m.youtube.com"):
        if u.path == "/watch":
            v = parse_qs(u.query).get("v")
            return _ok(v[0]) if v else None
        if host != "m.youtube.com" and len(parts) == 2 and parts[0] in ("shorts", "embed"):
            return _ok(parts[1])
    elif host == "youtu.be" and len(parts) == 1:
        return _ok(parts[0])
    return None


class IllegalTransition(Exception):
    pass


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


class JobStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, dict] = {}

    def _set(self, job, state, message=""):
        job["state"] = state
        job["message"] = message
        job["updatedAt"] = time.time()

    def _new(self, vid, attempt):
        job = {"videoId": vid, "state": "queued", "attempt": attempt, "message": "", "updatedAt": 0.0}
        self._set(job, "queued")
        self._jobs[vid] = job
        return job

    def _need(self, vid):
        job = self._jobs.get(vid)
        if job is None:
            raise IllegalTransition(f"no job for {vid}")
        return job

    @staticmethod
    def to_public(job: dict) -> dict:
        out = {k: job[k] for k in ("videoId", "state", "attempt", "message")}
        out["updatedAt"] = _iso(job["updatedAt"])
        if job.get("lessonUrl"):
            out["lessonUrl"] = job["lessonUrl"]
        return out

    def get(self, vid):
        with self._lock:
            job = self._jobs.get(vid)
            return dict(job) if job else None

    def add(self, vid, lesson_ok: bool):
        with self._lock:
            job = self._jobs.get(vid)
            if lesson_ok:
                if job is None:
                    job = self._new(vid, 1)
                if job["state"] in ("captured", "building"):
                    return dict(job)  # build in flight; let it finish
                self._set(job, "done", "完成")
                job["lessonUrl"] = f"index.html?v={vid}"
                return dict(job)
            if job is None:
                return dict(self._new(vid, 1))
            st = job["state"]
            if st == "capturing" and time.time() - job["updatedAt"] > STALE_CAPTURE_SECONDS:
                self._set(job, "error", "擷取逾時")
                st = "error"
            if st in ("error", "done"):
                job.pop("lessonUrl", None)
                job["attempt"] += 1
                self._set(job, "queued")
            return dict(job)

    def claim(self, vid) -> int:
        with self._lock:
            job = self._need(vid)
            if job["state"] != "queued":
                raise IllegalTransition(f"cannot claim from {job['state']}")
            self._set(job, "capturing")
            return job["attempt"]

    def fail(self, vid, attempt, message):
        with self._lock:
            job = self._need(vid)
            if job["state"] != "capturing" or job["attempt"] != attempt:
                raise IllegalTransition(f"cannot fail from {job['state']} attempt {attempt}")
            self._set(job, "error", message)

    def ingested(self, vid, attempt) -> bool:
        with self._lock:
            job = self._jobs.get(vid)
            if job is None:
                if attempt is None:
                    return False
                raise IllegalTransition(f"no job for {vid}")
            st = job["state"]
            if st in ("captured", "building", "done"):
                return False
            if st == "capturing" and attempt is not None and attempt != job["attempt"]:
                raise IllegalTransition(f"stale attempt {attempt}")
            self._set(job, "captured")  # queued / capturing(match or manual, no attempt) / error
            return True

    def set_building(self, vid):
        with self._lock:
            job = self._need(vid)
            if job["state"] != "captured":
                raise IllegalTransition(f"cannot build from {job['state']}")
            self._set(job, "building")

    def finish(self, vid, ok, message, lesson_url=None):
        with self._lock:
            job = self._need(vid)
            if job["state"] != "building":
                raise IllegalTransition(f"cannot finish from {job['state']}")
            if ok:
                self._set(job, "done", message)
                job["lessonUrl"] = lesson_url
            else:
                self._set(job, "error", message)


class BuildQueue:
    def __init__(self, store: JobStore, root, cmd_factory=None, timeout: float = 1200.0, log_dir=None):
        self.store = store
        self.root = Path(root)
        self.cmd_factory = cmd_factory
        self.timeout = timeout
        self.log_dir = Path(log_dir) if log_dir else self.root / "data" / "jobs"
        self._q: queue.Queue = queue.Queue()
        self._pending: set[str] = set()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._proc: subprocess.Popen | None = None

    def _cmd(self, vid):
        if self.cmd_factory:
            return list(self.cmd_factory(vid))
        env = os.environ.get("YTLEARN_BUILD_CMD")
        if env:
            return shlex.split(env) + [vid]
        return [sys.executable, "-m", "pipeline.build", vid]

    def enqueue(self, vid):
        with self._lock:
            if vid in self._pending or self._stop.is_set():
                return
            self._pending.add(vid)
            if self._thread is None:
                self._thread = threading.Thread(target=self._loop, name="build-queue", daemon=True)
                self._thread.start()
        self._q.put(vid)

    def _loop(self):
        while not self._stop.is_set():
            vid = self._q.get()
            if vid is None:
                break
            try:
                self._run(vid)
            except Exception as e:  # worker must survive anything
                try:
                    self._finish(vid, False, f"{type(e).__name__}: {e}")
                except Exception:
                    pass
            finally:
                with self._lock:
                    self._pending.discard(vid)
                    self._proc = None

    def _finish(self, vid, ok, message, lesson_url=None):
        self._clear_progress(vid)
        # Release the dedupe slot BEFORE the terminal transition so a re-ingest
        # (error -> captured) landing right after it can be enqueued.
        with self._lock:
            self._pending.discard(vid)
        self.store.finish(vid, ok, message, lesson_url)

    def _tail(self, log: Path, n=5):
        try:
            lines = log.read_text("utf-8", errors="replace").splitlines()
        except OSError:
            return ""
        return "\n".join(lines[-n:])

    def progress_path(self, vid) -> Path:
        return self.log_dir / f"{vid}.progress.json"

    def progress(self, vid) -> dict | None:
        """The build's latest {phase, done, total}, or None (no file yet, already cleaned up, or unreadable)."""
        try:
            d = json.loads(self.progress_path(vid).read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if not (isinstance(d, dict) and isinstance(d.get("phase"), str)
                and isinstance(d.get("done"), int) and isinstance(d.get("total"), int)):
            return None
        return {"phase": d["phase"], "done": d["done"], "total": d["total"]}

    def _clear_progress(self, vid):
        try:
            self.progress_path(vid).unlink(missing_ok=True)
        except OSError:
            pass

    def _run(self, vid):
        self._clear_progress(vid)  # before "building" is visible, so a GET never shows the last run's bar
        self.store.set_building(vid)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log = self.log_dir / f"{vid}.log"
        env = {**os.environ, "YTLEARN_PROGRESS_FILE": str(self.progress_path(vid))}
        with open(log, "wb") as lf:
            proc = subprocess.Popen(self._cmd(vid), cwd=self.root, stdout=lf, stderr=subprocess.STDOUT, env=env)
            with self._lock:
                self._proc = proc
            try:
                rc = proc.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                return self._finish(vid, False, f"build 逾時 (timeout {self.timeout:g}s)")
        if self._stop.is_set():
            return self._finish(vid, False, "server shutting down")
        if rc != 0:
            return self._finish(vid, False, self._tail(log) or f"build exited with code {rc}")
        lesson = self.root / "data" / "lessons" / f"{vid}.json"
        try:
            errs = validate_lesson(json.loads(lesson.read_text("utf-8")))
        except (OSError, ValueError) as e:
            errs = [f"lesson unreadable: {e}"]
        if errs:
            return self._finish(vid, False, "lesson invalid: " + "; ".join(errs[:3]))
        self._finish(vid, True, "完成", f"index.html?v={vid}")

    def shutdown(self):
        self._stop.set()
        with self._lock:
            proc = self._proc
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
        self._q.put(None)
        t = self._thread
        if t is not None:
            t.join(timeout=10)
