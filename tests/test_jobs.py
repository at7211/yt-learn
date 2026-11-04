import json
import os
import re
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

    def finish(vid, ok, msg, url=None, **kw):
        real(vid, ok, msg, url, **kw)
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


SNAP = dict(provider="anthropic-api", model="claude-sonnet-5-5", effort="default", workers=1, budgetUsd=1.0)


def test_gate_runs_only_when_a_new_attempt_is_created():
    from pipeline.jobs import BudgetBlocked
    calls = []
    gate = lambda: (calls.append(1), (None, "w"))[1]
    s = JobStore()
    j = s.add(V, False, gate=gate, snapshot=SNAP)
    assert calls == [1] and j["settings"] == SNAP and j["approved"] is True and JobStore.to_public(j)["warning"] == "w"
    assert s.add(V, False, gate=gate, snapshot={"provider": "claude-cli"})["settings"] == SNAP and calls == [1]  # queued: no gate, snapshot kept
    assert JobStore().add(V, True, gate=gate) ["state"] == "done" and calls == [1]  # lesson_ok, no job: no gate
    blocked = lambda: ({"error": "over", "code": "budget"}, None)
    s2 = at("error")
    with pytest.raises(BudgetBlocked) as ei:
        s2.add(V, False, gate=blocked, snapshot=SNAP)
    assert ei.value.info["code"] == "budget" and s2.get(V)["state"] == "error" and s2.get(V)["attempt"] == 1


def test_stale_capturing_requeue_also_passes_the_gate():
    from pipeline.jobs import BudgetBlocked
    s = at("capturing")
    s._jobs[V]["updatedAt"] -= jobs.STALE_CAPTURE_SECONDS + 1  # same trick as the existing stale test; never patch time (add holds the lock)
    with pytest.raises(BudgetBlocked):
        s.add(V, False, gate=lambda: ({"error": "over", "code": "budget"}, None), snapshot=SNAP)
    assert s.get(V)["state"] == "capturing" and s.get(V)["attempt"] == 1  # blocked before any state change


def test_error_clears_approval():
    s = JobStore()
    s.add(V, False, gate=lambda: (None, None), snapshot=SNAP)
    assert s.needs_approval(V) is False
    s.claim(V)
    s.fail(V, 1, "x")
    assert s.needs_approval(V) is True
    s.ingested(V, None)  # error -> captured without /add
    assert s.needs_approval(V) is True
    s.approve(V, SNAP)
    assert s.needs_approval(V) is False
    s.set_building(V)
    s.finish(V, False, "boom")
    assert s.needs_approval(V) is True


def test_fail_captured():
    s = at("captured")
    s.fail_captured(V, "本月已達上限")
    assert s.get(V)["state"] == "error" and s.get(V)["message"] == "本月已達上限" and s.get(V)["failedIn"] == "captured"


def _usage_queue(tmp_path, monkeypatch, mode="usage", exit_code="0", **kw):
    stub = Path(__file__).parent / "fixtures" / "stub_build.py"
    (tmp_path / "pipeline").symlink_to(Path(jobs.__file__).parent)
    (tmp_path / "data" / "raw").mkdir(parents=True)
    (tmp_path / "data" / "raw" / f"{V}.json").write_text("{}")
    monkeypatch.setenv("STUB_MODE", mode)
    monkeypatch.setenv("STUB_EXIT", exit_code)
    s = JobStore()
    s.add(V, False, gate=lambda: (None, None), snapshot=SNAP)
    s.claim(V)
    s.ingested(V, 1)
    q = jobs.BuildQueue(s, tmp_path, cmd_factory=lambda v: [sys.executable, str(stub), v], **kw)
    return s, q


def test_ledger_row_written_on_success_and_failure(tmp_path, monkeypatch):
    from pipeline import usage
    s, q = _usage_queue(tmp_path, monkeypatch)
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "done")
        monkeypatch.setenv("STUB_EXIT", "1")
        s.add(V, False, gate=lambda: (None, None), snapshot=SNAP)  # done -> queued: a new attempt (2)
        s.claim(V)
        s.ingested(V, 2)
        q.enqueue(V)
        _wait(lambda: s.get(V)["state"] == "error")
    finally:
        q.shutdown()
    rows = [json.loads(l) for l in usage.path_for(tmp_path).read_text("utf-8").splitlines()]
    assert len(rows) == 2
    assert rows[0]["state"] == "done" and rows[0]["costUsd"] == 0.1 and rows[0]["provider"] == "anthropic-api" and rows[0]["partial"] is False
    assert rows[1]["state"] == "error" and rows[1]["usage"]["input"] == 5 and rows[1]["partial"] is True
    assert s.get(V)["attempt"] == 2 and not list((tmp_path / "data" / "jobs").glob("*.usage.json"))
    pub = JobStore.to_public(s.get(V))
    assert pub["usage"]["input"] == 5 and pub["costUsd"] == 0.1 and pub["settings"] == {"provider": "anthropic-api", "model": "claude-sonnet-5-5"}


