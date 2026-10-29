import json
import threading
import urllib.error
import urllib.request

import pytest

import server
from pipeline import jobs, settings
from tests.test_schema import GOOD


@pytest.fixture
def base(tmp_path):
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("hi")
    srv = server.make_server(tmp_path, 0)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()
    t.join()


def req(url, data=None, method=None, headers=None):
    headers = dict(headers or {})
    if data is not None:  # like the real clients: JSON bodies say so (the server requires it)
        headers.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def test_ingest_writes_raw_file(base, tmp_path):
    code, body, h = req(base + "/ingest", json.dumps(GOOD).encode(), "POST")
    assert code == 200
    out = json.loads(body)
    assert out == {"ok": True, "videoId": "puh91fohvTA", "events": 2,
                   "next": "python3 -m pipeline.build puh91fohvTA"}
    saved = json.loads((tmp_path / "data" / "raw" / "puh91fohvTA.json").read_text("utf-8"))
    assert saved == GOOD
    assert "Access-Control-Allow-Origin" not in h  # no Origin header sent


def test_ingest_400_lists_errors(base, tmp_path):
    bad = dict(GOOD, videoId="../x")
    code, body, _ = req(base + "/ingest", json.dumps(bad).encode(), "POST")
    assert code == 400
    out = json.loads(body)
    assert out["ok"] is False and out["errors"]
    code, body, _ = req(base + "/ingest", b"not json", "POST")
    assert code == 400 and json.loads(body)["errors"]
    assert not (tmp_path / "data").exists()


def test_options_preflight_headers(base):
    code, _, h = req(base + "/ingest", method="OPTIONS", headers={"Origin": "https://www.youtube.com"})
    assert code == 204
    assert h["Access-Control-Allow-Origin"] == "https://www.youtube.com"
    assert h["Vary"] == "Origin"
    assert h["Access-Control-Allow-Private-Network"] == "true"
    assert "Content-Type" in h["Access-Control-Allow-Headers"]


def test_cors_omitted_for_other_origin(base):
    code, _, h = req(base + "/ingest", method="OPTIONS", headers={"Origin": "https://evil.example"})
    assert code == 403  # foreign origins are refused outright
    assert "Access-Control-Allow-Origin" not in h
    assert h["Vary"] == "Origin" and h["Access-Control-Allow-Private-Network"] == "true"
    _, _, h = req(base + "/ingest", method="OPTIONS", headers={"Origin": base})
    assert h["Access-Control-Allow-Origin"] == base
    # youtube.com may preflight, but only /ingest gets the CORS grant
    code, _, h = req(base + "/settings", method="OPTIONS", headers={"Origin": "https://www.youtube.com"})
    assert code == 204 and "Access-Control-Allow-Origin" not in h


