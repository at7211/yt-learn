import json
import sys
import threading
import time
from pathlib import Path

import pytest

from pipeline import jobs
from pipeline.jobs import IllegalTransition, JobStore, canonical_url, parse_video_id

FIX = Path(__file__).parent / "fixtures" / "urls.json"
V = "puh91fohvTA"


def test_parse_video_id_table():
    t = json.loads(FIX.read_text("utf-8"))
    assert len(t["accept"]) >= 10 and len(t["reject"]) >= 8
    for inp, vid in t["accept"]:
        assert parse_video_id(inp) == vid, inp
    for inp in t["reject"]:
        assert parse_video_id(inp) is None, inp


def test_canonical_url():
    assert canonical_url(V) == f"https://www.youtube.com/watch?v={V}"


def test_parse_video_id_stays_youtube_only():
    for inp in ("udemy.5800738", "https://www.udemy.com/course/x/learn/lecture/5800738", "udemy.abc"):
        assert parse_video_id(inp) is None, inp
    assert parse_video_id("udemy-12345") == "udemy-12345"  # 11 chars: a YouTube id


def test_canonical_url_none_for_udemy():
    assert canonical_url("udemy.5800738") is None
    assert canonical_url("udemy-12345") == "https://www.youtube.com/watch?v=udemy-12345"


def at(state, attempt=1):
    """Store with job V driven into `state` via legal transitions."""
    s = JobStore()
    s.add(V, False)
    if state == "queued":
        return s
    s.claim(V)
    if state == "capturing":
        return s
    if state == "error":
        s.fail(V, 1, "x")
        return s
    s.ingested(V, 1)
    if state == "captured":
        return s
    s.set_building(V)
    if state == "building":
        return s
    s.finish(V, True, "ok", "u")
    return s


OPS = {
    "claim": lambda s: s.claim(V),
    "fail": lambda s: s.fail(V, 1, "m"),
    "ingest": lambda s: s.ingested(V, 1),
    "building": lambda s: s.set_building(V),
    "finish": lambda s: s.finish(V, True, "ok", "u"),
}
LEGAL = {
    ("queued", "claim"), ("capturing", "fail"), ("captured", "building"),
    ("building", "finish"),
}


@pytest.mark.parametrize("state", ["queued", "capturing", "captured", "building", "done", "error"])
@pytest.mark.parametrize("op", list(OPS))
def test_transitions_legal_and_illegal(state, op):
    s = at(state)
    if (state, op) in LEGAL:
        OPS[op](s)
    elif op == "ingest" and state in ("captured", "building", "done"):
        assert OPS[op](s) is False and s.get(V)["state"] == state
    elif op == "ingest" and state in ("queued", "error", "capturing"):
        assert OPS[op](s) is True and s.get(V)["state"] == "captured"
    else:
        before = s.get(V)
        with pytest.raises(IllegalTransition):
            OPS[op](s)
        assert s.get(V) == before


def test_add_creates_queued():
    s = JobStore()
    j = s.add(V, False)
    assert (j["state"], j["attempt"], j["videoId"]) == ("queued", 1, V)
    assert s.get("nope") is None


def test_add_lesson_ok_is_done():
    j = JobStore().add(V, True)
    assert j["state"] == "done" and j["lessonUrl"] == f"index.html?v={V}"
    pub = JobStore.to_public(j)
    assert {"videoId", "state", "attempt", "message", "updatedAt", "lessonUrl"} <= set(pub)


@pytest.mark.parametrize("state", ["queued", "capturing", "captured", "building"])
def test_add_in_progress_returns_same_job(state):
    s = at(state)
    before = s.get(V)
    assert s.add(V, False) == before


def test_add_error_job_requeues_with_new_attempt():
    s = at("error")
    j = s.add(V, False)
    assert j["state"] == "queued" and j["attempt"] == 2


def test_add_stale_capturing_requeues():
    s = at("capturing")
    s._jobs[V]["updatedAt"] -= jobs.STALE_CAPTURE_SECONDS + 1
    j = s.add(V, False)
    assert j["state"] == "queued" and j["attempt"] == 2


