import json
import threading
import urllib.error
import urllib.request

import pytest

import server
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


def req(url, data=None, method=None):
    r = urllib.request.Request(url, data=data, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, resp.read(), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def test_ingest_writes_raw_file(base, tmp_path):
    code, body, h = req(base + "/ingest", json.dumps(GOOD).encode(), "POST")
    assert code == 200
    out = json.loads(body)
    assert out == {"ok": True, "videoId": "CR94QQXO_4s", "events": 2,
                   "next": "python3 -m pipeline.build CR94QQXO_4s"}
    saved = json.loads((tmp_path / "data" / "raw" / "CR94QQXO_4s.json").read_text("utf-8"))
    assert saved == GOOD
    assert h["Access-Control-Allow-Origin"] == "*"


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
    code, _, h = req(base + "/ingest", method="OPTIONS")
    assert code == 204
    assert h["Access-Control-Allow-Origin"] == "*"
    assert h["Access-Control-Allow-Private-Network"] == "true"
    assert "Content-Type" in h["Access-Control-Allow-Headers"]


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
    (d / "CR94QQXO_4s.json").write_text(json.dumps(
        {"title": "T", "channel": "C", "duration": 344, "vocab": [1, 2, 3], "coveredSeconds": 120}))
    (d / "sub" / "z.json").write_text("{}")
    code, body, _ = req(base + "/lessons")
    assert code == 200
    assert json.loads(body) == [{"videoId": "CR94QQXO_4s", "title": "T", "channel": "C",
                                 "duration": 344, "vocabCount": 3, "coveredSeconds": 120}]


def test_lessons_empty_when_no_dir(base):
    assert json.loads(req(base + "/lessons")[1]) == []


def test_static_web_served(base):
    code, body, _ = req(base + "/")
    assert code == 200 and body == b"hi"
