import json
from datetime import datetime

import pytest


def test_month_totals_only_counts_api_rows_in_month(tmp_path):
    from pipeline import usage
    usage.append(tmp_path, {"ts": "2026-11-02T10:00:00+08:00", "videoId": "a", "provider": "anthropic-api", "model": "m", "usage": {}, "costUsd": 0.5, "state": "done"})
    usage.append(tmp_path, {"ts": "2026-11-03T10:00:00+08:00", "videoId": "b", "provider": "claude-cli", "model": "m", "usage": {}, "costUsd": 0.25, "state": "error"})
    usage.append(tmp_path, {"ts": "2026-10-30T10:00:00+08:00", "videoId": "c", "provider": "openai-api", "model": "m", "usage": {}, "costUsd": 9, "state": "done"})
    t = usage.month_totals(tmp_path, datetime(2026, 11, 4, 12, 0))
    assert t["month"] == "2026-11" and t["apiUsd"] == 0.5 and t["cliUsd"] == 0.25 and t["rows"] == 2


def test_month_totals_treats_null_cost_as_zero_and_skips_bad_lines(tmp_path):
    from pipeline import usage
    usage.append(tmp_path, {"ts": "2026-11-02T10:00:00+08:00", "videoId": "a", "provider": "openai-api", "model": "m", "usage": {}, "costUsd": None, "state": "done"})
    with open(usage.path_for(tmp_path), "a") as f:
        f.write("{bad\n")
    t = usage.month_totals(tmp_path, datetime(2026, 11, 4))
    assert t["apiUsd"] == 0 and t["byProvider"]["openai-api"]["rows"] == 1


def test_append_fills_ts(tmp_path):
    from pipeline import usage
    usage.append(tmp_path, {"videoId": "a", "provider": "openai-api", "model": "m", "usage": {}, "costUsd": 1, "state": "done"})
    assert "ts" in json.loads(usage.path_for(tmp_path).read_text("utf-8").splitlines()[0])
