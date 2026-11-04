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


def test_month_totals_counts_unpriced_api_rows(tmp_path):
    from pipeline import usage
    used = {"input": 10, "cacheRead": 0, "cacheWrite": 0, "output": 2}
    row = {"ts": "2026-11-02T10:00:00+08:00", "videoId": "a", "model": "m", "state": "done"}
    usage.append(tmp_path, dict(row, provider="openai-api", usage=used, costUsd=None))  # counts
    usage.append(tmp_path, dict(row, provider="anthropic-api", usage=used, costUsd=None))  # counts
    usage.append(tmp_path, dict(row, provider="openai-api", usage={"input": 0, "output": 0}, costUsd=None))  # no usage
    usage.append(tmp_path, dict(row, provider="openai-api", usage=None, costUsd=None))  # no usage
    usage.append(tmp_path, dict(row, provider="openai-api", usage=used, costUsd=0.2))  # priced
    usage.append(tmp_path, dict(row, provider="claude-cli", usage=used, costUsd=None))  # not an API row
    usage.append(tmp_path, dict(row, ts="2026-10-02T10:00:00+08:00", provider="openai-api", usage=used, costUsd=None))
    t = usage.month_totals(tmp_path, datetime(2026, 11, 4))
    assert t["unpricedApiRows"] == 2 and t["apiUsd"] == pytest.approx(0.2)
    assert usage.month_totals(tmp_path / "none", datetime(2026, 11, 4))["unpricedApiRows"] == 0