def test_data_path_traversal_sibling_blocked(base, tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data-backup").mkdir()
    (tmp_path / "data-backup" / "x.json").write_text("{}")
    import http.client
    host, port = base[len("http://"):].split(":")
    c = http.client.HTTPConnection(host, int(port))
    c.request("GET", "/data/../data-backup/x.json")  # raw path, no client-side normalisation
    assert c.getresponse().status == 404
    c.close()


def test_data_lessons_served(base, tmp_path):
    d = tmp_path / "data" / "lessons"
    d.mkdir(parents=True)
    (d / "abc.json").write_text('{"a":1}')
    code, body, h = req(base + "/data/lessons/abc.json")
    assert code == 200 and json.loads(body) == {"a": 1}
    assert req(base + "/data/lessons/nope.json")[0] == 404


def test_lessons_lists_root_dir_only(base, tmp_path):
    d = tmp_path / "data" / "lessons"
    (d / "sub").mkdir(parents=True)
    (d / "puh91fohvTA.json").write_text(json.dumps(
        {"title": "T", "channel": "C", "duration": 1378, "vocab": [1, 2, 3], "coveredSeconds": 120}))
    (d / "sub" / "z.json").write_text("{}")
    code, body, _ = req(base + "/lessons")
    assert code == 200
    assert json.loads(body) == [{"videoId": "puh91fohvTA", "title": "T", "channel": "C",
                                 "duration": 1378, "vocabCount": 3, "coveredSeconds": 120}]


def test_lessons_empty_when_no_dir(base):
    assert json.loads(req(base + "/lessons")[1]) == []


def test_static_web_served(base):
    code, body, _ = req(base + "/")
    assert code == 200 and body == b"hi"


# ---------------------------------------------------------------- settings

SETTINGS_ENV = ("YTLEARN_MODEL", "YTLEARN_EFFORT", "YTLEARN_WORKERS")


@pytest.fixture
def clean_env(monkeypatch):
    for k in SETTINGS_ENV:
        monkeypatch.delenv(k, raising=False)


def test_settings_get_defaults_when_no_file(base, tmp_path, clean_env):
    code, body, _ = req(base + "/settings")
    assert code == 200
    assert json.loads(body) == {"settings": {"model": "claude-sonnet-5-5", "effort": "default", "workers": 4}}
    assert not (tmp_path / "data" / "settings.json").exists()


def test_settings_get_reflects_env_then_saved(base, tmp_path, clean_env, monkeypatch):
    monkeypatch.setenv("YTLEARN_EFFORT", "low")
    monkeypatch.setenv("YTLEARN_WORKERS", "2")
    assert json.loads(req(base + "/settings")[1])["settings"]["effort"] == "low"
    s = {"model": "claude-opus-5-5", "effort": "high", "workers": 3}
    code, body, _ = req(base + "/settings", json.dumps(s).encode(), "POST")
    assert code == 200 and json.loads(body) == {"ok": True, "settings": s}
    assert json.loads((tmp_path / "data" / "settings.json").read_text("utf-8")) == s
    assert json.loads(req(base + "/settings")[1]) == {"settings": s}


@pytest.mark.parametrize("body", [
    b"[1, 2]",
    b'"x"',
    json.dumps({"model": "gpt-4", "effort": "default", "workers": 4}).encode(),
    json.dumps({"model": "claude-sonnet-5-5", "effort": "huge", "workers": 4}).encode(),
    json.dumps({"model": "claude-sonnet-5-5", "effort": "default", "workers": True}).encode(),
    json.dumps({"model": "claude-sonnet-5-5", "effort": "default", "workers": 2.5}).encode(),
    json.dumps({"model": "claude-sonnet-5-5", "effort": "default", "workers": 9}).encode(),
    b"not json",
])
def test_settings_post_invalid_400_and_no_write(base, tmp_path, body):
    code, out, _ = req(base + "/settings", body, "POST")
    assert code == 400
    j = json.loads(out)
    assert j["ok"] is False and j["errors"]
    assert not (tmp_path / "data" / "settings.json").exists()


def test_settings_post_invalid_keeps_existing_file(base, tmp_path):
    good = {"model": "claude-haiku-5-5", "effort": "low", "workers": 8}
    assert req(base + "/settings", json.dumps(good).encode(), "POST")[0] == 200
    bad = dict(good, effort="huge")
    assert req(base + "/settings", json.dumps(bad).encode(), "POST")[0] == 400
    assert json.loads((tmp_path / "data" / "settings.json").read_text("utf-8")) == good


def test_settings_get_broken_file_warns(base, tmp_path, clean_env):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "settings.json").write_text("{oops", "utf-8")
    code, body, _ = req(base + "/settings")
    j = json.loads(body)
    assert code == 200 and j["settings"]["model"] == "claude-sonnet-5-5" and j["warning"]


def test_settings_refused_for_youtube_origin(base, tmp_path):
    code, _, h = req(base + "/settings", headers={"Origin": "https://www.youtube.com"})
    assert code == 403 and "Access-Control-Allow-Origin" not in h
    good = {"model": "claude-haiku-5-5", "effort": "low", "workers": 8}
    code, _, h = req(base + "/settings", json.dumps(good).encode(), "POST", {"Origin": "https://www.youtube.com"})
    assert code == 403 and "Access-Control-Allow-Origin" not in h
    assert not (tmp_path / "data" / "settings.json").exists()


# BuildQueue picks the settings up at the start of each build -------------------------

VID = "puh91fohvTA"