def test_claim_atomic_once():
    for _ in range(20):
        s = at("queued")
        res, bar = [], threading.Barrier(2)

        def go():
            bar.wait()
            try:
                res.append(s.claim(V))
            except IllegalTransition:
                res.append(None)

        ts = [threading.Thread(target=go) for _ in range(2)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        assert sorted(res, key=lambda x: x is None) == [1, None]


def test_stale_attempt_rejected():
    s = at("capturing")
    s.fail(V, 1, "boom")
    assert s.add(V, False)["attempt"] == 2
    assert s.claim(V) == 2
    with pytest.raises(IllegalTransition):
        s.ingested(V, 1)
    with pytest.raises(IllegalTransition):
        s.fail(V, 1, "late")
    assert s.get(V)["state"] == "capturing"


def test_ingest_without_claim_from_manual_fallback():
    s = at("queued")
    assert s.ingested(V, None) is True
    assert s.get(V)["state"] == "captured"


def test_ingest_attempt_given_but_job_missing():
    with pytest.raises(IllegalTransition):
        JobStore().ingested(V, 1)


@pytest.mark.parametrize("state", ["captured", "building", "done"])
def test_ingest_idempotent_in_captured_building_done(state):
    s = at(state)
    before = s.get(V)
    assert s.ingested(V, None) is False
    assert s.ingested(V, 1) is False
    assert s.get(V) == before


def test_ingest_without_attempt_on_capturing_is_manual_fallback():
    s = at("capturing")
    assert s.ingested(V, None) is True
    assert s.get(V)["state"] == "captured"
    # a late extension ingest with the (matching) attempt is idempotent
    assert s.ingested(V, 1) is False


def test_requeue_after_error_is_not_dropped(tmp_path, monkeypatch):
    stub = Path(__file__).parent / "fixtures" / "stub_build.py"
    (tmp_path / "pipeline").symlink_to(Path(jobs.__file__).parent)
    (tmp_path / "data" / "raw").mkdir(parents=True)
    (tmp_path / "data" / "raw" / f"{V}.json").write_text("{}")
    monkeypatch.setenv("STUB_MODE", "fail")
    s = JobStore()
    q = jobs.BuildQueue(s, tmp_path, cmd_factory=lambda v: [sys.executable, str(stub), v])
    real, fired = s.finish, []

    def finish(vid, ok, msg, url=None):
        real(vid, ok, msg, url)
        if not ok and not fired:
            fired.append(1)
            monkeypatch.setenv("STUB_MODE", "ok")
            assert s.ingested(vid, None) is True  # manual re-ingest right after error
            q.enqueue(vid)

    s.finish = finish
    s.add(V, False)
    s.claim(V)
    s.ingested(V, 1)
    q.enqueue(V)
    try:
        end = time.time() + 10
        while time.time() < end and s.get(V)["state"] != "done":
            time.sleep(0.05)
        assert s.get(V)["state"] == "done"
    finally:
        q.shutdown()


def _slow_queue(tmp_path, monkeypatch, **kw):
    stub = Path(__file__).parent / "fixtures" / "stub_build.py"
    (tmp_path / "pipeline").symlink_to(Path(jobs.__file__).parent)
    (tmp_path / "data" / "raw").mkdir(parents=True)
    (tmp_path / "data" / "raw" / f"{V}.json").write_text("{}")
    monkeypatch.setenv("STUB_MODE", "slow")
    s = JobStore()
    s.add(V, False)
    s.claim(V)
    s.ingested(V, 1)
    spawned = []
    orig = jobs.subprocess.Popen

    def popen(*a, **k):
        p = orig(*a, **k)
        spawned.append(p)
        return p

    monkeypatch.setattr(jobs.subprocess, "Popen", popen)
    q = jobs.BuildQueue(s, tmp_path, cmd_factory=lambda v: [sys.executable, str(stub), v], **kw)
    return s, q, spawned


def _wait(pred, timeout=10):
    end = time.time() + timeout
    while time.time() < end and not pred():
        time.sleep(0.05)
    assert pred()


def test_build_timeout_kills_child_and_errors(tmp_path, monkeypatch):
    s, q, spawned = _slow_queue(tmp_path, monkeypatch, timeout=0.5)
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "error")
        assert "逾時" in s.get(V)["message"] or "timeout" in s.get(V)["message"]
        assert spawned[0].poll() is not None
    finally:
        q.shutdown()


def test_shutdown_terminates_running_child(tmp_path, monkeypatch):
    s, q, spawned = _slow_queue(tmp_path, monkeypatch)
    q.enqueue(V)
    _wait(lambda: s.get(V)["state"] == "building" and spawned)
    t0 = time.time()
    q.shutdown()
    assert time.time() - t0 < 3
    assert spawned[0].poll() is not None
    # documented behaviour: the interrupted job is set to error ("server shutting down")
    assert s.get(V)["state"] == "error"


def test_log_tail_tolerates_binary_and_empty(tmp_path):
    q = jobs.BuildQueue(JobStore(), tmp_path)
    f = tmp_path / "x.log"
    f.write_bytes(b"\xff\xfe\nline2\n")
    assert "line2" in q._tail(f)
    f.write_bytes(b"")
    assert q._tail(f) == ""
    assert q._tail(tmp_path / "missing.log") == ""


def test_progress_file_is_read_while_building_and_removed_after(tmp_path, monkeypatch):
    s, q, spawned = _slow_queue(tmp_path, monkeypatch)
    assert q.progress(V) is None  # no file yet
    q.progress_path(V).parent.mkdir(parents=True, exist_ok=True)
    q.progress_path(V).write_text("stale", "utf-8")  # leftover from an earlier run: unreadable -> None
    assert q.progress(V) is None
    q.progress_path(V).write_text(json.dumps({"phase": "vocab", "done": 9, "total": 12}), "utf-8")
    assert q.progress(V) == {"phase": "vocab", "done": 9, "total": 12}
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "building" and q.progress(V) == {"phase": "segment", "done": 1, "total": 4})
        _wait(lambda: s.get(V)["state"] == "done")
        assert q.progress(V) is None and not q.progress_path(V).exists()
    finally:
        q.shutdown()


def test_error_reports_the_step_it_failed_in():
    s = JobStore()
    s.add(V, False)
    att = s.claim(V)
    s.fail(V, att, "no captions")
    pub = JobStore.to_public(s.get(V))
    assert pub["state"] == "error" and pub["failedIn"] == "capturing"
    s2 = JobStore()
    s2.add(V, False)
    s2.claim(V)
    s2.ingested(V, 1)
    s2.set_building(V)
    s2.finish(V, False, "boom")
    assert JobStore.to_public(s2.get(V))["failedIn"] == "building"
    assert "failedIn" not in JobStore.to_public(JobStore()._new(V, 1))
