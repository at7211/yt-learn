"""Token usage -> USD conversion. Prices live only in prices.json (USD per 1M tokens)."""
import json
import re
from functools import lru_cache
from pathlib import Path

USAGE_KEYS = ("input", "cacheRead", "cacheWrite", "output")
_PRICES_PATH = Path(__file__).with_name("prices.json")
_DATED = re.compile(r"^(.+)-\d{4}-\d{2}-\d{2}$")  # a dated snapshot id such as gpt-x-2026-08-07


def zero_usage() -> dict:
    return {k: 0 for k in USAGE_KEYS}


def add_usage(a: dict, b: dict) -> dict:
    return {k: a.get(k, 0) + b.get(k, 0) for k in USAGE_KEYS}


@lru_cache(maxsize=1)
def _load() -> dict:
    return json.loads(_PRICES_PATH.read_text(encoding="utf-8"))


def load_prices() -> dict:
    return _load()


def _row(model, prices: dict | None) -> dict | None:
    """The price row for ``model``; a dated snapshot id with no row of its own uses its base id's row."""
    table = prices if prices is not None else load_prices()
    row = table.get(model)
    if row is None and isinstance(model, str):
        m = _DATED.match(model)
        if m:
            row = table.get(m.group(1))
    return row


def cost_usd(model: str, usage: dict, prices: dict | None = None) -> float | None:
    row = _row(model, prices)
    if row is None:
        return None
    rate_in = row["input"]
    rates = {
        "input": rate_in,
        "cacheRead": row.get("cacheRead") if row.get("cacheRead") is not None else rate_in,
        "cacheWrite": row.get("cacheWrite") if row.get("cacheWrite") is not None else rate_in,
        "output": row["output"],
    }
    total = sum(usage.get(k, 0) * rates[k] for k in USAGE_KEYS) / 1_000_000
    return round(total, 6)


def price_date(model: str, prices: dict | None = None) -> str | None:
    row = _row(model, prices)
    return row["asOf"] if row else None
