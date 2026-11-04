"""Usage ledger data/usage.jsonl: one row per finished build (or recovered orphan usage file).

A row is ``{ts, videoId, provider, model, usage, costUsd, state, partial}``. Only rows whose provider
is an API provider count toward the monthly budget (``apiUsd``); everything else is ``cliUsd``.
Stdlib only."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from pipeline import settings


def path_for(root) -> Path:
    return Path(root) / "data" / "usage.jsonl"


def append(root, row: dict) -> None:
    """Append one row (``ts`` filled with the local time if missing). One write call per row."""
    row = dict(row)
    if not row.get("ts"):
        row["ts"] = datetime.now().astimezone().isoformat(timespec="seconds")
    p = path_for(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(row, ensure_ascii=False) + "\n"
    with open(p, "a", encoding="utf-8") as f:
        f.write(line)


def month_totals(root, now=None) -> dict:
    """Totals for the local calendar month of ``now`` (default: now). ``costUsd`` None counts as 0;
    unreadable lines are skipped."""
    month = (now or datetime.now().astimezone()).strftime("%Y-%m")
    out = {"month": month, "apiUsd": 0.0, "cliUsd": 0.0, "byProvider": {}, "rows": 0}
    try:
        text = path_for(root).read_text("utf-8", errors="replace")
    except OSError:
        return out
    for line in text.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or not isinstance(row.get("ts"), str) or row["ts"][:7] != month:
            continue
        cost = row.get("costUsd")
        usd = float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else 0.0
        provider = row.get("provider")
        name = provider if isinstance(provider, str) and provider else "unknown"
        if provider in settings.API_PROVIDERS:
            out["apiUsd"] += usd
        else:
            out["cliUsd"] += usd
        bucket = out["byProvider"].setdefault(name, {"usd": 0.0, "rows": 0})
        bucket["usd"] += usd
        bucket["rows"] += 1
        out["rows"] += 1
    return out
