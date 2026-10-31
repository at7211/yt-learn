"""Stub for `python3 -m pipeline.build <id>`; behaviour via env STUB_MODE=ok|fail|ok_invalid|slow."""
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
