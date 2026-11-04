import pytest


def test_prices_file_rows_are_complete():
    from pipeline import cost
    p = cost.load_prices()
    assert {"claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "gpt-6-astra"} <= set(p)
    for model, row in p.items():
        assert set(row) >= {"input", "output", "cacheRead", "cacheWrite", "source", "asOf"}, model
        assert row["source"].startswith("https://") and row["asOf"] == "2026-11-04"
        assert isinstance(row["input"], (int, float)) and isinstance(row["output"], (int, float))


def test_cost_sonnet_example():
    from pipeline import cost
    u = {"input": 1_000_000, "cacheRead": 1_000_000, "cacheWrite": 1_000_000, "output": 1_000_000}
    p = cost.load_prices()["claude-sonnet-5-5"]
    assert cost.cost_usd("claude-sonnet-5-5", u) == pytest.approx(p["input"] + p["cacheRead"] + p["cacheWrite"] + p["output"])


def test_cost_null_cache_price_falls_back_to_input_price():
    from pipeline import cost
    prices = {"m": {"input": 1.0, "output": 2.0, "cacheRead": None, "cacheWrite": None, "source": "x", "asOf": "d"}}
    assert cost.cost_usd("m", {"input": 0, "cacheRead": 0, "cacheWrite": 2_000_000, "output": 0}, prices) == pytest.approx(2.0)


def test_cost_unknown_model_is_none():
    from pipeline import cost
    assert cost.cost_usd("no-such-model", cost.zero_usage()) is None
    assert cost.price_date("no-such-model") is None and cost.price_date("claude-sonnet-5-5") == "2026-11-04"


def test_add_usage_and_zero():
    from pipeline import cost
    assert cost.zero_usage() == {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0}
    assert cost.add_usage({"input": 1, "cacheRead": 2, "cacheWrite": 3, "output": 4}, {"input": 10, "cacheRead": 0, "cacheWrite": 0, "output": 1}) == {"input": 11, "cacheRead": 2, "cacheWrite": 3, "output": 5}


def test_cost_dated_snapshot_falls_back_to_its_base_price():
    from pipeline import cost
    prices = {"gpt-x": {"input": 1.0, "output": 2.0, "cacheRead": None, "cacheWrite": None, "source": "s", "asOf": "d"}}
    u = {"input": 1_000_000, "cacheRead": 0, "cacheWrite": 0, "output": 1_000_000}
    assert cost.cost_usd("gpt-x-2026-08-07", u, prices) == pytest.approx(3.0)
    assert cost.price_date("gpt-x-2026-08-07", prices) == "d"
    assert cost.cost_usd("gpt-y-2026-08-07", u, prices) is None  # base not priced either
    assert cost.cost_usd("gpt-x-2026-8-7", u, prices) is None  # not a -YYYY-MM-DD suffix
