"""POST /explain, GET /explain/<key>, GET /notes/<vid> (fake providers only: no LLM, no network)."""
import json
import shutil
import threading
import time
from pathlib import Path

import pytest

import server
from pipeline import explain, keys, llm, settings, usage
from tests.test_explain import UsageFake, good_result
from tests.test_server import req

VID = "puh91fohvTA"
FIXTURE = Path(__file__).parent / "fixtures" / "lesson_min.json"
SETTINGS_ENV = ("YTLEARN_MODEL", "YTLEARN_EFFORT", "YTLEARN_WORKERS", "YTLEARN_PROVIDER", "YTLEARN_BUDGET_USD",
                "ANTHROPIC_API_KEY", "OPENAI_API_KEY")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in SETTINGS_ENV:
        monkeypatch.delenv(k, raising=False)


class Factory:
    """provider_factory stand-in: hands out the queued providers and records each call."""

    def __init__(self, *providers):
        self.providers = list(providers)
        self.calls = []

    def __call__(self, resolved, root, cache_dir):
        self.calls.append((dict(resolved), Path(root), Path(cache_dir)))
        if not self.providers:
            raise AssertionError("provider_factory called more often than expected")
        return self.providers.pop(0)


class Blocking(UsageFake):
    """Waits for ``go`` before answering, so a job stays pending."""

    def __init__(self, responses, go):
        super().__init__(responses)
        self.go = go

    def complete_json(self, system, user, schema=None):
        assert self.go.wait(5)
        return super().complete_json(system, user, schema)


def _serve(tmp_path, factory, lesson=True):
    (tmp_path / "web").mkdir(exist_ok=True)
    (tmp_path / "web" / "index.html").write_text("hi")
    if lesson:
        d = tmp_path / "data" / "lessons"
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(FIXTURE, d / f"{VID}.json")
    srv = server.make_server(tmp_path, 0, provider_factory=factory)
    t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    return srv, t, f"http://127.0.0.1:{srv.server_address[1]}"


@pytest.fixture
def serve(tmp_path):
    started = []

    def start(factory=None):
        srv, t, base = _serve(tmp_path, factory if factory is not None else Factory())
        started.append((srv, t))
        return base
    yield start
    for srv, t in started:
        srv.shutdown()
        srv.server_close()
        t.join()


def post(base, body, headers=None):
    code, raw, _ = req(base + "/explain", json.dumps(body).encode(), "POST", headers)
    return code, json.loads(raw) if raw.startswith(b"{") else raw


def get(base, path, headers=None):
    code, raw, _ = req(base + path, headers=headers)
    return code, json.loads(raw) if raw.startswith(b"{") else raw


def ask(cue=1, a=4, b=7, phrase="wouldn't it be great", **extra):
    return {"videoId": VID, "cue": cue, "a": a, "b": b, "phrase": phrase, **extra}


