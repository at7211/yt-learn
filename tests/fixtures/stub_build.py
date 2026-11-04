"""Stub for `python3 -m pipeline.build <id>`; behaviour via env
STUB_MODE=ok|fail|ok_invalid|slow|usage|slow_usage|dump (usage: STUB_EXIT, default 0; dump: STUB_DUMP)."""
import json
import os
import sys
import time
from pathlib import Path

cwd = Path.cwd()
sys.path.insert(0, str(cwd))
from pipeline.schema import validate_lesson  # noqa: E402

vid = sys.argv[1]
mode = os.environ.get("STUB_MODE", "ok")
out = cwd / "data" / "lessons" / f"{vid}.json"
if mode == "fail":
    for i in range(6):
        print(f"stub line {i + 1}", flush=True)
    sys.exit(1)
USAGE = {"usage": {"input": 5, "cacheRead": 0, "cacheWrite": 0, "output": 1}, "costUsd": 0.1, "modelId": "m",
         "pid": os.getpid(), "ts": "x"}


def write_usage():
    p = os.environ.get("YTLEARN_USAGE_FILE")
    if p:
        Path(p).parent.mkdir(parents=True, exist_ok=True)
        Path(p).write_text(json.dumps(USAGE), "utf-8")


if mode == "dump":
    print("key " + os.environ.get("ANTHROPIC_API_KEY", ""), flush=True)
    Path(os.environ["STUB_DUMP"]).write_text(json.dumps({"env": dict(os.environ), "argv": sys.argv}), "utf-8")
    sys.exit(1)
if mode == "usage":
    write_usage()
    code = int(os.environ.get("STUB_EXIT", "0"))
    if code:
        sys.exit(code)
if mode == "slow_usage":
    write_usage()
    prog = os.environ.get("YTLEARN_PROGRESS_FILE")
    if prog:
        Path(prog).parent.mkdir(parents=True, exist_ok=True)
        Path(prog).write_text(json.dumps({"phase": "segment", "done": 1, "total": 4}), "utf-8")
    time.sleep(3)
if mode == "slow":
    prog = os.environ.get("YTLEARN_PROGRESS_FILE")
    if prog:
        Path(prog).parent.mkdir(parents=True, exist_ok=True)
        Path(prog).write_text(json.dumps({"phase": "segment", "done": 1, "total": 4}), "utf-8")
    time.sleep(3)
if not (cwd / "data" / "raw" / f"{vid}.json").is_file():
    print("raw missing", file=sys.stderr)
    sys.exit(1)
out.parent.mkdir(parents=True, exist_ok=True)
if mode == "ok_invalid":
    out.write_text("{}", "utf-8")
    sys.exit(0)
lesson = json.loads((Path(__file__).parent / "lesson_min.json").read_text("utf-8"))
lesson["videoId"] = vid
lesson["channel"] = str(cwd)
raw = json.loads((cwd / "data" / "raw" / f"{vid}.json").read_text("utf-8"))
for k in ("source", "sourceUrl"):  # mirrors pipeline/build.py
    if k in raw:
        lesson[k] = raw[k]
assert validate_lesson(lesson) == []
out.write_text(json.dumps(lesson, ensure_ascii=False), "utf-8")