def test_usage_survives_kill(tmp_path, monkeypatch):
    from pipeline import usage
    s, q = _usage_queue(tmp_path, monkeypatch, mode="slow_usage", timeout=1.5)
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "error")
    finally:
        q.shutdown()
    lines = usage.path_for(tmp_path).read_text("utf-8").splitlines()
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row["usage"]["input"] == 5 and row["partial"] is True


def test_progress_exposes_usage_from_usage_file(tmp_path, monkeypatch):
    s, q = _usage_queue(tmp_path, monkeypatch, mode="slow_usage", timeout=5)
    q.enqueue(V)
    try:
        _wait(lambda: (q.progress(V) or {}).get("usage"))
        p = q.progress(V)
        assert p["phase"] == "segment" and p["usage"]["input"] == 5 and p["costUsd"] == 0.1
    finally:
        q.shutdown()


def test_orphan_usage_file_is_swept_only_when_its_process_is_gone(tmp_path, monkeypatch):
    import subprocess
    from pipeline import usage
    s, q = _usage_queue(tmp_path, monkeypatch)
    q.shutdown()
    q.log_dir.mkdir(parents=True, exist_ok=True)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        (q.log_dir / f"{V}.7.deadbeef.usage.json").write_text(json.dumps({"usage": {"input": 9, "cacheRead": 0, "cacheWrite": 0, "output": 0}, "costUsd": 0.3, "modelId": "m", "pid": child.pid, "ts": "x"}))
        q2 = jobs.BuildQueue(s, tmp_path)  # restart while the orphan build is still alive: leave it alone
        q2.shutdown()
        assert not usage.path_for(tmp_path).exists() and (q.log_dir / f"{V}.7.deadbeef.usage.json").exists()
    finally:
        child.kill()
        child.wait()
    (q.log_dir / "x.1.badbadba.usage.json").write_text("{not json")  # a corrupt file must never break startup
    q3 = jobs.BuildQueue(s, tmp_path)  # the process is gone now: record once and delete
    q3.shutdown()
    rows = [json.loads(l) for l in usage.path_for(tmp_path).read_text("utf-8").splitlines()]
    assert len(rows) == 1 and rows[0]["videoId"] == V and rows[0]["state"] == "orphan" and rows[0]["partial"] is True and rows[0]["costUsd"] == 0.3 and rows[0]["model"] == "m"
    assert not (q.log_dir / f"{V}.7.deadbeef.usage.json").exists() and (q.log_dir / "x.1.badbadba.usage.json").exists()


def test_run_uses_snapshot_and_injects_only_selected_key(tmp_path, monkeypatch):
    from pipeline import keys, settings as st
    keys.save(tmp_path, {"openai": "sk-openai-xyz7890", "anthropic": "sk-ant-abcdef1234"})
    monkeypatch.setenv("OPENAI_API_KEY", "sk-inherited-00000000")
    dump = tmp_path / "dump.json"
    monkeypatch.setenv("STUB_DUMP", str(dump))
    s, q = _usage_queue(tmp_path, monkeypatch, mode="dump")
    st.save(tmp_path, dict(st.DEFAULTS, provider="claude-cli"))  # changed after /add: must not matter
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "error")
    finally:
        q.shutdown()
    d = json.loads(dump.read_text("utf-8"))
    assert d["env"]["YTLEARN_PROVIDER"] == "anthropic-api" and d["env"]["ANTHROPIC_API_KEY"] == "sk-ant-abcdef1234"
    assert "OPENAI_API_KEY" not in d["env"] and re.fullmatch(rf".*/{re.escape(V)}\.1\.[0-9a-f]{{8}}\.usage\.json", d["env"]["YTLEARN_USAGE_FILE"])
    assert not any("sk-" in a for a in d["argv"])
    assert "sk-ant" not in s.get(V)["message"]  # the dump stub prints the key to stdout; _tail is scrubbed


def test_orphan_from_an_api_build_counts_toward_the_budget(tmp_path):
    from datetime import datetime
    from pipeline import usage
    q = jobs.BuildQueue(JobStore(), tmp_path)
    q.log_dir.mkdir(parents=True, exist_ok=True)
    before = usage.month_totals(tmp_path)["apiUsd"]
    (q.log_dir / f"{V}.3.cafebabe.usage.json").write_text(json.dumps({
        "usage": {"input": 1, "cacheRead": 0, "cacheWrite": 0, "output": 0}, "costUsd": 0.5, "modelId": "m",
        "provider": "anthropic-api", "ts": "x"}))  # no pid: the build is gone
    q.sweep_orphans()
    rows = [json.loads(l) for l in usage.path_for(tmp_path).read_text("utf-8").splitlines()]
    assert len(rows) == 1 and rows[0]["provider"] == "anthropic-api" and rows[0]["state"] == "orphan"
    assert usage.month_totals(tmp_path, datetime.now().astimezone())["apiUsd"] == pytest.approx(before + 0.5)


