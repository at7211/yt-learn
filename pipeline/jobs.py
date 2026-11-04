"""In-memory job state machine + serial auto-build queue for yt-learn."""
from __future__ import annotations

import json
import os
import queue
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pipeline import keys, settings, usage
from pipeline.ids import parse_youtube_id, source_of
from pipeline.schema import validate_lesson

STALE_CAPTURE_SECONDS = 60
IN_PROGRESS = ("queued", "capturing", "captured", "building")


def canonical_url(video_id: str) -> str | None:
    """YouTube watch URL for a YouTube id; None for other sources (e.g. udemy.<id>)."""
    if source_of(video_id) != "youtube":
        return None
    return f"https://www.youtube.com/watch?v={video_id}"


def parse_video_id(s) -> str | None:
    """YouTube-only parser (contract: tests/fixtures/urls.json). Use pipeline.ids.parse_lesson_id for any source."""
    return parse_youtube_id(s)


class IllegalTransition(Exception):
    pass


class BudgetBlocked(Exception):
    """Raised by ``JobStore.add`` when its gate refuses a new attempt; ``info`` is
    ``{"error", "code": "budget", "usage"}`` for the HTTP response."""

    def __init__(self, info: dict):
        super().__init__(info.get("error", "budget"))
        self.info = info


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


class JobStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: dict[str, dict] = {}

    def _set(self, job, state, message=""):
        if state == "error":
            job["failedIn"] = job.get("state")  # which step broke: capturing (extension) or building
        job["state"] = state
        job["message"] = message
        job["updatedAt"] = time.time()

    def _new(self, vid, attempt):
        job = {"videoId": vid, "state": "queued", "attempt": attempt, "message": "", "updatedAt": 0.0,
               "approved": False}
        self._set(job, "queued")
        self._jobs[vid] = job
        return job

    @staticmethod
    def _admit(job, snapshot, warning):
        """Mark a new attempt as approved with the settings snapshot it will build with."""
        job["settings"] = snapshot
        job["approved"] = True
        if warning is None:
            job.pop("warning", None)
        else:
            job["warning"] = warning
        job.pop("usage", None)  # the previous attempt's numbers
        job.pop("costUsd", None)

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
        if job["state"] == "error" and job.get("failedIn"):
            out["failedIn"] = job["failedIn"]
        if job["state"] in ("done", "error"):
            for k in ("usage", "costUsd"):
                if job.get(k) is not None:
                    out[k] = job[k]
        if job.get("warning"):
            out["warning"] = job["warning"]
        snap = job.get("settings")
        if snap:
            out["settings"] = {"provider": snap.get("provider"), "model": snap.get("model")}
        return out

    def get(self, vid):
        with self._lock:
            job = self._jobs.get(vid)
            return dict(job) if job else None

    def add(self, vid, lesson_ok: bool, gate=None, snapshot=None):
        """``gate() -> (blocked | None, warning | None)`` runs under the lock, only when a new attempt
        is about to be created; ``blocked`` raises BudgetBlocked before any state change. ``gate``
        None passes. The gate must not touch this store (the lock is not re-entrant)."""
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
                warning = self._pass(gate)
                job = self._new(vid, 1)
                self._admit(job, snapshot, warning)
                return dict(job)
            st = job["state"]
            stale = st == "capturing" and time.time() - job["updatedAt"] > STALE_CAPTURE_SECONDS
            if stale or st in ("error", "done"):
                warning = self._pass(gate)  # may raise: nothing has changed yet
                if stale:
                    self._set(job, "error", "擷取逾時")
                job.pop("lessonUrl", None)
                job["attempt"] += 1
                self._set(job, "queued")
                self._admit(job, snapshot, warning)
            return dict(job)

    @staticmethod
    def _pass(gate):
        if gate is None:
            return None
        blocked, warning = gate()
        if blocked is not None:
            raise BudgetBlocked(blocked)
        return warning

    def approve(self, vid, snapshot, warning=None):
        with self._lock:
            self._admit(self._need(vid), snapshot, warning)

    def needs_approval(self, vid) -> bool:
        with self._lock:
            job = self._jobs.get(vid)
            return job is not None and not job.get("approved")

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
            job["approved"] = False

    def fail_captured(self, vid, message):
        """captured -> error (an /ingest the budget gate refused)."""
        with self._lock:
            job = self._need(vid)
            if job["state"] != "captured":
                raise IllegalTransition(f"cannot fail_captured from {job['state']}")
            self._set(job, "error", message)
            job["approved"] = False

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

    def set_building(self, vid) -> int:
        with self._lock:
            job = self._need(vid)
            if job["state"] != "captured":
                raise IllegalTransition(f"cannot build from {job['state']}")
            self._set(job, "building")
            return job["attempt"]

    def finish(self, vid, ok, message, lesson_url=None, usage=None, cost_usd=None):
        with self._lock:
            job = self._need(vid)
            if job["state"] != "building":
                raise IllegalTransition(f"cannot finish from {job['state']}")
            if ok:
                self._set(job, "done", message)
                job["lessonUrl"] = lesson_url
            else:
                self._set(job, "error", message)
                job["approved"] = False
            for k, v in (("usage", usage), ("costUsd", cost_usd)):
                if v is None:
                    job.pop(k, None)
                else:
                    job[k] = v


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _kill_group(proc: subprocess.Popen) -> None:
    """SIGKILL the build's whole process group (the build itself plus the claude/codex CLI it spawned)."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        proc.kill()


class BuildQueue:
    def __init__(self, store: JobStore, root, cmd_factory=None, timeout: float = 3600.0, log_dir=None):
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
        self._runs: dict[str, tuple[int, str]] = {}  # vid -> (attempt, run_id) of the build in flight
        self._snapshots: dict[str, dict] = {}  # vid -> settings snapshot of that build
        self.sweep_orphans()

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
                    self._finish(vid, False, self._scrub(f"{type(e).__name__}: {e}"))
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
            run = self._runs.pop(vid, None)
            snap = self._snapshots.pop(vid, None) or {}
        if run is None:  # never got as far as starting a build: no usage to account for
            self.store.finish(vid, ok, message, lesson_url)
            return
        path = self.usage_path(vid, *run)
        used, cost, model_id, _ = self.read_usage(path)
        if ok:  # the lesson's own totals win
            try:
                lesson = json.loads((self.root / "data" / "lessons" / f"{vid}.json").read_text("utf-8"))
            except (OSError, ValueError):
                lesson = None
            if isinstance(lesson, dict) and isinstance(lesson.get("usage"), dict):
                used, cost = lesson["usage"], _num(lesson.get("costUsd"))
                model_id = lesson.get("modelId") if isinstance(lesson.get("modelId"), str) else model_id
        # Terminal transition first: an IllegalTransition here leaves the file for the orphan sweep.
        self.store.finish(vid, ok, message, lesson_url, usage=used, cost_usd=cost)
        # Delete before recording: dying in between loses one row at most, never records it twice.
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        self._record({"videoId": vid, "provider": snap.get("provider"), "model": model_id or snap.get("model"),
                      "usage": used, "costUsd": cost, "state": "done" if ok else "error", "partial": not ok})

    def _record(self, row):
        try:
            usage.append(self.root, row)
        except OSError as e:
            print(f"usage ledger: cannot write row for {row.get('videoId')}: {e}", file=sys.stderr)

    def _scrub(self, text: str) -> str:
        return keys.scrub(text, keys.all_keys(self.root, os.environ))

    def _tail(self, log: Path, n=5):
        try:
            text = log.read_text("utf-8", errors="replace")
        except OSError:
            return ""
        return "\n".join(self._scrub(text).splitlines()[-n:])

    def usage_path(self, vid, attempt, run_id) -> Path:
        return self.log_dir / f"{vid}.{attempt}.{run_id}.usage.json"

    @staticmethod
    def read_usage(path):
        """``(usage, costUsd, modelId, pid)`` from a build's usage file; all None when it is missing
        (a fully cached or early-failing build never writes one) or unreadable."""
        try:
            d = json.loads(Path(path).read_text("utf-8"))
        except (OSError, ValueError):
            return None, None, None, None
        if not isinstance(d, dict):
            return None, None, None, None
        used = d.get("usage") if isinstance(d.get("usage"), dict) else None
        model_id = d.get("modelId") if isinstance(d.get("modelId"), str) else None
        pid = d.get("pid") if type(d.get("pid")) is int else None
        return used, _num(d.get("costUsd")), model_id, pid

    def sweep_orphans(self):
        """Record and delete usage files left by builds that are no longer running (a server killed
        mid-build). A file whose pid is still alive is left alone; any bad file is skipped."""
        with self._lock:
            current = {self.usage_path(v, a, r).name for v, (a, r) in self._runs.items()}
        try:
            files = sorted(self.log_dir.glob("*.usage.json"))
        except OSError:
            return
        for p in files:
            if p.name in current:
                continue
            try:
                vid, attempt, _run_id, _u, _j = p.name.rsplit(".", 4)
                int(attempt)
                d = json.loads(p.read_text("utf-8"))
                if not isinstance(d, dict):
                    raise ValueError("not an object")
                pid = d.get("pid")
                if type(pid) is int:
                    try:
                        os.kill(pid, 0)
                        continue  # still running (a build from before a restart): leave it
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        continue  # exists, owned by someone else
                used, cost, model_id, _ = self.read_usage(p)
                provider = d.get("provider") if isinstance(d.get("provider"), str) else None
                p.unlink()
                self._record({"videoId": vid, "provider": provider, "model": model_id, "usage": used,
                              "costUsd": cost, "state": "orphan", "partial": True})
            except Exception as e:  # never let one bad file keep the server from starting
                print(f"usage sweep: skipped {p.name}: {type(e).__name__}: {e}", file=sys.stderr)

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
        out = {"phase": d["phase"], "done": d["done"], "total": d["total"]}
        with self._lock:
            run = self._runs.get(vid)
        if run is not None:
            used, cost, _, _ = self.read_usage(self.usage_path(vid, *run))
            if used is not None:
                out["usage"] = used
            if cost is not None:
                out["costUsd"] = cost
        return out

    def _clear_progress(self, vid):
        try:
            self.progress_path(vid).unlink(missing_ok=True)
        except OSError:
            pass

    def _run(self, vid):
        self.sweep_orphans()  # usage files of builds that ended after a restart get recorded now
        # The settings snapshot taken at /add time; without one (direct ingest, older flow) take it now,
        # before the job is visible as "building": a POST /settings after this point does not matter.
        job = self.store.get(vid)
        snapshot = job.get("settings") if job else None
        if snapshot:
            warning, saved = snapshot.get("warning"), snapshot.get("saved")
        else:
            models = settings.load_models(self.root)
            saved = settings.load(self.root, models)
            load_warning = saved.pop("warning", None)
            snapshot = settings.resolve(saved, os.environ, models=models)
            warning = load_warning or snapshot.get("warning")
        # A CLI build gets only what the file holds, the rest of the env inherited as before (so env-only
        # values resolve() cannot express, e.g. YTLEARN_MODEL=opus, still reach it); an API build gets the
        # full resolved snapshot. A snapshot without "saved" (older callers) falls back to the full one.
        to_env = saved if snapshot["provider"] not in settings.API_PROVIDERS and saved is not None else snapshot
        self._clear_progress(vid)  # before "building" is visible, so a GET never shows the last run's bar
        attempt = self.store.set_building(vid)
        run_id = uuid.uuid4().hex[:8]
        with self._lock:
            self._runs[vid] = (attempt, run_id)
            self._snapshots[vid] = snapshot
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log = self.log_dir / f"{vid}.log"
        env = settings.apply_to_env(to_env, {**os.environ, "YTLEARN_PROGRESS_FILE": str(self.progress_path(vid))})
        # resolve() may have normalised the provider: the child, key isolation and the ledger must agree on it
        env["YTLEARN_PROVIDER"] = snapshot["provider"]
        env = keys.env_for_build(self.root, env, snapshot["provider"])
        env["YTLEARN_USAGE_FILE"] = str(self.usage_path(vid, attempt, run_id))
        with open(log, "wb") as lf:
            if warning:
                lf.write(f"warning: {warning}\n".encode("utf-8"))
                lf.flush()
            proc = subprocess.Popen(self._cmd(vid), cwd=self.root, stdout=lf, stderr=subprocess.STDOUT, env=env,
                                    start_new_session=True)  # its own process group, so a kill reaches the LLM CLI too
            with self._lock:
                self._proc = proc
            try:
                rc = proc.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                _kill_group(proc)
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
                _kill_group(proc)
        self._q.put(None)
        t = self._thread
        if t is not None:
            t.join(timeout=10)
