import json
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import server
from tests.test_schema import GOOD

FIX = Path(__file__).parent / "fixtures"
STUB = FIX / "stub_build.py"
V = GOOD["videoId"]
V2 = "abcdefghijk"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("YTLEARN_BUILD_CMD", f"{sys.executable} {STUB}")
    monkeypatch.setenv("STUB_MODE", "ok")
    (tmp_path / "web").mkdir()
    (tmp_path / "pipeline").symlink_to(Path(server.__file__).parent / "pipeline")
    srv = server.make_server(tmp_path, 0)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", tmp_path
    srv.shutdown()
    srv.server_close()
    t.join()


def req(url, body=None, method=None):
    data = json.dumps(body).encode() if body is not None and not isinstance(body, bytes) else body
    r = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"))
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def ytu(vid):
    return f"https://www.youtube.com/watch?v={vid}"


def raw(vid):
    return json.dumps(dict(GOOD, videoId=vid)).encode()


def wait_state(base, vid, states, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        _, j = req(f"{base}/jobs/{vid}")
        if j["job"]["state"] in states:
            return j["job"]
        time.sleep(0.05)
    raise AssertionError(f"timeout; last {j}")


def full_lesson(root, vid=V, covered=None, text=None):
    lesson = json.loads((FIX / "lesson_min.json").read_text("utf-8"))
    lesson["videoId"] = vid
    lesson["coveredSeconds"] = lesson["duration"] if covered is None else covered
    d = root / "data" / "lessons"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{vid}.json").write_text(text if text is not None else json.dumps(lesson), "utf-8")
    return d / f"{vid}.json"


def start_capture(base, vid=V):
    assert req(f"{base}/add", {"url": ytu(vid)})[0] == 200
    code, c = req(f"{base}/jobs/{vid}/claim", b"")
    assert code == 200
    return c["attempt"]


def test_add_bad_url_400(env):
    base, _ = env
    code, j = req(f"{base}/add", {"url": "https://evil.com/x"})
    assert code == 400 and j == {"ok": False, "errors": ["無法辨識的 YouTube 網址"]}
    assert req(f"{base}/add", {"nourl": 1})[0] == 400
    assert req(f"{base}/jobs/{V}")[0] == 404


def test_add_existing_valid_full_lesson_is_done(env):
    base, root = env
    full_lesson(root)
    code, j = req(f"{base}/add", {"url": ytu(V)})
    assert code == 200 and j["job"]["state"] == "done" and j["job"]["lessonUrl"] == f"index.html?v={V}"
    assert req(f"{base}/jobs/{V}")[1]["job"]["state"] == "done"


def test_add_preview_or_invalid_lesson_rebuilds(env):
    base, root = env
    full_lesson(root, V, covered=10)
    assert req(f"{base}/add", {"url": ytu(V)})[1]["job"]["state"] == "queued"
    full_lesson(root, V2, text="{not json")
    assert req(f"{base}/add", {"url": ytu(V2)})[1]["job"]["state"] == "queued"


def test_ingest_with_job_builds_to_done(env):
    base, root = env
    att = start_capture(base)
    code, out = req(f"{base}/ingest?attempt={att}", raw(V))
    assert code == 200 and out["job"]["state"] in ("captured", "building")
    job = wait_state(base, V, {"done", "error"})
    assert job["state"] == "done" and job["lessonUrl"] == f"index.html?v={V}"
    assert (root / "data" / "jobs" / f"{V}.log").exists()


def test_build_failure_sets_error_with_log_tail(env, monkeypatch):
    base, root = env
    old = full_lesson(root, covered=10)
    before = old.read_bytes()
    monkeypatch.setenv("STUB_MODE", "fail")
    att = start_capture(base)
    req(f"{base}/ingest?attempt={att}", raw(V))
    job = wait_state(base, V, {"done", "error"})
    assert job["state"] == "error"
    assert "stub line 6" in job["message"] and "stub line 1" not in job["message"]
    assert old.read_bytes() == before


def test_build_exit0_but_invalid_lesson_is_error(env, monkeypatch):
    base, _ = env
    monkeypatch.setenv("STUB_MODE", "ok_invalid")
    att = start_capture(base)
    req(f"{base}/ingest?attempt={att}", raw(V))
    assert wait_state(base, V, {"done", "error"})["state"] == "error"


def test_two_videos_build_serially(env, monkeypatch):
    base, _ = env
    monkeypatch.setenv("STUB_MODE", "slow")
    a1, a2 = start_capture(base, V), start_capture(base, V2)
    req(f"{base}/ingest?attempt={a1}", raw(V))
    wait_state(base, V, {"building"})
    req(f"{base}/ingest?attempt={a2}", raw(V2))
    assert req(f"{base}/jobs/{V2}")[1]["job"]["state"] == "captured"
    assert wait_state(base, V, {"done", "error"})["state"] == "done"
    assert wait_state(base, V2, {"done", "error"})["state"] == "done"


def test_worker_survives_spawn_failure(env, monkeypatch):
    base, _ = env
    monkeypatch.setenv("YTLEARN_BUILD_CMD", "/nonexistent/prog")
    a1 = start_capture(base, V)
    req(f"{base}/ingest?attempt={a1}", raw(V))
    assert wait_state(base, V, {"done", "error"})["state"] == "error"
    monkeypatch.setenv("YTLEARN_BUILD_CMD", f"{sys.executable} {STUB}")
    a2 = start_capture(base, V2)
    req(f"{base}/ingest?attempt={a2}", raw(V2))
    assert wait_state(base, V2, {"done", "error"})["state"] == "done"


def test_server_responds_during_build(env, monkeypatch):
    base, _ = env
    monkeypatch.setenv("STUB_MODE", "slow")
    att = start_capture(base)
    req(f"{base}/ingest?attempt={att}", raw(V))
    wait_state(base, V, {"building"})
    t0 = time.time()
    code, _ = req(f"{base}/lessons")
    assert code == 200 and time.time() - t0 < 1
    assert wait_state(base, V, {"done", "error"})["state"] == "done"


def test_subprocess_cwd_is_root(env):
    base, root = env
    att = start_capture(base)
    req(f"{base}/ingest?attempt={att}", raw(V))
    wait_state(base, V, {"done", "error"})
    lesson = json.loads((root / "data" / "lessons" / f"{V}.json").read_text("utf-8"))
    assert lesson["channel"] == str(root.resolve())


def test_ingest_stale_attempt_409_and_no_raw_written(env):
    base, root = env
    att = start_capture(base)
    code, out = req(f"{base}/ingest?attempt={att + 1}", raw(V))
    assert code == 409 and out["ok"] is False
    assert not (root / "data" / "raw" / f"{V}.json").exists()
    assert req(f"{base}/jobs/{V}")[1]["job"]["state"] == "capturing"
    assert req(f"{base}/ingest?attempt=1", raw(V2))[0] == 409  # no such job


def test_claim_409_when_not_queued(env):
    base, _ = env
    start_capture(base)
    assert req(f"{base}/jobs/{V}/claim", b"")[0] == 409
    assert req(f"{base}/jobs/{V2}/claim", b"")[0] == 404


def test_fail_requires_matching_attempt(env):
    base, _ = env
    att = start_capture(base)
    assert req(f"{base}/jobs/{V}/fail", {"attempt": att + 1, "message": "x"})[0] == 409
    assert req(f"{base}/jobs/{V2}/fail", {"attempt": 1, "message": "x"})[0] == 404
    assert req(f"{base}/jobs/{V}/fail", {"attempt": att, "message": "no captions"})[0] == 200
    job = req(f"{base}/jobs/{V}")[1]["job"]
    assert job["state"] == "error" and job["message"] == "no captions"


def test_ingest_manual_fallback_while_capturing_builds(env):
    base, root = env
    start_capture(base)  # job now `capturing`, extension "died"
    code, out = req(f"{base}/ingest", raw(V))  # bookmarklet: no attempt
    assert code == 200 and out["job"]["state"] in ("captured", "building")
    assert wait_state(base, V, {"done", "error"})["state"] == "done"
    lesson = root / "data" / "lessons" / f"{V}.json"
    mtime = lesson.stat().st_mtime_ns
    log = root / "data" / "jobs" / f"{V}.log"
    log_mtime = log.stat().st_mtime_ns
    code, out = req(f"{base}/ingest?attempt=1", raw(V))  # late extension ingest
    assert code == 200 and out["job"]["state"] == "done"
    time.sleep(0.5)
    assert lesson.stat().st_mtime_ns == mtime and log.stat().st_mtime_ns == log_mtime
    assert len(list((root / "data" / "jobs").glob("*.log"))) == 1