def test_fallback_snapshot_provider_reaches_child_env_and_ledger(tmp_path, monkeypatch):
    """No snapshot on the job and no settings file: resolve() normalises an unusable env provider, and the
    child, the key isolation and the ledger must all see that same normalised provider."""
    from pipeline import settings as st, usage
    monkeypatch.setenv("YTLEARN_PROVIDER", "openai-api")  # with no OpenAI model resolve falls back
    monkeypatch.delenv("YTLEARN_MODEL", raising=False)
    expected = st.resolve({}, dict(os.environ))["provider"]
    stub = Path(__file__).parent / "fixtures" / "stub_build.py"
    (tmp_path / "pipeline").symlink_to(Path(jobs.__file__).parent)
    (tmp_path / "data" / "raw").mkdir(parents=True)
    (tmp_path / "data" / "raw" / f"{V}.json").write_text("{}")
    dump = tmp_path / "dump.json"
    monkeypatch.setenv("STUB_DUMP", str(dump))
    monkeypatch.setenv("STUB_MODE", "dump")
    s = JobStore()
    s.add(V, False)  # no gate, no snapshot
    s.claim(V)
    s.ingested(V, 1)
    q = jobs.BuildQueue(s, tmp_path, cmd_factory=lambda v: [sys.executable, str(stub), v])
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "error")
    finally:
        q.shutdown()
    assert expected == "claude-cli"
    assert json.loads(dump.read_text("utf-8"))["env"]["YTLEARN_PROVIDER"] == expected
    rows = [json.loads(l) for l in usage.path_for(tmp_path).read_text("utf-8").splitlines()]
    assert len(rows) == 1 and rows[0]["provider"] == expected


def _fallback_child_env(tmp_path, monkeypatch):
    """A job with no snapshot (the fallback in _run), built by the dump stub; returns the child env."""
    stub = Path(__file__).parent / "fixtures" / "stub_build.py"
    (tmp_path / "pipeline").symlink_to(Path(jobs.__file__).parent)
    (tmp_path / "data" / "raw").mkdir(parents=True, exist_ok=True)
    (tmp_path / "data" / "raw" / f"{V}.json").write_text("{}")
    dump = tmp_path / "dump.json"
    monkeypatch.setenv("STUB_DUMP", str(dump))
    monkeypatch.setenv("STUB_MODE", "dump")
    s = JobStore()
    s.add(V, False)
    s.claim(V)
    s.ingested(V, 1)
    q = jobs.BuildQueue(s, tmp_path, cmd_factory=lambda v: [sys.executable, str(stub), v])
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "error")
    finally:
        q.shutdown()
    return json.loads(dump.read_text("utf-8"))["env"]


def test_fallback_cli_build_keeps_env_only_settings(tmp_path, monkeypatch):
    monkeypatch.delenv("YTLEARN_PROVIDER", raising=False)
    monkeypatch.setenv("YTLEARN_MODEL", "opus")
    monkeypatch.setenv("YTLEARN_WORKERS", "12")
    e = _fallback_child_env(tmp_path, monkeypatch)
    assert e["YTLEARN_MODEL"] == "opus" and e["YTLEARN_WORKERS"] == "12" and e["YTLEARN_PROVIDER"] == "claude-cli"


def test_fallback_api_build_gets_the_resolved_snapshot(tmp_path, monkeypatch):
    from pipeline import keys, settings as st
    keys.save(tmp_path, {"openai": "sk-openai-xyz7890"})
    st.save_models(tmp_path, "openai", ["gpt-6-astra"])
    (tmp_path / "data" / "settings.json").write_text(json.dumps({"provider": "openai-api", "model": "gpt-6-astra"}))
    monkeypatch.delenv("YTLEARN_PROVIDER", raising=False)
    monkeypatch.setenv("YTLEARN_WORKERS", "12")  # inexpressible: the API build uses the resolved 4
    e = _fallback_child_env(tmp_path, monkeypatch)
    assert e["YTLEARN_PROVIDER"] == "openai-api" and e["YTLEARN_MODEL"] == "gpt-6-astra" and e["YTLEARN_WORKERS"] == "4"


def test_usage_file_that_cannot_be_deleted_is_left_for_the_sweep(tmp_path, monkeypatch):
    """m-3: recording a row whose file stays behind would let the next sweep record it a second time."""
    from pipeline import usage
    real_unlink = Path.unlink

    def unlink(self, *a, **kw):
        if self.name.endswith(".usage.json"):
            raise PermissionError("read-only")
        return real_unlink(self, *a, **kw)
    s, q = _usage_queue(tmp_path, monkeypatch)
    monkeypatch.setattr(Path, "unlink", unlink)
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "done")
        time.sleep(0.2)
    finally:
        q.shutdown()
    assert not usage.path_for(tmp_path).exists()
    assert len(list(q.log_dir.glob("*.usage.json"))) == 1
    monkeypatch.setattr(Path, "unlink", real_unlink)
    q.sweep_orphans()  # the stub's pid is gone: recorded exactly once now
    rows = usage.path_for(tmp_path).read_text("utf-8").splitlines()
    assert len(rows) == 1 and json.loads(rows[0])["state"] == "orphan"