def poll(base, key, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        code, out = get(base, f"/explain/{key}")
        assert code == 200
        if out["state"] != "pending":
            return out
        time.sleep(0.02)
    raise AssertionError("explain job still pending")


def rows(tmp_path):
    p = usage.path_for(tmp_path)
    return [json.loads(x) for x in p.read_text("utf-8").splitlines()] if p.exists() else []


def test_pending_then_done_by_polling_then_cached(serve, tmp_path):
    fake = UsageFake([good_result()])
    f = Factory(fake)
    base = serve(f)
    code, out = post(base, ask())
    assert code == 202 and out["ok"] is True and out["state"] == "pending" and len(out["key"]) == 16
    done = poll(base, out["key"])
    assert done["state"] == "done" and done["key"] == out["key"]
    note = done["note"]
    assert note["phrase"] == "wouldn't it be great" and (note["cue"], note["a"], note["b"]) == (1, 4, 7)
    assert note["result"]["meaningZh"] == good_result()["meaningZh"]
    _, root, cache_dir = f.calls[0]
    assert cache_dir == (tmp_path / "data" / "cache" / VID / "explain").resolve()
    assert explain.load_notes(tmp_path, VID)["4-7"] == note
    [row] = rows(tmp_path)
    assert row["state"] == "explain" and row["videoId"] == VID and row["provider"] == "claude-cli"
    assert row["model"] == "claude-sonnet-5-5" and row["usage"]["input"] == 1000
    # asking again: the saved note, no provider call, no new usage row
    code, again = post(base, ask())
    assert code == 200 and again == {"ok": True, "state": "done", "key": out["key"], "note": note}
    assert len(f.calls) == 1 and len(rows(tmp_path)) == 1
    code, notes = get(base, f"/notes/{VID}")
    assert code == 200 and notes == {"ok": True, "videoId": VID, "notes": {"4-7": note}}


def test_cached_note_makes_no_provider_call(serve, tmp_path):
    f = Factory()
    base = serve(f)
    les = json.loads(FIXTURE.read_text("utf-8"))
    note = {"phrase": "wouldn't it be great", "cueEn": les["cues"][1]["en"], "cue": 1, "a": 4, "b": 7,
            "result": good_result(), "ts": "2026-11-10T00:00:00+08:00"}
    explain.save_note(tmp_path, VID, note)
    code, out = post(base, ask())
    assert code == 200 and out["state"] == "done" and out["note"] == note
    assert f.calls == [] and rows(tmp_path) == []


def test_stale_note_is_asked_again(serve, tmp_path):
    f = Factory(UsageFake([good_result()]))
    base = serve(f)
    explain.save_note(tmp_path, VID, {"phrase": "wouldn't it be great", "cueEn": "an older build", "cue": 1,
                                      "a": 4, "b": 7, "result": good_result(), "ts": "x"})
    assert get(base, f"/notes/{VID}")[1]["notes"] == {}
    code, out = post(base, ask())
    assert code == 202
    assert poll(base, out["key"])["state"] == "done" and len(f.calls) == 1


def test_same_key_is_deduped_and_busy_after_two(serve, tmp_path):
    go = threading.Event()
    f = Factory(Blocking([good_result()], go), Blocking([good_result()], go))
    base = serve(f)
    try:
        c1, o1 = post(base, ask())
        c2, o2 = post(base, ask())
        assert c1 == c2 == 202 and o1["key"] == o2["key"] and len(f.calls) == 1
        c3, o3 = post(base, ask(cue=2, a=15, b=17, phrase="could just ask"))
        assert c3 == 202 and o3["key"] != o1["key"]
        c4, o4 = post(base, ask(cue=3, a=25, b=26, phrase="Um just"))
        assert c4 == 429 and o4["code"] == "busy" and o4["error"] == "AI 正忙，稍後再試"
        assert len(f.calls) == 2  # the busy one never built a provider
    finally:
        go.set()
    assert poll(base, o1["key"])["state"] == "done" and poll(base, o3["key"])["state"] == "done"
    assert set(explain.load_notes(tmp_path, VID)) == {"4-7", "15-17"}
    assert len(rows(tmp_path)) == 2


def test_budget_over_is_402_and_override_asks(serve, tmp_path):
    keys.save(tmp_path, {"anthropic": "sk-ant-test-00001234"})
    settings.save(tmp_path, dict(settings.DEFAULTS, provider="anthropic-api", budgetUsd=1.0))
    usage.append(tmp_path, {"videoId": "x", "provider": "anthropic-api", "model": "m", "usage": {},
                            "costUsd": 2.0, "state": "done"})
    f = Factory(UsageFake([good_result()]))
    base = serve(f)
    code, out = post(base, ask())
    assert code == 402 and out["ok"] is False and out["code"] == "budget" and "上限" in out["error"]
    assert f.calls == []
    code, out = post(base, ask(override=True))
    assert code == 202 and poll(base, out["key"])["state"] == "done"
    assert rows(tmp_path)[-1]["provider"] == "anthropic-api" and rows(tmp_path)[-1]["state"] == "explain"


def test_phrase_mismatch_is_409(serve):
    f = Factory()
    base = serve(f)
    code, out = post(base, ask(phrase="wouldnt it be great"))
    assert code == 409 and out["code"] == "phrase" and out["phrase"] == "wouldn't it be great"
    assert f.calls == []


@pytest.mark.parametrize("body", [
    ask(cue=1, a=2, b=4, phrase="hello. And wouldn't"),  # crosses into cue 0
    ask(cue=1, a=12, b=14, phrase="to work, I"),          # crosses into cue 2
    ask(cue=0, a=4, b=7),                                  # range is not in that cue
    ask(cue=1, a=7, b=4), ask(cue=99), ask(cue="1"), ask(a=True), ask(b=None),
    ask(phrase=None), [1, 2],
])
def test_bad_ranges_are_400(serve, body):
    f = Factory()
    base = serve(f)
    code, out = post(base, body)
    assert code == 400 and out["ok"] is False and out["error"]
    assert f.calls == []


def test_more_than_30_words_is_400(serve, tmp_path):
    base = serve()
    p = tmp_path / "data" / "lessons" / f"{VID}.json"
    les = json.loads(p.read_text("utf-8"))
    # merge every cue into one so a long span stays inside a single cue
    toks = [t for c in les["cues"] for t in c["tokens"]]
    les["cues"] = [{"a": 0, "b": len(toks) - 1, "tokens": toks, "en": " ".join(toks), "zh": "全部"}]
    les["vocab"] = []
    p.write_text(json.dumps(les))
    code, out = post(base, ask(cue=0, a=0, b=30, phrase=" ".join(toks[:31])))
    assert code == 400 and "30" in out["error"]


@pytest.mark.parametrize("vid", ["../x", "abc", "puh91fohvTA/..", "", None, 5])
def test_bad_video_id_is_400(serve, vid):
    code, out = post(serve(), ask(videoId=vid))
    assert code == 400


def test_unknown_or_broken_lesson_is_404(serve, tmp_path):
    base = serve()
    assert post(base, ask(videoId="aaaaaaaaaaa"))[0] == 404
    (tmp_path / "data" / "lessons" / "bbbbbbbbbbb.json").write_text('{"videoId": "bbbbbbbbbbb"}')
    assert post(base, ask(videoId="bbbbbbbbbbb"))[0] == 404
    assert get(base, "/notes/aaaaaaaaaaa")[0] == 404


def test_get_routes_check_their_ids(serve):
    base = serve()
    assert get(base, "/explain/zz")[0] == 400
    assert get(base, "/explain/0123456789ABCDEF")[0] == 400
    assert get(base, "/explain/0123456789abcdef")[0] == 404
    assert get(base, "/explain/0123456789abcdef/x")[0] == 400
    assert get(base, "/notes/abc")[0] == 400
    assert get(base, "/notes/a/b")[0] == 400
    code, out = get(base, f"/notes/{VID}")
    assert code == 200 and out == {"ok": True, "videoId": VID, "notes": {}}
    import http.client
    host, port = base[len("http://"):].split(":")
    c = http.client.HTTPConnection(host, int(port))
    c.request("GET", "/notes/..%2F..%2Fsettings")  # raw path: unquoted to several segments
    assert c.getresponse().status == 400
    c.close()


def test_youtube_and_foreign_origins_refused(serve):
    f = Factory()
    base = serve(f)
    for origin in ("https://www.youtube.com", "https://evil.example"):
        assert post(base, ask(), {"Origin": origin})[0] == 403
        assert get(base, f"/notes/{VID}", {"Origin": origin})[0] == 403
        assert get(base, "/explain/0123456789abcdef", {"Origin": origin})[0] == 403
    assert f.calls == []
    assert get(base, f"/notes/{VID}", {"Origin": "chrome-extension://abcdef"})[0] == 200
    assert get(base, f"/notes/{VID}", {"Origin": base})[0] == 200


def test_post_needs_json_content_type(serve):
    code, _, _ = req(serve() + "/explain", json.dumps(ask()).encode(), "POST", {"Content-Type": "text/plain"})
    assert code == 415


def test_provider_failure_is_error_state_with_usage_recorded(serve, tmp_path):
    keys.save(tmp_path, {"anthropic": "sk-ant-test-00009999"})
    settings.save(tmp_path, dict(settings.DEFAULTS, provider="anthropic-api"))
    fake = UsageFake([llm.ProviderFatal("API 回 400：bad request for sk-ant-test-00009999", 400)])
    base = serve(Factory(fake))
    code, out = post(base, ask())
    assert code == 202
    res = poll(base, out["key"])
    assert res["state"] == "error" and "API 回 400" in res["error"] and "sk-ant" not in res["error"]
    [row] = rows(tmp_path)
    assert row["state"] == "explain-error" and row["provider"] == "anthropic-api" and row["usage"]["input"] == 1000
    assert explain.load_notes(tmp_path, VID) == {}


def test_missing_cli_names_the_install(serve, tmp_path):
    base = serve(Factory(llm.FakeProvider([llm.ProviderMissing("claude CLI not found on PATH")])))
    code, out = post(base, ask())
    res = poll(base, out["key"])
    assert res["state"] == "error" and "claude" in res["error"] and "API key" in res["error"]
    assert rows(tmp_path) == []  # nothing billed


def test_errored_job_can_be_asked_again(serve, tmp_path):
    f = Factory(UsageFake([llm.ProviderError("flaky")]), UsageFake([good_result()]))
    base = serve(f)
    _, out = post(base, ask())
    assert poll(base, out["key"])["state"] == "error"
    code, out2 = post(base, ask())
    assert code == 202 and out2["key"] == out["key"]
    assert poll(base, out["key"])["state"] == "done"


def test_settings_warning_is_refused(serve, monkeypatch):
    monkeypatch.setattr(server.Handler, "_resolved_and_load_warning",
                        lambda self: (dict(settings.DEFAULTS, warning=settings.INCONSISTENT), None, {}))
    f = Factory()
    code, out = post(serve(f), ask())
    assert code == 400 and settings.INCONSISTENT in out["error"] and f.calls == []


def test_api_provider_without_key_is_400_with_default_factory(tmp_path):
    settings.save(tmp_path, dict(settings.DEFAULTS, provider="anthropic-api"))
    srv, t, base = _serve(tmp_path, None)  # the real make_provider: refuses before building anything
    try:
        code, out = post(base, ask())
        assert code == 400 and "API key" in out["error"]
    finally:
        srv.shutdown()
        srv.server_close()
        t.join()
