import json
import threading
import time
from pathlib import Path

import pytest

from pipeline import jobs
from pipeline.jobs import IllegalTransition, JobStore, canonical_url, parse_video_id

FIX = Path(__file__).parent / "fixtures" / "urls.json"
V = "CR94QQXO_4s"


def test_parse_video_id_table():
    t = json.loads(FIX.read_text("utf-8"))
    assert len(t["accept"]) >= 10 and len(t["reject"]) >= 8
    for inp, vid in t["accept"]:
        assert parse_video_id(inp) == vid, inp
    for inp in t["reject"]:
        assert parse_video_id(inp) is None, inp


def test_canonical_url():
    assert canonical_url(V) == f"https://www.youtube.com/watch?v={V}"


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
    ("queued", "claim"), ("capturing", "fail"), ("capturing", "ingest"), ("captured", "building"),
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
    elif op == "ingest" and state in ("queued", "error"):
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