def _capture_env(tmp_path, monkeypatch, env=None):
    """Run one build through BuildQueue._run with a fake Popen; return the env the child got and the log text."""
    for k in SETTINGS_ENV:
        monkeypatch.delenv(k, raising=False)
    for k, v in (env or {}).items():
        monkeypatch.setenv(k, v)
    store = jobs.JobStore()
    store.add(VID, False)
    store.claim(VID)
    store.ingested(VID, 1)
    seen = {}

    class FakeProc:
        pid = 0

        def wait(self, timeout=None):
            return 1

        def poll(self):
            return 1

    def popen(argv, **kw):
        seen["env"] = kw["env"]
        seen["argv"] = argv
        return FakeProc()

    monkeypatch.setattr(jobs.subprocess, "Popen", popen)
    q = jobs.BuildQueue(store, tmp_path, cmd_factory=lambda v: ["build", v])
    q._run(VID)
    log = (tmp_path / "data" / "jobs" / f"{VID}.log").read_text("utf-8")
    return seen["env"], log


def test_build_env_gets_saved_settings(tmp_path, monkeypatch):
    settings.save(tmp_path, {"model": "claude-haiku-5-5", "effort": "low", "workers": 8})
    env, log = _capture_env(tmp_path, monkeypatch)
    assert env["YTLEARN_MODEL"] == "claude-haiku-5-5"
    assert env["YTLEARN_EFFORT"] == "low"
    assert env["YTLEARN_WORKERS"] == "8"
    assert "YTLEARN_PROGRESS_FILE" in env and "warning" not in log


def test_build_env_saved_beats_env_and_default_effort_clears_inherited(tmp_path, monkeypatch):
    settings.save(tmp_path, {"model": "claude-opus-5-5", "effort": "default", "workers": 2})
    env, _ = _capture_env(tmp_path, monkeypatch, {"YTLEARN_MODEL": "claude-haiku-5-5", "YTLEARN_EFFORT": "max",
                                                 "YTLEARN_WORKERS": "6"})
    assert env["YTLEARN_MODEL"] == "claude-opus-5-5" and env["YTLEARN_WORKERS"] == "2"
    assert "YTLEARN_EFFORT" not in env


def test_build_env_without_file_inherits_env(tmp_path, monkeypatch):
    env, log = _capture_env(tmp_path, monkeypatch, {"YTLEARN_EFFORT": "medium"})
    assert env["YTLEARN_EFFORT"] == "medium" and "YTLEARN_MODEL" not in env
    assert "YTLEARN_WORKERS" not in env
    assert log == ""


def test_build_with_broken_settings_warns_on_first_log_line(tmp_path, monkeypatch):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "settings.json").write_text("{oops", "utf-8")
    env, log = _capture_env(tmp_path, monkeypatch, {"YTLEARN_EFFORT": "high"})
    assert log.splitlines()[0].startswith("warning: settings.json")
    assert env["YTLEARN_EFFORT"] == "high"  # nothing saved: the env still applies


def test_settings_snapshot_taken_before_building(tmp_path, monkeypatch):
    """A save after the build has started (here: during set_building) does not change that build's env."""
    settings.save(tmp_path, {"model": "claude-haiku-5-5", "effort": "low", "workers": 1})
    real = jobs.JobStore.set_building

    def set_building(self, vid):
        real(self, vid)
        settings.save(tmp_path, {"model": "claude-opus-5-5", "effort": "max", "workers": 8})

    monkeypatch.setattr(jobs.JobStore, "set_building", set_building)
    env, _ = _capture_env(tmp_path, monkeypatch)
    assert env["YTLEARN_MODEL"] == "claude-haiku-5-5" and env["YTLEARN_EFFORT"] == "low"


# ---------------------------------------------------------------- request hardening

GOOD_SETTINGS = {"model": "claude-haiku-5-5", "effort": "low", "workers": 8}


def raw_req(base, method, path, body=None, headers=None):
    """http.client so the Host header can be forged."""
    import http.client
    host, port = base[len("http://"):].split(":")
    c = http.client.HTTPConnection(host, int(port))
    try:
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        return r.status, r.read(), r.headers
    finally:
        c.close()


def test_extension_style_post_without_origin_ok(base, tmp_path):
    code, _, _ = req(base + "/settings", json.dumps(GOOD_SETTINGS).encode(), "POST")
    assert code == 200


def test_extension_worker_origin_post_ok(base, tmp_path):
    # Chrome's extension service worker sends Origin: chrome-extension://<id> on POST.
    code, _, h = req(base + "/ingest", json.dumps(GOOD).encode(), "POST",
                     {"Origin": "chrome-extension://abcdefghijklmnopabcdefghijklmnop"})
    assert code == 200 and "Access-Control-Allow-Origin" not in h


def test_same_origin_post_ok(base, tmp_path):
    code, _, h = req(base + "/settings", json.dumps(GOOD_SETTINGS).encode(), "POST", {"Origin": base})
    assert code == 200 and h["Access-Control-Allow-Origin"] == base
    port = base.rsplit(":", 1)[1]
    code, _, _ = req(base + "/settings", json.dumps(GOOD_SETTINGS).encode(), "POST",
                     {"Origin": f"http://localhost:{port}"})
    assert code == 200


def test_youtube_origin_post_ingest_allowed(base, tmp_path):
    code, _, h = req(base + "/ingest", json.dumps(GOOD).encode(), "POST", {"Origin": "https://www.youtube.com"})
    assert code == 200 and h["Access-Control-Allow-Origin"] == "https://www.youtube.com"


@pytest.mark.parametrize("path", ["/add", "/jobs/abcdefghijk/claim"])
def test_youtube_origin_other_posts_refused(base, path):
    code, _, _ = req(base + path, b"{}", "POST", {"Origin": "https://www.youtube.com"})
    assert code == 403


def test_youtube_origin_get_refused(base):
    assert req(base + "/lessons", headers={"Origin": "https://www.youtube.com"})[0] == 403


def test_foreign_origin_refused(base, tmp_path):
    code, _, h = req(base + "/settings", json.dumps(GOOD_SETTINGS).encode(), "POST", {"Origin": "https://evil.example"})
    assert code == 403 and "Access-Control-Allow-Origin" not in h
    assert req(base + "/lessons", headers={"Origin": "https://evil.example"})[0] == 403
    assert req(base + "/lessons", headers={"Origin": "null"})[0] == 403
    assert not (tmp_path / "data" / "settings.json").exists()


@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", None])
def test_post_needs_json_content_type(base, tmp_path, ctype):
    headers = {"Content-Type": ctype} if ctype else {}
    code, _, _ = raw_req(base, "POST", "/settings", json.dumps(GOOD_SETTINGS).encode(), headers)
    assert code == 415
    assert not (tmp_path / "data" / "settings.json").exists()


def test_json_content_type_with_charset_ok(base):
    code, _, _ = req(base + "/settings", json.dumps(GOOD_SETTINGS).encode(), "POST",
                     {"Content-Type": "application/json; charset=utf-8"})
    assert code == 200


@pytest.mark.parametrize("host", ["evil.example", "evil.example:{port}", "127.0.0.1", "127.0.0.1:1",
                                  "localhost.evil.example:{port}"])
def test_bad_host_refused(base, tmp_path, host):
    port = base.rsplit(":", 1)[1]
    h = {"Host": host.format(port=port)}
    assert raw_req(base, "GET", "/lessons", headers=h)[0] == 421
    assert raw_req(base, "GET", "/", headers=h)[0] == 421
    code, _, _ = raw_req(base, "POST", "/settings", json.dumps(GOOD_SETTINGS).encode(),
                         dict(h, **{"Content-Type": "application/json"}))
    assert code == 421
    assert not (tmp_path / "data" / "settings.json").exists()


@pytest.mark.parametrize("host", ["127.0.0.1:{port}", "localhost:{port}", "LOCALHOST:{port}", "[::1]:{port}"])
def test_good_hosts_accepted(base, host):
    port = base.rsplit(":", 1)[1]
    assert raw_req(base, "GET", "/lessons", headers={"Host": host.format(port=port)})[0] == 200


def test_missing_host_refused(base):
    import socket
    host, port = base[len("http://"):].split(":")
    with socket.create_connection((host, int(port))) as s:
        s.sendall(b"GET /lessons HTTP/1.0\r\n\r\n")
        assert s.recv(64).split()[1] == b"400"


def test_max_body_is_4mb(base):
    assert server.MAX_BODY == 4 * 1024 * 1024
    code, _, _ = raw_req(base, "POST", "/ingest", b"",
                         {"Content-Type": "application/json", "Content-Length": str(server.MAX_BODY + 1)})
    assert code == 400
