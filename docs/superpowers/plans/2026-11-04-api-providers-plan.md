# API key 直連 Provider ＋ 費用換算與每月上限：實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

第 1 版（2026-11-04）：起草。第 2 版：併入 Codex gpt-6-astra 第一輪 16 條（「退回」）。第 3 版：併入第二輪審查（Codex 用量額度已滿，改由獨立 opus 審稿；2 blocker、12 should-fix、5 nit，「退回」）：預算閘搬進 `JobStore.add` 的鎖內、審核旗標改成「進入 error 就清掉」、用量快照檔帶 attempt 並回收孤兒、三鍵設定仍可存、所有測試改成可執行的程式。第 5 版：併入第四輪獨立 opus 審稿（1 blocker、4 should-fix、6 nit，「修改後核准」，都是測試文字、import、遷移清單與 sweep 防禦，無架構變動）。第 4 版：併入第三輪獨立 opus 審稿（3 blocker、7 should-fix、9 nit，「退回」）：用量檔名加 run id 並記 pid、孤兒回收跳過還活著的 pid；Task 7 兩條測試改寫（done 之後的重排要走新 attempt；stale capturing 不 patch `time`）；`resolve` 也做跨欄位檢查；CLI 來源的子行程原樣繼承環境（只有 API 來源才剝掉並注入 key）；各 Task 的遷移清單逐行列出。三輪裁決表在文末。行號只當線索，**以符號名稱為準**。

**Goal:** 讓產課可以用使用者自己的 Anthropic 或 OpenAI API key 直連（不裝 CLI），並記錄每堂課的 token 與估算美元、對照每月上限提醒與擋新產課。

**Architecture:** `pipeline/llm.py` 多兩個走 HTTP 的 Provider（共用可注入 transport 的 `_HttpProvider` 基底：不跟隨 redirect、有界重試、錯誤對應、key 遮蔽），沿用既有快取層與 `complete_json`；認證／額度錯誤是 `ProviderFatal`，穿透切句的降級邏輯讓產課停下。設定多 `provider`／`budgetUsd`，key 存 `data/keys.json`（建檔即 0600），只把選定來源的 key 經環境變數交給產課子行程。用量由 Provider 在每次回應後（鎖內）寫進帶 attempt 的用量快照檔，jobs.py 結束時讀它寫入 `data/usage.jsonl`，孤兒檔在 server 啟動與下次產課前回收。預算閘是 `JobStore.add` 的一個回呼，只在鎖內真的要建立新 attempt 的分支執行；job 進入 error 就失去核准，error → 重新 ingest 在 `/ingest` 再過閘。

**Tech Stack:** Python 3.11+ 標準函式庫（`urllib.request`、`json`、`threading`），pytest；前端 vanilla ES module，`node --test`。零新依賴。

**Spec:** `docs/superpowers/plans/2026-11-03-api-providers.md`（設計，第 3 版）。API 形狀與牌價：`docs/superpowers/notes/2026-11-04-anthropic-api-facts.md`、`docs/superpowers/notes/2026-11-04-openai-api-facts.md`（文件沒寫的欄位，載入 `claude-api` skill 或查 developers.openai.com，不憑記憶）。

## Global Constraints

- Python `>= 3.11`、不新增執行期依賴；CI 只 `pip install pytest`。
- 分支 `feat/api-providers`（從 `main` e0d6e4b 開）；每個 Task 一個 commit，`git -c commit.gpgsign=false commit`，**不加 `Co-Authored-By`**。
- key 不得出現在：瀏覽器回應、log、progress 檔、用量快照、lesson 檔、帳本、錯誤訊息、指令列參數、git。會變成訊息的字串在**截斷之前**先 `keys.scrub`。
- 既有 CLI 路徑行為不變：`ClaudeCliProvider`／`CodexCliProvider` 的快取鍵欄位與現狀完全相同；`tests/test_llm.py` 既有測試不改斷言。
- 兩個新 Provider 不改任何 prompt、schema、`promptVersion`。
- 前端與擴充不用 `innerHTML`／`outerHTML`／`insertAdjacentHTML`／`document.write`。
- 牌價只來自 `pipeline/prices.json`；程式裡不出現牌價數字。
- HTTP：單一 `urllib` `timeout = self.timeout`（Anthropic 180 s、OpenAI 300 s；`list_models` 20 s）；**不跟隨 redirect**；`User-Agent: yt-learn`。
- 每個 Task 的測試步驟都必須先 FAIL 再 PASS；新 import 一律寫在**測試函式內**，避免整個測試模組在實作前收集失敗。
- 文案繁體中文；錯誤訊息不含 key、不含 URL 查詢字串。

## Review Focus

1. 貼了 key、測試成功、沒按儲存就關頁：key 已存檔，下次顯示「已設定 ••••ab12」。→ Task 8 `test_keys_test_saves_key_on_success`。
2. 產課中途 401：切句／挑字／背景卡不降級硬撐，job 轉 error，訊息「API key 無效或沒有權限」且不含 key，已花的用量進帳本。→ Task 4 `test_anthropic_401_is_fatal_with_status_no_retry_no_key`、Task 6 `test_fatal_provider_error_stops_build_and_keeps_usage`、Task 7 `test_ledger_row_written_on_success_and_failure`。
3. 網頁按「這次仍要跑」後，擴充自己再 `POST /add`（不帶 override）：不得再 402。→ Task 8 `test_override_then_extension_readd_is_not_blocked`。
4. error 之後擴充重新 ingest（沒經 `/add`）：要再過閘，超限時 job 轉 error、不排程。→ Task 7 `test_error_clears_approval`、Task 8 `test_reingest_after_error_passes_the_gate`。
5. server 當掉、產課子行程成了孤兒：下次啟動時孤兒的用量檔仍進帳本（`state: "orphan"`），不會被下一次全中快取的重產讀成自己的費用。→ Task 7 `test_orphan_usage_file_is_swept`。

---

### Task 1: 牌價表與費用換算 `pipeline/cost.py`

**Files:** Create `pipeline/prices.json`、`pipeline/cost.py`；Test `tests/test_cost.py`。

**Interfaces（Produces）:** `USAGE_KEYS = ("input", "cacheRead", "cacheWrite", "output")`；`zero_usage() -> dict`；`add_usage(a, b) -> dict`；`load_prices() -> dict`；`cost_usd(model: str, usage: dict, prices: dict | None = None) -> float | None`；`price_date(model: str, prices: dict | None = None) -> str | None`。`usage` 統一形狀：`input` 未命中快取的輸入 token、`cacheRead`／`cacheWrite` 快取讀／寫、`output` 含推理 token。

- [ ] **Step 1: 寫 `pipeline/prices.json`**：每列 `{"input", "output", "cacheRead", "cacheWrite", "source", "asOf"}`（可選 `note`），美元／百萬 token，沒有的填 `null`，數字逐一抄自兩份 facts §8：`claude-opus-5-5` 4／20／0.20／5；`claude-sonnet-5-5` 2／10／0.10／2.50；`claude-haiku-5-5` 0.10／0.50／0.01／0.125（`note` "≤100K-token prompts tier"）；`source` `https://platform.claude.com/docs/en/about-claude/pricing`。OpenAI：gpt-6-astra（cacheWrite 12.50）、gpt-6.1-sol、gpt-6.1-terra、gpt-6-sol、gpt-6-luna、gpt-5.6-sol／terra／luna、gpt-5.5、gpt-5.4、gpt-5.4-mini、gpt-5.4-nano、gpt-5.2、gpt-5.1、gpt-5、gpt-5-mini、gpt-5-nano、o3；`source` `https://developers.openai.com/api/docs/pricing`。全部 `asOf` `2026-11-04`。
- [ ] **Step 2: 寫失敗測試 `tests/test_cost.py`**

```python
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
```

- [ ] **Step 3:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_cost.py` → FAIL（`ModuleNotFoundError`）
- [ ] **Step 4: 實作 `pipeline/cost.py`**（`Path(__file__).with_name("prices.json")` + `functools.lru_cache`；`null` 快取牌價以 `input` 牌價代替；`round(x, 6)`）
- [ ] **Step 5:** 同指令 → PASS
- [ ] **Step 6: Commit** `git add pipeline/prices.json pipeline/cost.py tests/test_cost.py && git -c commit.gpgsign=false commit -m "feat(cost): price table with sources and usage-to-USD conversion"`

---

### Task 2: 設定多 `provider`／`budgetUsd`；模型依來源驗證；三鍵舊客戶端仍可存

**Files:** Modify `pipeline/settings.py`（`MODELS`/`DEFAULTS`/`VALID`/`ENV`、`_check`、`normalize`、`load`、`save`、`_from_env`、`resolve`、`apply_to_env`）；Test `tests/test_settings.py`。

**Interfaces（Produces）:**
- `PROVIDERS = ("claude-cli", "codex-cli", "anthropic-api", "openai-api")`；`PROVIDER_ALIASES = {"claude": "claude-cli", "codex": "codex-cli"}`；`API_PROVIDERS = ("anthropic-api", "openai-api")`；`KEY_OF = {"anthropic-api": "anthropic", "openai-api": "openai"}`；`DEFAULTS = {"provider": "claude-cli", "model": "claude-sonnet-5-5", "effort": "default", "workers": 4, "budgetUsd": None}`；`ENV` 多 `provider → YTLEARN_PROVIDER`、`budgetUsd → YTLEARN_BUDGET_USD`。
- `normalize(obj, partial=False, models=None) -> (settings, errors)`：**非 partial 時缺 `provider` 視為 `claude-cli`、缺 `budgetUsd` 視為 `None`**（舊的三鍵客戶端與 `web/settings.js` 在 Task 9 前仍能存；缺 `model`／`effort`／`workers` 仍是錯誤）；未知鍵仍是錯誤。
- 模型規則（依 `provider`，缺時 `claude-cli`）：`claude-cli` → `MODELS`；`anthropic-api` → `MODELS` ∪ `models["anthropic"]`；`openai-api` → 必須在 `models["openai"]`，否則錯誤「請先測試連線取得模型清單」；`codex-cli` → 任何非空字串。`budgetUsd`：`None` 或有限且 `> 0` 的 int/float（bool、NaN、inf 拒絕）。
- `models_path(root)`（`data/models.json`）、`load_models(root) -> dict`（缺／壞檔 `{}`）、`save_models(root, provider_key, ids) -> dict`。
- `load(root, models=None)`／`save(root, settings, models=None)`：`models` 為 `None` 時自行 `load_models(root)`。**`load`（partial）在跨欄位檢查失敗時同時丟掉 `provider` 與 `model`**（不會組出「OpenAI 來源＋Claude 模型」），並在 `warning` 說明。
- `resolve(saved, env, models=None)`：env 的 `YTLEARN_PROVIDER` 經別名對應（非法忽略）；`YTLEARN_MODEL` 的接受規則**依最終 provider**：provider 是 `claude-cli`／`anthropic-api` 時維持現狀（`MODELS` 白名單，不合法就靜默忽略，所以既有 `resolve({}, {"YTLEARN_MODEL": "opus"}) == DEFAULTS` 照舊）；provider 是 `openai-api` 時要在 `models["openai"]` 裡，否則忽略；`codex-cli` 任意非空字串。`YTLEARN_BUDGET_USD` 轉 float（非法忽略）。**合併完 DEFAULTS → env → saved 之後再做一次跨欄位檢查**（規則同 `normalize`；`models` 為 None 視為 `{}`）：不一致時（只會發生在 API 來源配了不相容的模型，例如 `YTLEARN_PROVIDER=openai-api` 但沒有可用的 OpenAI 模型）`provider` 與 `model` 一起退回 `DEFAULTS`，並加 `out["warning"] = "來源與模型不一致，改用預設"`；CLI 來源永遠不會帶 `warning`。`apply_to_env(saved, env)`：多寫 `YTLEARN_PROVIDER`、`YTLEARN_BUDGET_USD`（`None` → 移除）；忽略 `warning` 鍵。

- [ ] **Step 1: 遷移既有測試**（逐條）：
  - `tests/test_settings.py` `test_normalize_rejects`：參數列表保留（缺 `workers` 那列仍被拒；其餘因壞值被拒），再加 `{**DEFAULTS, "provider": "gpt"}`。
  - `tests/test_settings.py` `test_save_first_write_creates_dir_and_round_trips`：`save` 回傳與讀回的期望改成 `dict(st.DEFAULTS, **三鍵)`。
  - `tests/test_settings.py` 第 79 行附近 `got in choices`：`choices` 的每個 dict 包成 `dict(st.DEFAULTS, **x)`。
  - `tests/test_settings.py` 第 85、87 行附近 `resolve` 的全等比對：期望改成 `dict(st.DEFAULTS, **三鍵)`。
  - `tests/test_server.py` 第 137、148-150、175 行附近 `GET`／`POST /settings` 回應與檔案內容的全等比對：期望改成 `dict(settings.DEFAULTS, **三鍵)`。
  - `tests/test_server.py` `SETTINGS_ENV`（第 125 行附近）補清 `YTLEARN_PROVIDER`、`YTLEARN_BUDGET_USD`。
- [ ] **Step 2: 寫失敗測試（加到 `tests/test_settings.py`）**

```python
def test_defaults_include_provider_and_budget():
    assert st.DEFAULTS["provider"] == "claude-cli" and st.DEFAULTS["budgetUsd"] is None
    assert st.normalize(st.DEFAULTS) == (st.DEFAULTS, [])


def test_three_key_client_still_accepted():
    clean, errs = st.normalize({"model": "claude-opus-5-5", "effort": "high", "workers": 2})
    assert errs == [] and clean == {"provider": "claude-cli", "model": "claude-opus-5-5", "effort": "high", "workers": 2, "budgetUsd": None}


def test_old_settings_file_without_provider_loads_as_claude_cli(tmp_path):
    st.path_for(tmp_path).parent.mkdir(parents=True)
    st.path_for(tmp_path).write_text(json.dumps({"model": "claude-opus-5-5", "effort": "high", "workers": 2}))
    r = st.resolve(st.load(tmp_path), {})
    assert r["provider"] == "claude-cli" and r["model"] == "claude-opus-5-5"


def test_load_drops_provider_and_model_together_when_inconsistent(tmp_path):
    st.path_for(tmp_path).parent.mkdir(parents=True)
    st.path_for(tmp_path).write_text(json.dumps(dict(st.DEFAULTS, provider="openai-api", model="gpt-6-astra")))
    saved = st.load(tmp_path)  # no data/models.json
    assert "provider" not in saved and "model" not in saved and "warning" in saved
    assert st.resolve(saved, {})["provider"] == "claude-cli"


def test_env_provider_alias_and_budget_in_resolve():
    assert st.resolve({}, {"YTLEARN_PROVIDER": "codex"})["provider"] == "codex-cli"
    r = st.resolve({}, {"YTLEARN_PROVIDER": "openai-api"})  # no usable OpenAI model: falls back with a warning
    assert r["provider"] == "claude-cli" and "warning" in r
    r = st.resolve({}, {"YTLEARN_PROVIDER": "openai-api", "YTLEARN_MODEL": "gpt-6-astra"}, models={"openai": ["gpt-6-astra"], "anthropic": []})
    assert r["provider"] == "openai-api" and r["model"] == "gpt-6-astra" and "warning" not in r
    assert st.resolve({}, {"YTLEARN_PROVIDER": "nope"})["provider"] == "claude-cli"
    assert "warning" not in st.resolve({}, {"YTLEARN_MODEL": "opus"})  # CLI source never warns
    assert st.resolve({}, {"YTLEARN_BUDGET_USD": "2.5"})["budgetUsd"] == 2.5
    assert st.resolve({}, {"YTLEARN_BUDGET_USD": "x"})["budgetUsd"] is None


def test_resolve_rejects_inconsistent_provider_model_combo(tmp_path):
    r = st.resolve({}, {"YTLEARN_PROVIDER": "openai-api", "YTLEARN_MODEL": "gpt-6-astra"})
    assert r["provider"] == "claude-cli" and r["model"] == "claude-sonnet-5-5" and "warning" in r
    r = st.resolve({"model": "claude-opus-5-5"}, {"YTLEARN_PROVIDER": "openai-api"})
    assert r["provider"] == "claude-cli" and r["model"] == "claude-sonnet-5-5" and "warning" in r
    r = st.resolve({}, {"YTLEARN_PROVIDER": "openai-api", "YTLEARN_MODEL": "gpt-6-astra"}, models={"openai": ["gpt-6-astra"], "anthropic": []})
    assert r["provider"] == "openai-api" and r["model"] == "gpt-6-astra" and "warning" not in r


def test_openai_model_requires_models_cache():
    s = dict(st.DEFAULTS, provider="openai-api", model="gpt-6-astra")
    assert any("測試連線" in e for e in st.normalize(s, models={})[1])
    assert st.normalize(s, models={"openai": ["gpt-6-astra"], "anthropic": []}) == (s, [])


def test_save_validates_with_models_cache(tmp_path):
    s = dict(st.DEFAULTS, provider="openai-api", model="gpt-6-astra")
    with pytest.raises(ValueError):
        st.save(tmp_path, s)
    st.save_models(tmp_path, "openai", ["gpt-6-astra"])
    assert st.save(tmp_path, s) == s and st.load(tmp_path)["model"] == "gpt-6-astra"


def test_anthropic_api_accepts_whitelist_or_cached_list():
    s = dict(st.DEFAULTS, provider="anthropic-api", model="claude-sonnet-5-5")
    assert st.normalize(s, models={})[1] == []
    s["model"] = "claude-opus-6-0"
    assert st.normalize(s, models={})[1]
    assert st.normalize(s, models={"anthropic": ["claude-opus-6-0"], "openai": []})[1] == []


def test_codex_cli_model_not_validated():
    assert st.normalize(dict(st.DEFAULTS, provider="codex-cli", model="anything"))[1] == []


@pytest.mark.parametrize("bad", [0, -1, True, "5", float("nan"), float("inf")])
def test_budget_rejects(bad):
    assert st.normalize(dict(st.DEFAULTS, budgetUsd=bad))[1]


def test_apply_to_env_writes_provider_and_budget():
    env = st.apply_to_env({"provider": "openai-api", "budgetUsd": 3}, {"YTLEARN_BUDGET_USD": "9"})
    assert env["YTLEARN_PROVIDER"] == "openai-api" and env["YTLEARN_BUDGET_USD"] == "3"
    assert "YTLEARN_BUDGET_USD" not in st.apply_to_env({"budgetUsd": None}, {"YTLEARN_BUDGET_USD": "9"})


def test_models_cache_round_trip(tmp_path):
    assert st.load_models(tmp_path) == {}
    out = st.save_models(tmp_path, "openai", ["gpt-6-astra", "gpt-5-mini"])
    assert out["openai"] == ["gpt-6-astra", "gpt-5-mini"] and out["fetchedAt"]
    out = st.save_models(tmp_path, "anthropic", ["claude-opus-5-5"])
    assert st.load_models(tmp_path)["openai"] == ["gpt-6-astra", "gpt-5-mini"] and out["anthropic"] == ["claude-opus-5-5"]
```

- [ ] **Step 3:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_settings.py` → 新測試 FAIL
- [ ] **Step 4: 實作**
- [ ] **Step 5:** Run `~/.local/bin/uv run --with pytest pytest -q` → 全 PASS（`tests/test_server.py` 既有三鍵 `POST /settings` 的測試應不受影響；回應的 `settings` 多了 `provider`／`budgetUsd` 的話，把該處全等斷言改成 `dict(settings.DEFAULTS, **三鍵)`）
- [ ] **Step 6: Commit** `git add pipeline/settings.py tests/test_settings.py tests/test_server.py && git -c commit.gpgsign=false commit -m "feat(settings): provider, budgetUsd and per-provider model validation on load, save and resolve"`

---

### Task 3: key 的存放與遮罩 `pipeline/keys.py`

**Files:** Create `pipeline/keys.py`；Test `tests/test_keys.py`。

**Interfaces（Produces）:** `KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}`；`path_for(root)`（`data/keys.json`）；`load(root) -> dict[str, str]`；`save(root, updates) -> dict`（合併；`""` 刪除；暫存檔用 `os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)` 建立後 `os.fdopen` 寫入、`os.replace`；失敗時刪暫存檔；**不呼叫 `os.chmod`**）；`resolve(root, env) -> {家: (key | None, "file" | "env" | None)}`；`public(root, env)`（`{"set", "tail"(末 4 碼), "source"}`）；`env_for_build(root, env, provider) -> dict`（複製 env；**provider 是 API 來源時**先移除兩個 `KEY_ENV` 變數，再只注入 `settings.KEY_OF[provider]` 那一家解析到的 key；**provider 是 CLI 來源時原樣回傳複本**，既不注入也不移除，CLI 路徑行為不變；第三輪 S-6 採 (a)）；`scrub(text, keys) -> str`（整把 key（長度 ≥ 8）→ `<key>`，再把 `sk-[A-Za-z0-9_-]{8,}` → `<key>`）；`all_keys(root, env) -> list[str]`。

- [ ] **Step 1: 寫失敗測試 `tests/test_keys.py`**

```python
import json
import os
import stat

import pytest


def test_save_merges_deletes_and_is_0600_from_creation(tmp_path, monkeypatch):
    from pipeline import keys
    opened = []
    real_open = os.open

    def spy_open(path, flags, mode=0o777, *a, **k):
        opened.append((str(path), flags, mode))
        return real_open(path, flags, mode, *a, **k)
    monkeypatch.setattr(os, "open", spy_open)
    for name in ("chmod", "fchmod"):
        monkeypatch.setattr(os, name, lambda *a, **k: (_ for _ in ()).throw(AssertionError(name + " must not be needed")))
    out = keys.save(tmp_path, {"anthropic": "sk-ant-abcdef1234"})
    assert out == {"anthropic": "sk-ant-abcdef1234"}
    assert stat.S_IMODE(keys.path_for(tmp_path).stat().st_mode) == 0o600
    creates = [(f, m) for p, f, m in opened if "keys.json" in p and f & os.O_CREAT]
    assert creates and all(f & os.O_EXCL and m == 0o600 for f, m in creates)
    assert set(keys.save(tmp_path, {"openai": "sk-openai-xyz7890"})) == {"anthropic", "openai"}
    out = keys.save(tmp_path, {"anthropic": ""})
    assert out == {"openai": "sk-openai-xyz7890"} and keys.load(tmp_path) == out
    assert [p.name for p in keys.path_for(tmp_path).parent.iterdir()] == ["keys.json"]


def test_save_cleans_tmp_when_replace_fails(tmp_path, monkeypatch):
    from pipeline import keys
    def boom(a, b):
        raise OSError("boom")
    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        keys.save(tmp_path, {"anthropic": "sk-ant-abcdef1234"})
    assert not keys.path_for(tmp_path).parent.exists() or list(keys.path_for(tmp_path).parent.iterdir()) == []


def test_resolve_prefers_file_then_env(tmp_path):
    from pipeline import keys
    keys.save(tmp_path, {"anthropic": "sk-file-00001234"})
    r = keys.resolve(tmp_path, {"ANTHROPIC_API_KEY": "sk-env-00005678", "OPENAI_API_KEY": "sk-env-oa-9999"})
    assert r["anthropic"] == ("sk-file-00001234", "file") and r["openai"] == ("sk-env-oa-9999", "env")
    assert keys.resolve(tmp_path, {})["openai"] == (None, None)


def test_public_never_returns_whole_key(tmp_path):
    from pipeline import keys
    keys.save(tmp_path, {"anthropic": "sk-file-00001234"})
    pub = keys.public(tmp_path, {})
    assert pub == {"anthropic": {"set": True, "tail": "1234", "source": "file"}, "openai": {"set": False, "tail": None, "source": None}}
    assert "sk-file" not in json.dumps(pub)


def test_env_for_build_api_provider_strips_and_injects_cli_provider_inherits(tmp_path):
    from pipeline import keys
    keys.save(tmp_path, {"openai": "sk-openai-xyz7890", "anthropic": "sk-ant-abcdef1234"})
    inherited = {"PATH": "/bin", "ANTHROPIC_API_KEY": "sk-env-inherited-1", "OPENAI_API_KEY": "sk-env-inherited-2"}
    env = keys.env_for_build(tmp_path, inherited, "openai-api")
    assert env["OPENAI_API_KEY"] == "sk-openai-xyz7890" and "ANTHROPIC_API_KEY" not in env and env["PATH"] == "/bin"
    env = keys.env_for_build(tmp_path, inherited, "claude-cli")
    assert env == inherited and env is not inherited  # CLI builds inherit the environment untouched
    assert inherited["ANTHROPIC_API_KEY"] == "sk-env-inherited-1"


def test_scrub_replaces_whole_keys_and_sk_prefixes():
    from pipeline import keys
    assert keys.scrub("bad key sk-openai-xyz7890 here", ["sk-openai-xyz7890", "short"]) == "bad key <key> here"
    assert keys.scrub("got sk-ant-api03-ABCDEFGH12 back", []) == "got <key> back"


def test_load_tolerates_bad_file(tmp_path):
    from pipeline import keys
    keys.path_for(tmp_path).parent.mkdir(parents=True)
    keys.path_for(tmp_path).write_text("{not json")
    assert keys.load(tmp_path) == {}
```

- [ ] **Step 2:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_keys.py` → FAIL
- [ ] **Step 3: 實作 `pipeline/keys.py`**
- [ ] **Step 4:** 同指令 → PASS
- [ ] **Step 5: Commit** `git add pipeline/keys.py tests/test_keys.py && git -c commit.gpgsign=false commit -m "feat(keys): data/keys.json created 0600, env fallback, masked view, scrubber"`

---

### Task 4: `_HttpProvider` 基底、`ProviderFatal`、`AnthropicApiProvider`

**Files:** Modify `pipeline/llm.py`（`ProviderError`；`_CliProvider` → 改名 `_CachedProvider` 並保留 `_CliProvider = _CachedProvider`；`ClaudeCliProvider._call`；`strict_schema` 之後加新類別）；Modify `pipeline/segment.py` `make_cues`、`pipeline/vocab.py` `pick_vocab`、`pipeline/intro.py` `_ask`（三處 `except ProviderError` 之前加 `except ProviderFatal: raise`）；Test `tests/test_llm.py`、`tests/test_segment.py`、`tests/test_vocab.py`、`tests/test_intro.py`。

**Interfaces（Consumes）:** Task 1 `cost`、Task 3 `keys.scrub`。

**Interfaces（Produces）:**
- `class ProviderFatal(ProviderError)`：`__init__(self, message, status: int | None = None)`，屬性 `status`。認證（401／403）、額度上限、重試耗盡、4xx、3xx、非 JSON 回應都用它。
- `_CachedProvider`：`usage: dict`（`zero_usage()`）；`_usage_lock = threading.Lock()`；`usage_sink: Callable[[dict], None] | None = None`；`record_usage(u)`：**在鎖內**累加並呼叫 `usage_sink(dict(self.usage))`（鎖內呼叫，快照單調）；快取命中**不**呼叫 `record_usage`。
- `FakeProvider`：也加 `usage`、`usage_sink`、`record_usage`（同語意，供 build 測試）。
- `ClaudeCliProvider._call`：stdout JSON 的 `usage` → `record_usage`（`input_tokens`→`input`、`cache_read_input_tokens`→`cacheRead`、`cache_creation_input_tokens`→`cacheWrite`、`output_tokens`→`output`，缺當 0）；stderr 進訊息前 `keys.scrub(text, [])`。
- `class TransportError(Exception)`；`Transport = Callable[[method, url, headers, body: bytes | None, timeout], (status, headers_lower: dict, body: bytes)]`；`urllib_transport`：**每次呼叫都執行** `urllib.request.build_opener(_NoRedirect())`（`class _NoRedirect(urllib.request.HTTPRedirectHandler)` 的 `redirect_request` 永遠回 `None`），`HTTPError` → `(code, headers, body)`，`URLError`／`TimeoutError`／`socket.timeout` → `TransportError(str)`。
- `class _HttpProvider(_CachedProvider)`：`__init__(self, api_key, model=None, cache_dir=None, prompt_version=1, timeout=None, effort=None, transport=urllib_transport)`；`RETRY_STATUSES = (408, 429, 500, 502, 503, 529)`；`MAX_ATTEMPTS = 4`；`RETRY_BUDGET_S = 120`；`_sleep = time.sleep`（可注入）；`_request(method, url, body: dict | None, *, attempts=MAX_ATTEMPTS, timeout=None) -> dict`：
  - `TransportError` 與 `RETRY_STATUSES` → 退避 1／2／4 s（+0–0.5 s 抖動）；`retry-after` 有就等**至少**那麼久；下一次等待會讓累計等待超過 `RETRY_BUDGET_S` → 不等，直接 `ProviderFatal(..., status)`；耗盡 → `ProviderFatal`。
  - 401／403 → `ProviderFatal("API key 無效或沒有權限", status)`；3xx → `ProviderFatal("伺服器要求重新導向，已拒絕", status)`；其他 4xx → `ProviderFatal(f"API 回 {status}：{msg[:200]}", status)`；非 JSON → `ProviderFatal`。
  - 所有訊息先 `keys.scrub(msg, [self.api_key])` 再截斷。`_Failure` 只用於內容問題（截斷、拒答、文字非 JSON），它們才走 `complete_json` 既有的一次後綴重試。
- `class AnthropicApiProvider(_HttpProvider)`：`name = "anthropic-api"`、`default_timeout = 180.0`、`BASE = "https://api.anthropic.com"`、`VERSION = "2026-10-21"`、`MAX_TOKENS = 16000`；`_cache_fields` 不覆寫；`effortSent` 屬性 = `self.effort`；`_call`：`POST /v1/messages`，headers `x-api-key`、`anthropic-version`、`content-type: application/json`、`user-agent: yt-learn`；body `{"model", "max_tokens": 16000, "system", "messages": [{"role": "user", "content": user}]}` ＋ `output_config`（`format: {"type": "json_schema", "schema": anthropic_schema(schema)}` 當 schema 非 None；`effort` 當有設）；不送 `temperature`、`thinking`。回應：**先 `record_usage`**，再 `stop_reason` `max_tokens` → `_Failure("回覆被截斷")`、`refusal` → `_Failure("模型拒答")`，再取第一個 `type == "text"` block 的 `text` → `_parse_object`。
- `anthropic_schema(schema)`：`strict_schema` 後遞迴移除 `maxItems`、`minLength`、`maxLength`、`minimum`、`maximum`、`multipleOf`；`minItems > 1` 改 1。
- `@staticmethod AnthropicApiProvider.list_models(api_key, transport=urllib_transport) -> list[str]`：`GET /v1/models?limit=1000`，`attempts=1`、`timeout=20`，回 `claude-` 開頭的 `data[].id`。

- [ ] **Step 1: 寫失敗測試（加到 `tests/test_llm.py`；新符號在函式內 import）**

```python
KEY = "sk-ant-test-0123456789"


def fake_transport(outcomes):
    """Each outcome: (status, headers, body_obj) or an Exception instance. Records (method, url, headers, body_obj, timeout)."""
    calls = []

    def t(method, url, headers, body, timeout):
        calls.append((method, url, headers, json.loads(body) if body else None, timeout))
        o = outcomes.pop(0)
        if isinstance(o, Exception):
            raise o
        st, hd, obj = o
        return st, hd, json.dumps(obj).encode()
    t.calls = calls
    return t


def anth_ok(obj, usage=None, stop="end_turn"):
    return (200, {}, {"content": [{"type": "thinking", "thinking": ""}, {"type": "text", "text": json.dumps(obj)}],
                      "stop_reason": stop, "usage": usage or {"input_tokens": 10, "output_tokens": 5,
                                                              "cache_read_input_tokens": 3, "cache_creation_input_tokens": 2}})


def test_anthropic_request_shape_and_usage():
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([anth_ok({"a": 1})])
    p = AnthropicApiProvider(KEY, model="claude-sonnet-5-5", effort="high", transport=t)
    assert p.complete_json("sys", "usr", {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]}) == {"a": 1}
    method, url, headers, body, timeout = t.calls[0]
    assert (method, url, timeout) == ("POST", "https://api.anthropic.com/v1/messages", 180.0)
    assert headers["x-api-key"] == KEY and headers["anthropic-version"] == "2026-10-21" and headers["user-agent"] == "yt-learn"
    assert body["system"] == "sys" and body["messages"] == [{"role": "user", "content": "usr"}]
    assert body["max_tokens"] == 16000 and "temperature" not in body and "thinking" not in body
    assert body["output_config"]["effort"] == "high" and body["output_config"]["format"]["schema"]["additionalProperties"] is False
    assert p.usage == {"input": 10, "cacheRead": 3, "cacheWrite": 2, "output": 5} and p.effortSent == "high"


def test_anthropic_cache_key_matches_claude_cli_and_hits_add_no_usage(tmp_path):
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([anth_ok({"a": 1})])
    p = AnthropicApiProvider(KEY, model="claude-sonnet-5-5", cache_dir=tmp_path, transport=t)
    p.complete_json("s", "u")
    assert "effort" not in t.calls[0][3].get("output_config", {})
    cli = ClaudeCliProvider(model="claude-sonnet-5-5", cache_dir=tmp_path)
    assert cli._cache_path("s", "u", None) == p._cache_path("s", "u", None)
    seen = []
    cli.usage_sink = seen.append
    assert cli.complete_json("s", "u") == {"a": 1}  # cache hit: no subprocess, no usage, sink not called
    assert cli.usage == {"input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0} and seen == []


def test_anthropic_retries_429_then_succeeds():
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([(429, {"retry-after": "0"}, {"type": "error", "error": {"type": "rate_limit_error", "message": "slow"}}), anth_ok({"a": 2})])
    p = AnthropicApiProvider(KEY, transport=t)
    p._sleep = lambda s: None
    assert p.complete_json("s", "u") == {"a": 2} and len(t.calls) == 2


def test_anthropic_truncated_then_ok_sums_usage_and_adds_suffix():
    from pipeline.llm import AnthropicApiProvider
    t = fake_transport([anth_ok({"a": 1}, stop="max_tokens"), anth_ok({"a": 1})])
    p = AnthropicApiProvider(KEY, transport=t)
    assert p.complete_json("s", "u") == {"a": 1}
    assert t.calls[1][3]["messages"][0]["content"].endswith(llm.RETRY_SUFFIX)
    assert p.usage["input"] == 20 and p.usage["output"] == 10


def test_anthropic_401_is_fatal_with_status_no_retry_no_key():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    t = fake_transport([(401, {}, {"type": "error", "error": {"type": "authentication_error", "message": "bad " + KEY}})])
    with pytest.raises(ProviderFatal) as ei:
        AnthropicApiProvider(KEY, transport=t).complete_json("s", "u")
    assert ei.value.status == 401 and KEY not in str(ei.value) and "無效" in str(ei.value) and len(t.calls) == 1


def test_anthropic_400_is_fatal_not_retried():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    t = fake_transport([(400, {}, {"type": "error", "error": {"type": "invalid_request_error", "message": "x"}})])
    with pytest.raises(ProviderFatal) as ei:
        AnthropicApiProvider(KEY, transport=t).complete_json("s", "u")
    assert ei.value.status == 400 and len(t.calls) == 1


def test_exhausted_retries_are_fatal_with_exact_attempt_count():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    err = (503, {}, {"type": "error", "error": {"type": "overloaded_error", "message": "x"}})
    t = fake_transport([err] * 10)
    p = AnthropicApiProvider(KEY, transport=t)
    p._sleep = lambda s: None
    with pytest.raises(ProviderFatal):
        p.complete_json("s", "u")
    assert len(t.calls) == 4


def test_retry_after_beyond_budget_gives_up_without_sleeping():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    t = fake_transport([(429, {"retry-after": "600"}, {"type": "error", "error": {"type": "rate_limit_error", "message": "x"}})])
    p = AnthropicApiProvider(KEY, transport=t)
    slept = []
    p._sleep = slept.append
    with pytest.raises(ProviderFatal):
        p.complete_json("s", "u")
    assert slept == [] and len(t.calls) == 1


def test_transport_error_is_retried_then_fatal_and_scrubbed():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal, TransportError
    t = fake_transport([TransportError("dns " + KEY)] * 10)
    p = AnthropicApiProvider(KEY, transport=t)
    p._sleep = lambda s: None
    with pytest.raises(ProviderFatal) as ei:
        p.complete_json("s", "u")
    assert KEY not in str(ei.value) and len(t.calls) == 4


def test_error_messages_never_contain_key():
    from pipeline.llm import AnthropicApiProvider
    for b in [(400, {}, {"error": {"message": "x " + KEY}}), (500, {}, {"error": {"message": KEY}}), (403, {}, {"error": {"message": KEY}}), (302, {"location": "http://evil/"}, {})]:
        t = fake_transport([b] * 10)
        p = AnthropicApiProvider(KEY, transport=t)
        p._sleep = lambda s: None
        with pytest.raises(ProviderError) as ei:
            p.complete_json("s", "u")
        assert KEY not in str(ei.value)


def test_urllib_transport_refuses_redirects(monkeypatch):
    import io
    import urllib.error
    import urllib.request
    from pipeline.llm import urllib_transport
    built = {}

    class Opener:
        def open(self, req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 302, "Found", {"location": "http://evil/"}, io.BytesIO(b""))

    def build_opener(*handlers):
        built["handlers"] = handlers
        return Opener()
    monkeypatch.setattr(urllib.request, "build_opener", build_opener)
    status, headers, body = urllib_transport("GET", "https://api.anthropic.com/v1/models", {"x-api-key": KEY}, None, 5)
    assert status == 302 and headers["location"] == "http://evil/" and body == b""
    hs = [h for h in built["handlers"] if isinstance(h, urllib.request.HTTPRedirectHandler)]
    assert len(hs) == 1 and type(hs[0]) is not urllib.request.HTTPRedirectHandler
    req = urllib.request.Request("https://api.anthropic.com/v1/models")
    assert hs[0].redirect_request(req, None, 302, "Found", {}, "http://evil/") is None


def test_usage_sink_called_in_order_and_thread_safe():
    import threading
    from pipeline.llm import AnthropicApiProvider
    seen = []
    t = fake_transport([anth_ok({"a": 1})] * 8)
    p = AnthropicApiProvider(KEY, transport=t)
    p.usage_sink = seen.append
    ths = [threading.Thread(target=lambda i=i: p.complete_json("s", f"u{i}")) for i in range(8)]
    [th.start() for th in ths]
    [th.join() for th in ths]
    assert p.usage["input"] == 80 and [s["input"] for s in seen] == [10 * i for i in range(1, 9)]


def test_anthropic_schema_strips_unsupported_keywords():
    from pipeline.intro import INTRO_SCHEMA
    from pipeline.llm import anthropic_schema
    s = anthropic_schema(INTRO_SCHEMA)
    assert "maxItems" not in s["properties"]["lines"] and s["properties"]["lines"]["minItems"] == 1 and s["additionalProperties"] is False


def test_anthropic_list_models_filters_claude_single_attempt():
    from pipeline.llm import AnthropicApiProvider, ProviderFatal
    t = fake_transport([(200, {}, {"data": [{"id": "claude-opus-5-5"}, {"id": "other"}, {"id": "claude-haiku-5-5"}], "has_more": False})])
    assert AnthropicApiProvider.list_models(KEY, t) == ["claude-opus-5-5", "claude-haiku-5-5"]
    assert t.calls[0][1].startswith("https://api.anthropic.com/v1/models?limit=1000") and t.calls[0][4] == 20
    t2 = fake_transport([(503, {}, {"error": {"message": "x"}})] * 5)
    with pytest.raises(ProviderFatal):
        AnthropicApiProvider.list_models(KEY, t2)
    assert len(t2.calls) == 1


def test_claude_cli_collects_usage_and_scrubs_stderr(monkeypatch):
    install(monkeypatch, [ok({"is_error": False, "result": '{"a": 1}', "usage": {"input_tokens": 7, "output_tokens": 3}})])
    p = ClaudeCliProvider()
    p.complete_json("s", "u")
    assert p.usage == {"input": 7, "cacheRead": 0, "cacheWrite": 0, "output": 3}
    bad = types.SimpleNamespace(returncode=1, stdout="", stderr="leak sk-ant-api03-ABCDEFGH12 x")
    install(monkeypatch, [bad, bad])
    with pytest.raises(ProviderError) as ei:
        ClaudeCliProvider().complete_json("s", "u")
    assert "ABCDEFGH12" not in str(ei.value)
```

`tests/test_segment.py` 加（用檔內既有的 `mk`）：
```python
def test_fatal_provider_error_propagates_through_make_cues():
    from pipeline.llm import ProviderFatal
    with pytest.raises(ProviderFatal):
        make_cues(mk(20), (0, 19), FakeProvider([ProviderFatal("API key 無效或沒有權限", 401)]))
```
`tests/test_vocab.py` 加（用檔內既有的 `CUES`、`WORDS`；檔頂補 `import pytest`）：
```python
def test_fatal_provider_error_propagates_through_pick_vocab():
    from pipeline.llm import ProviderFatal
    with pytest.raises(ProviderFatal):
        pick_vocab(CUES, WORDS, FakeProvider([ProviderFatal("API key 無效或沒有權限", 401)]))
```
`tests/test_intro.py` 加（檔頂補 `import pytest`；要改的 `except ProviderError` 在 `intro.py` 的 `_ask` 裡，不在 `make_intro` 本體）：
```python
def test_fatal_provider_error_propagates_through_make_intro():
    from pipeline.llm import FakeProvider, ProviderFatal
    from pipeline.intro import make_intro
    with pytest.raises(ProviderFatal):
        make_intro({"title": "t", "channel": "c", "duration": 10}, [{"a": 0, "b": 1, "en": "hi there", "zh": "嗨"}], FakeProvider([ProviderFatal("API key 無效或沒有權限", 401)]))
```

- [ ] **Step 2:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_llm.py tests/test_segment.py tests/test_vocab.py tests/test_intro.py` → 新測試 FAIL（ImportError 在函式內），既有 PASS
- [ ] **Step 3: 實作**
- [ ] **Step 4:** Run `~/.local/bin/uv run --with pytest pytest -q` → PASS
- [ ] **Step 5: Commit** `git add pipeline/llm.py pipeline/segment.py pipeline/vocab.py pipeline/intro.py tests/test_llm.py tests/test_segment.py tests/test_vocab.py tests/test_intro.py && git -c commit.gpgsign=false commit -m "feat(llm): HTTP provider base (no redirects, bounded retries, scrubbing), ProviderFatal, AnthropicApiProvider"`

---

### Task 5: `OpenAiApiProvider`

**Files:** Modify `pipeline/llm.py`；Test `tests/test_llm.py`。

**Interfaces（Produces）:** `class OpenAiApiProvider(_HttpProvider)`：`name = "openai-api"`、`default_timeout = 300.0`、`BASE = "https://api.openai.com"`、`MAX_OUTPUT_TOKENS = 16000`、`QUOTA_CODES = ("credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "insufficient_quota")`。
- `effort` 原樣存、原樣送；`effortSent` 初值相同；`_call` 捕到 `ProviderFatal` 且 `e.status == 400`、訊息（lower）含 `effort` 或 `reasoning`、`self.effortSent in ("xhigh", "max")` → `effortSent = "high"` 後重送一次（只此一次，之後都用 `effortSent`）。
- `_cache_fields` 加 `"provider": "openai"`（`effort` 是設定值）。
- `_call`：`POST /v1/responses`，headers `authorization: Bearer <key>`、`content-type`、`user-agent`；body `{"model", "instructions": system, "input": user, "max_output_tokens": 16000, "store": False}` ＋ `text: {"format": {"type": "json_schema", "name": "ytlearn", "schema": strict_schema(schema), "strict": True}}`（schema 非 None）＋ `reasoning: {"effort": self.effortSent}`（有設）；不送 `temperature`。回應：**先 `record_usage`**；`status == "incomplete"` → `_Failure("回覆不完整：" + reason)`；`output[]` 中 `type == "message"` 的 `content[]`：`refusal` → `_Failure("模型拒答")`，`output_text` 串接 → `_parse_object`。
- usage：`cached = input_tokens_details.cached_tokens`、`cw = input_tokens_details.cache_write_tokens`（缺 0）；`input = max(0, input_tokens - cached - cw)`（註解：假設 cache write 含在 `input_tokens` 內，官方文件未證實）、`cacheRead = cached`、`cacheWrite = cw`、`output = output_tokens`。
- 429 且 `error.code in QUOTA_CODES` 或 `error.type == "insufficient_quota"` → 不重試，`ProviderFatal("OpenAI 額度或花費上限已到", 429)`。
- `@staticmethod list_models(api_key, transport=urllib_transport)`：`GET /v1/models`，`attempts=1`、`timeout=20`；保留 `^(gpt-[56]|o[34])` 且不含 `realtime|audio|image|tts|transcribe|embedding|moderation|search|instruct|codex|pro` 的 id，依 `created` 新到舊。

- [ ] **Step 1: 寫失敗測試（加到 `tests/test_llm.py`）**

```python
OKEY = "sk-openai-test-0123456789"


def oa_ok(obj, status="completed", refusal=None):
    content = [{"type": "refusal", "refusal": refusal}] if refusal else [{"type": "output_text", "text": json.dumps(obj)}]
    return (200, {}, {"status": status, "incomplete_details": None if status == "completed" else {"reason": "max_output_tokens"},
                      "output": [{"type": "reasoning", "summary": []}, {"type": "message", "content": content}],
                      "usage": {"input_tokens": 12, "input_tokens_details": {"cached_tokens": 4, "cache_write_tokens": 2},
                                "output_tokens": 6, "output_tokens_details": {"reasoning_tokens": 2}}})


def test_openai_request_shape_and_usage():
    from pipeline.llm import OpenAiApiProvider
    t = fake_transport([oa_ok({"a": 1})])
    p = OpenAiApiProvider(OKEY, model="gpt-6-astra", effort="xhigh", transport=t)
    assert p.complete_json("sys", "usr", {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]}) == {"a": 1}
    method, url, headers, body, timeout = t.calls[0]
    assert (method, url, timeout) == ("POST", "https://api.openai.com/v1/responses", 300.0)
    assert headers["authorization"] == "Bearer " + OKEY
    assert body["instructions"] == "sys" and body["input"] == "usr" and body["store"] is False and body["max_output_tokens"] == 16000
    assert body["text"]["format"]["strict"] is True and body["text"]["format"]["schema"]["additionalProperties"] is False
    assert body["reasoning"] == {"effort": "xhigh"} and "temperature" not in body
    assert p.usage == {"input": 6, "cacheRead": 4, "cacheWrite": 2, "output": 6} and p.effortSent == "xhigh"


def test_openai_effort_400_falls_back_to_high_once():
    from pipeline.llm import OpenAiApiProvider
    t = fake_transport([(400, {}, {"error": {"type": "invalid_request_error", "message": "Unsupported reasoning effort"}}), oa_ok({"a": 1}), oa_ok({"a": 2})])
    p = OpenAiApiProvider(OKEY, model="m", effort="max", transport=t)
    assert p.complete_json("s", "u") == {"a": 1} and t.calls[1][3]["reasoning"] == {"effort": "high"} and p.effortSent == "high"
    assert p.complete_json("s", "u2") == {"a": 2} and t.calls[2][3]["reasoning"] == {"effort": "high"} and len(t.calls) == 3


def test_openai_cache_key_uses_requested_effort_and_provider(tmp_path):
    from pipeline.llm import OpenAiApiProvider
    p = OpenAiApiProvider(OKEY, model="m", effort="max", cache_dir=tmp_path, transport=fake_transport([]))
    f = p._cache_fields("s", "u", None)
    assert f["provider"] == "openai" and f["effort"] == "max"


def test_openai_incomplete_and_refusal_fail_but_bill():
    from pipeline.llm import OpenAiApiProvider
    t = fake_transport([oa_ok({"a": 1}, status="incomplete"), oa_ok({"a": 1}, refusal="no")])
    p = OpenAiApiProvider(OKEY, transport=t)
    with pytest.raises(ProviderError):
        p.complete_json("s", "u")
    assert p.usage["output"] == 12 and len(t.calls) == 2


def test_openai_quota_429_is_fatal_not_retried():
    from pipeline.llm import OpenAiApiProvider, ProviderFatal
    t = fake_transport([(429, {}, {"error": {"type": "insufficient_quota", "code": "insufficient_quota", "message": "x"}})])
    with pytest.raises(ProviderFatal) as ei:
        OpenAiApiProvider(OKEY, transport=t).complete_json("s", "u")
    assert len(t.calls) == 1 and "額度" in str(ei.value) and ei.value.status == 429


def test_openai_list_models_filters_and_sorts():
    from pipeline.llm import OpenAiApiProvider
    data = [{"id": "gpt-5-mini", "created": 1}, {"id": "gpt-6-astra", "created": 3}, {"id": "gpt-4o-realtime", "created": 5},
            {"id": "text-embedding-3", "created": 9}, {"id": "o3", "created": 2}, {"id": "gpt-image-1", "created": 8}, {"id": "gpt-5.5-pro", "created": 7}]
    t = fake_transport([(200, {}, {"object": "list", "data": data})])
    assert OpenAiApiProvider.list_models(OKEY, t) == ["gpt-6-astra", "o3", "gpt-5-mini"] and t.calls[0][4] == 20
```

- [ ] **Step 2:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_llm.py -k openai` → FAIL
- [ ] **Step 3: 實作**
- [ ] **Step 4:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_llm.py` → PASS
- [ ] **Step 5: Commit** `git add pipeline/llm.py tests/test_llm.py && git -c commit.gpgsign=false commit -m "feat(llm): OpenAiApiProvider on the Responses API with strict JSON schema output"`

---

### Task 6: build.py 接上新 Provider；用量快照檔；lesson 欄位；致命錯誤停下

**Files:** Modify `pipeline/build.py`（`build_lesson`、`PROVIDERS`、`_default_provider`、`progress_writer`、`main`）、`pipeline/schema.py`（`validate_lesson` 若對頂層未知鍵嚴格，放行 `provider`、`modelId`、`usage`、`costUsd`、`priceDate`、`effortSent`）、`tests/fixtures/stub_build.py`（見 Task 7）；Test `tests/test_build.py`。

**Interfaces（Produces）:**
- `PROVIDERS = {"claude-cli": ClaudeCliProvider, "codex-cli": CodexCliProvider, "anthropic-api": AnthropicApiProvider, "openai-api": OpenAiApiProvider}`；`canon_provider(name) -> str`；`--provider` 的 `choices` 含四個正名與別名 `claude`／`codex`；`YTLEARN_PROVIDER` 同樣經 `canon_provider`。`provider_factory` 的呼叫慣例**維持現狀**：`claude-cli` 只用兩個位置參數 `(model, cache_dir, **extra)`（既有的 `lambda m, c:` factory 照樣能用）；其他來源才傳第三個位置參數，且傳的是**正名**（`codex-cli`／`anthropic-api`／`openai-api`）。
- `_default_provider(model, cache_dir, provider="claude-cli", effort=None, api_key=None)`：API 類別以 `api_key` 為第一個位置參數。
- `main`：`anthropic-api` 讀 `ANTHROPIC_API_KEY`、`openai-api` 讀 `OPENAI_API_KEY`，缺 → `error: 缺少 <VAR>（請在設定頁貼上 API key）` 回 1；`openai-api` 沒 `--model` 也沒 `YTLEARN_MODEL` → `error: openai-api 需要 --model 或 YTLEARN_MODEL` 回 1；`settings:` 列印 `provider=<正名>`。`model_label`：`anthropic-api` 裸名、`openai-api` `openai:<model>`、codex 同現狀；`model_id`（計價用裸名）：claude／anthropic 為 `args.model`，openai 為 `args.model`，codex 為 `provider.model`。
- `--usage-file`／`YTLEARN_USAGE_FILE`：`usage_writer(path, model_id) -> Callable[[dict], None]`，每次被呼叫原子寫 `{"usage", "costUsd": cost.cost_usd(model_id, u), "modelId", "pid": os.getpid(), "ts"}`；`main` 設 `provider.usage_sink = usage_writer(...)`（provider 沒有 `usage_sink` 屬性就略過）。progress 檔格式不變。
- `build_lesson(..., provider_name="claude-cli", model_id=None)`：lesson 多 `provider`、`modelId`、`usage`（`getattr(provider, "usage", zero_usage())` 快照）、`costUsd`、`priceDate`、`effortSent`（`getattr(provider, "effortSent", effort)`）；`stats` 多 `usage`、`costUsd`。
- `ProviderFatal`：`build_lesson` 讓它穿透（切句 executor 收到後對其餘 futures `cancel()`、不再送新呼叫）；`main` 接到 → `print(f"error: {e}", file=sys.stderr)`，回 3。
- 結束列印多 `usage=in:<n>/cr:<n>/cw:<n>/out:<n> cost_usd=<x|unknown>`。

- [ ] **Step 1: 遷移既有測試**（逐條）：
  - `test_build_with_fake_provider_matches_schema`：`stats == {...}` 改成逐鍵比對四個舊鍵。
  - `_spy_factory` 的預設參數改 `provider="claude-cli"`；`test_provider_flag_defaults_to_claude_and_switches_to_codex` 的 `seen` 期望改成 `"claude-cli"`／`"codex-cli"`。
  - `tests/test_build.py` 第 267 行附近斷言 stdout 含 `"settings: provider=claude "` 的，改成 `provider=claude-cli`。
  - `tests/test_build.py` 第 292 行附近 `seen == {"model": None, "provider": "codex", ...}` 改成 `"codex-cli"`。
  - `test_golden.py` 若比對 lesson 全文，更新 golden 或忽略新欄位（commit 訊息說明）。
- [ ] **Step 2: 寫失敗測試（加到 `tests/test_build.py`）**

```python
def _raw(tmp_path):
    (tmp_path / "raw").mkdir(exist_ok=True)
    (tmp_path / "raw" / "puh91fohvTA.json").write_text(json.dumps(load("raw_small.json")), "utf-8")


class RecordingFake(FakeProvider):
    """FakeProvider that bills 100 input / 10 output per answer and counts calls made after a fatal error."""
    def __init__(self, responses):
        super().__init__(responses)
        self.fatal_seen = False
        self.calls_after_fatal = 0

    def complete_json(self, system, user, schema=None):
        if self.fatal_seen:
            self.calls_after_fatal += 1
        r = self.responses[0] if self.responses else None
        if isinstance(r, Exception):
            self.fatal_seen = True
            self.responses.pop(0)
            raise r
        out = super().complete_json(system, user, schema)
        self.record_usage({"input": 100, "cacheRead": 0, "cacheWrite": 0, "output": 10})
        return out


def test_main_openai_api_requires_key_and_model(tmp_path, monkeypatch, capsys):
    _raw(tmp_path)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert main(["puh91fohvTA", "--provider", "openai-api", "--model", "gpt-6-astra"], data_dir=tmp_path) == 1
    assert "OPENAI_API_KEY" in capsys.readouterr().err
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x-0123456789")
    monkeypatch.delenv("YTLEARN_MODEL", raising=False)
    assert main(["puh91fohvTA", "--provider", "openai-api"], data_dir=tmp_path) == 1
    assert "--model" in capsys.readouterr().err


def test_main_alias_claude_is_canonicalised(tmp_path, capsys):
    _raw(tmp_path)
    seen = {}
    assert main(["puh91fohvTA", "--provider", "claude"], data_dir=tmp_path, provider_factory=_spy_factory(seen)) == 0
    assert seen["provider"] == "claude-cli" and "provider=claude-cli" in capsys.readouterr().out


def test_lesson_records_provider_usage_and_cost(tmp_path):
    from pipeline import cost
    _raw(tmp_path)
    fp = RecordingFake(fake_provider().responses)
    assert main(["puh91fohvTA", "--model", "claude-sonnet-5-5"], data_dir=tmp_path, provider_factory=lambda *a, **k: fp) == 0
    lesson = json.loads((tmp_path / "lessons" / "puh91fohvTA.json").read_text("utf-8"))
    assert lesson["provider"] == "claude-cli" and lesson["modelId"] == "claude-sonnet-5-5" and lesson["effortSent"] == "default"
    assert lesson["usage"] == {"input": 400, "cacheRead": 0, "cacheWrite": 0, "output": 40}
    assert lesson["costUsd"] == pytest.approx(cost.cost_usd("claude-sonnet-5-5", lesson["usage"])) and lesson["priceDate"] == "2026-11-04"


def test_usage_file_holds_final_snapshot(tmp_path):
    _raw(tmp_path)
    uf = tmp_path / "u.json"
    fp = RecordingFake(fake_provider().responses)
    assert main(["puh91fohvTA", "--usage-file", str(uf), "--model", "claude-sonnet-5-5"], data_dir=tmp_path, provider_factory=lambda *a, **k: fp) == 0
    d = json.loads(uf.read_text("utf-8"))
    assert d["usage"]["input"] == 400 and d["modelId"] == "claude-sonnet-5-5" and d["costUsd"] > 0 and d["ts"] and d["pid"] == os.getpid()


def test_fatal_provider_error_stops_build_and_keeps_usage(tmp_path, capsys):
    from pipeline.llm import ProviderFatal
    _raw(tmp_path)
    r = fake_provider().responses
    fp = RecordingFake([r[0], ProviderFatal("API key 無效或沒有權限", 401), r[2], r[3]])
    uf = tmp_path / "u.json"
    assert main(["puh91fohvTA", "--usage-file", str(uf), "--model", "claude-sonnet-5-5"], data_dir=tmp_path, provider_factory=lambda *a, **k: fp) == 3
    assert "無效" in capsys.readouterr().err
    assert not (tmp_path / "lessons" / "puh91fohvTA.json").exists()
    assert json.loads(uf.read_text("utf-8"))["usage"]["input"] == 100
    assert fp.calls_after_fatal == 0
```

- [ ] **Step 3:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_build.py` → 新測試 FAIL（`tests/test_build.py` 頂部補 `import os`）
- [ ] **Step 4: 實作**
- [ ] **Step 5:** Run `~/.local/bin/uv run --with pytest pytest -q` → PASS
- [ ] **Step 6: Commit** `git add pipeline/build.py pipeline/schema.py pipeline/llm.py tests/test_build.py tests/test_golden.py && git -c commit.gpgsign=false commit -m "feat(build): api providers, usage snapshot file, cost in lesson, fatal errors stop the build"`

---

### Task 7: 帳本 `pipeline/usage.py` 與 jobs.py：鎖內預算閘、核准旗標、用量回收、孤兒檔

**Files:** Create `pipeline/usage.py`；Modify `pipeline/jobs.py`（`JobStore._new`、`to_public`、`add`、`fail`、`finish`；`BuildQueue.__init__`、`_finish`、`progress`、`_run`）、`tests/fixtures/stub_build.py`；Test `tests/test_usage.py`、`tests/test_jobs.py`。

**Interfaces（Consumes）:** Task 2 `settings`、Task 3 `keys`、Task 6 的用量快照檔格式。

**Interfaces（Produces）:**
- `usage.path_for(root)`（`data/usage.jsonl`）；`usage.append(root, row)`（`ts` 缺時補 `datetime.now().astimezone().isoformat(timespec="seconds")`）；`usage.month_totals(root, now=None) -> {"month", "apiUsd", "cliUsd", "byProvider": {name: {"usd", "rows"}}, "rows"}`（月份比對 `ts[:7]`；`costUsd` None 當 0；壞行跳過）。
- `class BudgetBlocked(Exception)`：屬性 `info: dict`（`{"error", "code": "budget", "usage"}`）。
- `JobStore.add(vid, lesson_ok, gate=None, snapshot=None) -> dict`（**回傳型別不變**）：`gate: Callable[[], tuple[dict | None, str | None]]`，只在**鎖內、真的要建立新 attempt 的三個分支**（新 job 且非 lesson_ok；capturing 逾時 → 重排；error／done → 重排）呼叫；`blocked` 非 None → 在任何狀態變更**之前**（包括逾時那個 `_set(job, "error")`）`raise BudgetBlocked(blocked)`；否則建立新 attempt 並 `job["settings"] = snapshot`、`job["approved"] = True`、`job["warning"] = warning`（None 就移除）。**`gate=None` 視為通過，照樣 `approved = True`**（既有測試與 `/add` 以外的呼叫都不帶 gate）。lesson_ok 且沒 job（→ done）**不**過閘。
- `JobStore.approve(vid, snapshot, warning=None)`：設同三個欄位；`JobStore.needs_approval(vid) -> bool`（job 存在且 `not job.get("approved")`）。**`fail`（capturing → error）與 `finish(ok=False)` 都把 `approved` 設 False**。
- `JobStore.fail_captured(vid, message)`：captured → error（給 `/ingest` 被閘擋時用）。
- `JobStore.finish(vid, ok, message, lesson_url=None, usage=None, cost_usd=None)`：存 `job["usage"]`／`job["costUsd"]`；`to_public`：`done`／`error` 時帶 `usage`、`costUsd`（有才帶）；`warning` 有就帶；`settings` 帶 `{"provider", "model"}`（有快照才帶）。
- 用量檔：每次 `_run` 產生 `run_id = uuid.uuid4().hex[:8]`，`BuildQueue.usage_path(vid, attempt, run_id)` = `<log_dir>/<vid>.<attempt>.<run_id>.usage.json`；`_run` 把 `(attempt, run_id)` 記在 `self._runs[vid]`；`read_usage(path) -> (usage | None, costUsd | None, modelId | None, pid | None)`。檔名解析用 `name.rsplit(".", 4)`（id 本身可含點：`udemy.<n>`、`hello.<path>`）。
- `BuildQueue.sweep_orphans()`：掃 `<log_dir>/*.usage.json`，對每個**不是目前 `self._runs` 裡那一個**的檔，**逐檔包在 `try/except Exception`**（壞檔、讀不出 pid、檔名解析失敗 → 跳過並 `print` 一行，絕不讓 server 起不來）：`pid` 是 int 且 `os.kill(pid, 0)` 沒丟 `ProcessLookupError`（還活著）→ **跳過、留著**；`pid` 缺或行程已死 → 先把內容讀進記憶體、**先刪檔、再** `usage.append(root, {"videoId", "provider": None, "model": modelId, "usage", "costUsd", "state": "orphan", "partial": True})`（兩步之間被殺頂多少記一列，不會重複記）。`__init__` 結尾與**每次 `_run` 開頭**都呼叫 `sweep_orphans()`（掃全部，重啟後才結束的孤兒也會在下一次任何產課前入帳）。
- `BuildQueue._run`：用 `job["settings"]` 快照；沒有快照（舊流程／測試直接 ingest）就 `snapshot = settings.resolve(settings.load(root), os.environ)`（順序維持「先讀設定再 `set_building`」）；env = `settings.apply_to_env(snapshot, env)` → `keys.env_for_build(root, env, snapshot["provider"])`，另加 `YTLEARN_USAGE_FILE = usage_path(vid, attempt, run_id)`。
- `progress(vid)`：多帶 `usage`、`costUsd`（來自目前 run 的 `read_usage`，有才帶）。
- `_finish`：`run = self._runs.pop(vid, None)`（沒有就跳過用量步驟）→ `read_usage`（成功時 lesson 檔有 `usage` 以 lesson 為準）→ **先 `store.finish(..., usage=..., cost_usd=...)`**（它丟 `IllegalTransition` 就不記帳）→ 刪 progress 與這個 run 的用量檔 → `usage.append(root, {"videoId", "provider": snapshot provider, "model": modelId or snapshot model, "usage", "costUsd", "state", "partial": not ok})`（先刪檔再記帳，與 sweep 同理）。`_tail` 文字先 `keys.scrub(text, keys.all_keys(root, os.environ))`。
- `tests/fixtures/stub_build.py` 新增三種 `STUB_MODE`：`usage`（寫 `YTLEARN_USAGE_FILE` 為 `{"usage": {"input": 5, "cacheRead": 0, "cacheWrite": 0, "output": 1}, "costUsd": 0.1, "modelId": "m", "pid": os.getpid(), "ts": "x"}`，再依 `STUB_EXIT`（預設 0）結束；exit 0 時照 `ok` 寫 lesson）、`slow_usage`（同 `slow`，但先寫同樣的用量檔再 sleep；**既有 `slow` 維持原狀**，所以 `tests/test_jobs.py`／`tests/test_server_jobs.py` 既有的三鍵 progress 全等比對不受影響）與 `dump`（`print("key " + os.environ.get("ANTHROPIC_API_KEY", ""))`，再把 `{"env": dict(os.environ), "argv": sys.argv}` 寫到 `STUB_DUMP` 指定的檔後 exit 1）。

- [ ] **Step 1: 遷移既有測試**：`tests/test_jobs.py` 與 `tests/test_server_jobs.py` 中 `s.add(V, False)` 的用法不變（回傳仍是 dict）；`at()` helper 不變；**`test_requeue_after_error_is_not_dropped` 裡換掉 `s.finish` 的函式改成 `def finish(vid, ok, msg, url=None, **kw): real(vid, ok, msg, url, **kw)`**（新的關鍵字參數要透傳）。
- [ ] **Step 2: 寫失敗測試**

`tests/test_usage.py`：
```python
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
```

`tests/test_jobs.py`（沿用 `_slow_queue`／`stub` 的手法；`SNAP = dict(provider="anthropic-api", model="claude-sonnet-5-5", effort="default", workers=1, budgetUsd=1.0)`）：
```python
def test_gate_runs_only_when_a_new_attempt_is_created():
    from pipeline.jobs import BudgetBlocked
    calls = []
    gate = lambda: (calls.append(1), (None, "w"))[1]
    s = JobStore()
    j = s.add(V, False, gate=gate, snapshot=SNAP)
    assert calls == [1] and j["settings"] == SNAP and j["approved"] is True and JobStore.to_public(j)["warning"] == "w"
    assert s.add(V, False, gate=gate, snapshot={"provider": "claude-cli"})["settings"] == SNAP and calls == [1]  # queued: no gate, snapshot kept
    assert JobStore().add(V, True, gate=gate) ["state"] == "done" and calls == [1]  # lesson_ok, no job: no gate
    blocked = lambda: ({"error": "over", "code": "budget"}, None)
    s2 = at("error")
    with pytest.raises(BudgetBlocked) as ei:
        s2.add(V, False, gate=blocked, snapshot=SNAP)
    assert ei.value.info["code"] == "budget" and s2.get(V)["state"] == "error" and s2.get(V)["attempt"] == 1


def test_stale_capturing_requeue_also_passes_the_gate():
    from pipeline.jobs import BudgetBlocked
    s = at("capturing")
    s._jobs[V]["updatedAt"] -= jobs.STALE_CAPTURE_SECONDS + 1  # same trick as the existing stale test; never patch time (add holds the lock)
    with pytest.raises(BudgetBlocked):
        s.add(V, False, gate=lambda: ({"error": "over", "code": "budget"}, None), snapshot=SNAP)
    assert s.get(V)["state"] == "capturing" and s.get(V)["attempt"] == 1  # blocked before any state change


def test_error_clears_approval():
    s = JobStore()
    s.add(V, False, gate=lambda: (None, None), snapshot=SNAP)
    assert s.needs_approval(V) is False
    s.claim(V)
    s.fail(V, 1, "x")
    assert s.needs_approval(V) is True
    s.ingested(V, None)  # error -> captured without /add
    assert s.needs_approval(V) is True
    s.approve(V, SNAP)
    assert s.needs_approval(V) is False
    s.set_building(V)
    s.finish(V, False, "boom")
    assert s.needs_approval(V) is True


def test_fail_captured():
    s = at("captured")
    s.fail_captured(V, "本月已達上限")
    assert s.get(V)["state"] == "error" and s.get(V)["message"] == "本月已達上限" and s.get(V)["failedIn"] == "captured"


def _usage_queue(tmp_path, monkeypatch, mode="usage", exit_code="0", **kw):
    stub = Path(__file__).parent / "fixtures" / "stub_build.py"
    (tmp_path / "pipeline").symlink_to(Path(jobs.__file__).parent)
    (tmp_path / "data" / "raw").mkdir(parents=True)
    (tmp_path / "data" / "raw" / f"{V}.json").write_text("{}")
    monkeypatch.setenv("STUB_MODE", mode)
    monkeypatch.setenv("STUB_EXIT", exit_code)
    s = JobStore()
    s.add(V, False, gate=lambda: (None, None), snapshot=SNAP)
    s.claim(V)
    s.ingested(V, 1)
    q = jobs.BuildQueue(s, tmp_path, cmd_factory=lambda v: [sys.executable, str(stub), v], **kw)
    return s, q


def test_ledger_row_written_on_success_and_failure(tmp_path, monkeypatch):
    from pipeline import usage
    s, q = _usage_queue(tmp_path, monkeypatch)
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "done")
        monkeypatch.setenv("STUB_EXIT", "1")
        s.add(V, False, gate=lambda: (None, None), snapshot=SNAP)  # done -> queued: a new attempt (2)
        s.claim(V)
        s.ingested(V, 2)
        q.enqueue(V)
        _wait(lambda: s.get(V)["state"] == "error")
    finally:
        q.shutdown()
    rows = [json.loads(l) for l in usage.path_for(tmp_path).read_text("utf-8").splitlines()]
    assert rows[0]["state"] == "done" and rows[0]["costUsd"] == 0.1 and rows[0]["provider"] == "anthropic-api" and rows[0]["partial"] is False
    assert rows[1]["state"] == "error" and rows[1]["usage"]["input"] == 5 and rows[1]["partial"] is True
    assert s.get(V)["attempt"] == 2 and not list((tmp_path / "data" / "jobs").glob("*.usage.json"))
    pub = JobStore.to_public(s.get(V))
    assert pub["usage"]["input"] == 5 and pub["costUsd"] == 0.1 and pub["settings"] == {"provider": "anthropic-api", "model": "claude-sonnet-5-5"}


def test_usage_survives_kill(tmp_path, monkeypatch):
    from pipeline import usage
    s, q = _usage_queue(tmp_path, monkeypatch, mode="slow_usage", timeout=1.5)
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "error")
    finally:
        q.shutdown()
    row = json.loads(usage.path_for(tmp_path).read_text("utf-8").splitlines()[0])
    assert row["usage"]["input"] == 5 and row["partial"] is True


def test_progress_exposes_usage_from_usage_file(tmp_path, monkeypatch):
    s, q = _usage_queue(tmp_path, monkeypatch, mode="slow_usage", timeout=5)
    q.enqueue(V)
    try:
        _wait(lambda: (q.progress(V) or {}).get("usage"))
        p = q.progress(V)
        assert p["phase"] == "segment" and p["usage"]["input"] == 5 and p["costUsd"] == 0.1
    finally:
        q.shutdown()


def test_orphan_usage_file_is_swept_only_when_its_process_is_gone(tmp_path, monkeypatch):
    import subprocess
    from pipeline import usage
    s, q = _usage_queue(tmp_path, monkeypatch)
    q.shutdown()
    q.log_dir.mkdir(parents=True, exist_ok=True)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        (q.log_dir / f"{V}.7.deadbeef.usage.json").write_text(json.dumps({"usage": {"input": 9, "cacheRead": 0, "cacheWrite": 0, "output": 0}, "costUsd": 0.3, "modelId": "m", "pid": child.pid, "ts": "x"}))
        q2 = jobs.BuildQueue(s, tmp_path)  # restart while the orphan build is still alive: leave it alone
        q2.shutdown()
        assert not usage.path_for(tmp_path).exists() and (q.log_dir / f"{V}.7.deadbeef.usage.json").exists()
    finally:
        child.kill()
        child.wait()
    (q.log_dir / "x.1.badbadba.usage.json").write_text("{not json")  # a corrupt file must never break startup
    q3 = jobs.BuildQueue(s, tmp_path)  # the process is gone now: record once and delete
    q3.shutdown()
    rows = [json.loads(l) for l in usage.path_for(tmp_path).read_text("utf-8").splitlines()]
    assert len(rows) == 1 and rows[0]["videoId"] == V and rows[0]["state"] == "orphan" and rows[0]["partial"] is True and rows[0]["costUsd"] == 0.3 and rows[0]["model"] == "m"
    assert not (q.log_dir / f"{V}.7.deadbeef.usage.json").exists() and (q.log_dir / "x.1.badbadba.usage.json").exists()


def test_run_uses_snapshot_and_injects_only_selected_key(tmp_path, monkeypatch):
    from pipeline import keys, settings as st
    keys.save(tmp_path, {"openai": "sk-openai-xyz7890", "anthropic": "sk-ant-abcdef1234"})
    monkeypatch.setenv("OPENAI_API_KEY", "sk-inherited-00000000")
    dump = tmp_path / "dump.json"
    monkeypatch.setenv("STUB_DUMP", str(dump))
    s, q = _usage_queue(tmp_path, monkeypatch, mode="dump")
    st.save(tmp_path, dict(st.DEFAULTS, provider="claude-cli"))  # changed after /add: must not matter
    q.enqueue(V)
    try:
        _wait(lambda: s.get(V)["state"] == "error")
    finally:
        q.shutdown()
    d = json.loads(dump.read_text("utf-8"))
    assert d["env"]["YTLEARN_PROVIDER"] == "anthropic-api" and d["env"]["ANTHROPIC_API_KEY"] == "sk-ant-abcdef1234"
    assert "OPENAI_API_KEY" not in d["env"] and re.fullmatch(rf".*/{re.escape(V)}\.1\.[0-9a-f]{{8}}\.usage\.json", d["env"]["YTLEARN_USAGE_FILE"])
    assert not any("sk-" in a for a in d["argv"])
    assert "sk-ant" not in s.get(V)["message"]  # the dump stub prints the key to stdout; _tail is scrubbed
```

- [ ] **Step 3:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_usage.py tests/test_jobs.py` → 新測試 FAIL
- [ ] **Step 4: 實作**（含 stub_build.py 的兩種新模式；`tests/test_jobs.py` 頂部補 `import re`）
- [ ] **Step 5:** Run `~/.local/bin/uv run --with pytest pytest -q` → PASS
- [ ] **Step 6: Commit** `git add pipeline/usage.py pipeline/jobs.py tests/fixtures/stub_build.py tests/test_usage.py tests/test_jobs.py && git -c commit.gpgsign=false commit -m "feat(jobs): budget gate in JobStore.add, approval flag, usage file recovery and orphan sweep, ledger"`

---

### Task 8: server：`/keys`、`/keys/test`、`/usage`、`/settings` 擴充、`/add` 與 `/ingest` 的預算閘

**Files:** Modify `server.py`（檔頭；`Handler` 類別屬性；`do_GET`；`do_POST`；`_get_settings`；`_post_settings`；`_add`；`_ingest`；`make_server`）；Test `tests/test_server.py`（keys／settings／usage）、`tests/test_server_jobs.py`（預算閘，因為它的 `env` fixture 已有 stub build）。

**Interfaces（Produces）:**
- `Handler.transport = staticmethod(llm.urllib_transport)`；`make_server(root, port=8765, transport=None)` 有給就 `staticmethod(transport)` 放進 `BoundHandler`；`make_server` 建好 `BuildQueue` 後其 `__init__` 已做孤兒回收。
- `_resolved(self) -> dict`：`settings.resolve(settings.load(root), os.environ, models=settings.load_models(root))`。
- `_budget(self) -> dict`：`{"provider", "budgetUsd", "apiUsd", "pct": int, "state": "none"|"ok"|"warn"|"over"}`（`pct = math.floor(apiUsd / budgetUsd * 100)`；`warn` 是 `pct >= 80`、`over` 是 `pct >= 100`；provider 不在 `API_PROVIDERS` 或 `budgetUsd` None → `none`）；`_gate(override) -> (blocked | None, warning | None)`：`over` 且非 override → `({"error": f"本月 API 費用已達上限 ${budget:.2f}（本機估算）", "code": "budget", "usage": totals}, None)`；`warn` → `(None, f"本月 API 費用已用 {pct}%（約 ${api:.2f}／${budget:.2f}，本機估算）")`。
- `GET /settings` → `{"settings", "keys": keys.public, "models": settings.load_models, "warning"?}`（`warning` 合併 `load` 的檔案警告與 `resolve` 的來源／模型不一致警告）。
- `POST /settings` → `settings.normalize(obj, models=load_models(root))`；provider 在 `API_PROVIDERS` 且 `keys.resolve` 無該家 key → 400 `["請先貼上 Anthropic 的 API key"]`／`["請先貼上 OpenAI 的 API key"]`。
- `GET /keys` → `keys.public`。`POST /keys` `{"anthropic"?: str, "openai"?: str}` → `keys.save` → `{"ok": true, "keys": public}`（非字串 400）。
- `POST /keys/test` `{"provider": "anthropic"|"openai", "key"?: str}` → `list_models(key, self.transport)`；成功：有給 `key` 就 `keys.save`、`settings.save_models`，回 `{"ok": true, "models", "keys"}`；`ProviderError`／`TransportError` → 400 `{"ok": false, "error": scrub(msg)}`；沒 key → 400「請先貼上 API key」。
- `GET /usage` → `usage.month_totals(root)` ＋ `budgetUsd`、`budgetState`、`pct`。
- `POST /add`：`resolved = self._resolved()`；`resolved` 帶 `warning`（來源與模型不一致）→ 400 `{"ok": false, "errors": [warning + "，請到設定頁重新儲存"]}`；`try: job = self.jobs.add(vid, lesson_ok, gate=lambda: self._gate(obj.get("override") is True), snapshot=resolved) except BudgetBlocked as e: return self._json({"ok": False, **e.info}, 402)`；回 `{"job": pub, "warning"?: job.get("warning")}`。
- `POST /ingest`：`enqueue` 為 True 且 `jobs.needs_approval(vid)` → `resolved = self._resolved()`；`resolved` 帶 `warning` → 寫 raw 後 `jobs.fail_captured(vid, warning + "，請到設定頁重新儲存")`，回 400，不 enqueue；否則 `blocked, warning = self._gate(False)`；`blocked` → 寫 raw 後 `jobs.fail_captured(vid, blocked["error"])`，回 402 `{"ok": false, **blocked, "job": pub}`，**不** enqueue；否則 `jobs.approve(vid, resolved, warning)` 再 enqueue。
- `POST /keys/test` 請求沒帶 `key` 時用 `keys.resolve` 解析到的 key（檔案或環境變數）；兩者都沒有才 400。

- [ ] **Step 0: 遷移既有測試**：`tests/test_server.py` 第 136、150 行附近 `json.loads(body) == {"settings": ...}` 的全等比對改成只比對 `["settings"]`（`GET /settings` 現在多回 `keys`、`models`）。
- [ ] **Step 1: 寫失敗測試**

`tests/test_server.py`（fixtures 改寫如下；`req` 不變）：
```python
MODELS_BODY = json.dumps({"data": [{"id": "gpt-6-astra", "created": 2}, {"id": "gpt-5-mini", "created": 1}, {"id": "claude-opus-5-5", "created": 3}]}).encode()
E401 = json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "bad"}}).encode()


def _serve(tmp_path, transport):
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("hi")
    srv = server.make_server(tmp_path, 0, transport=transport)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()
        t.join()


def _no_network(method, url, headers, body, timeout):
    raise AssertionError("no network in tests")


@pytest.fixture(autouse=True)
def _no_inherited_keys(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


@pytest.fixture
def base(tmp_path):
    yield from _serve(tmp_path, _no_network)


@pytest.fixture
def base_with_models(tmp_path):
    yield from _serve(tmp_path, lambda m, u, h, b, t: (200, {}, MODELS_BODY))


@pytest.fixture
def base_401(tmp_path):
    yield from _serve(tmp_path, lambda m, u, h, b, t: (401, {}, E401))


def test_lessons_list_carries_cost(base, tmp_path):
    from tests.test_build import load
    d = tmp_path / "data" / "lessons"
    d.mkdir(parents=True)
    a = dict(load("lesson_min.json"), videoId="aaaaaaaaaaa", costUsd=0.5, provider="openai-api")
    b = dict(load("lesson_min.json"), videoId="bbbbbbbbbbb")
    (d / "aaaaaaaaaaa.json").write_text(json.dumps(a), "utf-8")
    (d / "bbbbbbbbbbb.json").write_text(json.dumps(b), "utf-8")
    rows = {r["videoId"]: r for r in json.loads(req(base + "/lessons")[1])}
    assert rows["aaaaaaaaaaa"]["costUsd"] == 0.5 and rows["aaaaaaaaaaa"]["provider"] == "openai-api"
    assert "costUsd" not in rows["bbbbbbbbbbb"] and "provider" not in rows["bbbbbbbbbbb"]


def test_get_settings_includes_masked_keys_and_models(base, tmp_path):
    from pipeline import keys
    keys.save(tmp_path, {"anthropic": "sk-ant-00001234"})
    code, body, _ = req(base + "/settings")
    out = json.loads(body)
    assert out["keys"]["anthropic"] == {"set": True, "tail": "1234", "source": "file"} and out["models"] == {}
    assert "sk-ant" not in body.decode()


def test_post_settings_api_provider_requires_key(base, tmp_path):
    from pipeline import keys
    s = dict(settings.DEFAULTS, provider="anthropic-api")
    code, body, _ = req(base + "/settings", json.dumps(s).encode(), "POST")
    assert code == 400 and "Anthropic" in json.loads(body)["errors"][0]
    keys.save(tmp_path, {"anthropic": "sk-ant-00001234"})
    assert req(base + "/settings", json.dumps(s).encode(), "POST")[0] == 200


def test_post_keys_saves_and_masks(base, tmp_path):
    code, body, _ = req(base + "/keys", json.dumps({"openai": "sk-openai-xyz7890"}).encode(), "POST")
    assert code == 200 and json.loads(body)["keys"]["openai"]["tail"] == "7890"
    assert req(base + "/keys", json.dumps({"openai": 5}).encode(), "POST")[0] == 400


def test_keys_test_saves_key_on_success(base_with_models, tmp_path):
    from pipeline import keys
    code, body, _ = req(base_with_models + "/keys/test", json.dumps({"provider": "openai", "key": "sk-openai-xyz7890"}).encode(), "POST")
    out = json.loads(body)
    assert code == 200 and out["models"] == ["gpt-6-astra", "gpt-5-mini"]
    assert keys.load(tmp_path)["openai"] == "sk-openai-xyz7890" and settings.load_models(tmp_path)["openai"] == out["models"]


def test_keys_test_401_reports_without_key(base_401, tmp_path):
    from pipeline import keys
    code, body, _ = req(base_401 + "/keys/test", json.dumps({"provider": "anthropic", "key": "sk-ant-bad-0000"}).encode(), "POST")
    assert code == 400 and "無效" in json.loads(body)["error"] and "sk-ant-bad" not in body.decode() and keys.load(tmp_path) == {}


def test_keys_test_without_key_400(base):
    assert req(base + "/keys/test", json.dumps({"provider": "anthropic"}).encode(), "POST")[0] == 400


def test_usage_endpoint_states(base, tmp_path):
    from pipeline import keys, usage
    keys.save(tmp_path, {"anthropic": "sk-ant-00001234"})
    settings.save(tmp_path, dict(settings.DEFAULTS, provider="anthropic-api", budgetUsd=1.0))
    usage.append(tmp_path, {"videoId": "a", "provider": "anthropic-api", "model": "m", "usage": {}, "costUsd": 0.85, "state": "done"})
    out = json.loads(req(base + "/usage")[1])
    assert out["budgetUsd"] == 1.0 and out["budgetState"] == "warn" and out["apiUsd"] == 0.85 and out["pct"] == 85
```

`tests/test_server_jobs.py`（用既有 `env` fixture，並在該 fixture 裡 `monkeypatch.delenv` 兩把 key；檔頂補 `from pipeline import settings`；`ADD = {"url": "https://www.youtube.com/watch?v=" + V}`；該檔的 `req` 回 `(code, json)`）：
```python
def _api_budget(root, spent, budget=1.0, provider="anthropic-api", model="claude-sonnet-5-5"):
    from pipeline import keys, usage
    keys.save(root, {"anthropic": "sk-ant-00001234", "openai": "sk-openai-xyz7890"})
    if provider == "openai-api":
        settings.save_models(root, "openai", [model])
    settings.save(root, dict(settings.DEFAULTS, provider=provider, model=model, budgetUsd=budget))
    usage.append(root, {"videoId": "z", "provider": provider, "model": model, "usage": {}, "costUsd": spent, "state": "done"})


def test_add_402_when_over_budget_and_override(env):
    base, root = env
    _api_budget(root, 1.2)
    code, body = req(base + "/add", ADD)
    assert code == 402 and body["code"] == "budget" and req(base + "/jobs/" + V)[0] == 404
    code, body = req(base + "/add", dict(ADD, override=True))
    assert code == 200 and body["job"]["state"] == "queued" and body["job"]["settings"] == {"provider": "anthropic-api", "model": "claude-sonnet-5-5"}


def test_override_then_extension_readd_is_not_blocked(env):
    base, root = env
    _api_budget(root, 1.2)
    req(base + "/add", dict(ADD, override=True))
    code, body = req(base + "/add", ADD)
    assert code == 200 and body["job"]["state"] == "queued" and body["job"]["attempt"] == 1


def test_done_lesson_is_not_gated(env):
    base, root = env
    _api_budget(root, 1.2)
    (root / "data" / "lessons").mkdir(parents=True)
    lesson = json.loads(STUB.with_name("lesson_min.json").read_text("utf-8")); lesson["videoId"] = V
    (root / "data" / "lessons" / f"{V}.json").write_text(json.dumps(lesson), "utf-8")
    code, body = req(base + "/add", ADD)
    assert code == 200 and body["job"]["state"] == "done"


def test_add_warning_at_80_percent(env):
    base, root = env
    _api_budget(root, 0.8, provider="openai-api", model="gpt-6-astra")
    code, body = req(base + "/add", ADD)
    assert code == 200 and "80%" in body["warning"] and body["job"]["warning"] == body["warning"]


def test_add_ignores_budget_for_cli_provider(env):
    base, root = env
    from pipeline import usage
    settings.save(root, dict(settings.DEFAULTS, budgetUsd=1.0))
    usage.append(root, {"videoId": "z", "provider": "anthropic-api", "model": "m", "usage": {}, "costUsd": 5, "state": "done"})
    assert req(base + "/add", ADD)[0] == 200


def test_reingest_after_error_passes_the_gate(env):
    base, root = env
    _api_budget(root, 0.0)
    req(base + "/add", ADD)
    req(base + "/jobs/" + V + "/claim", {})
    req(base + "/jobs/" + V + "/fail", {"attempt": 1, "message": "x"})
    _api_budget(root, 1.2)  # spent since
    code, body = req(base + "/ingest", GOOD)  # error -> captured without /add
    assert code == 402 and body["code"] == "budget" and body["job"]["state"] == "error"
    assert (root / "data" / "raw" / f"{V}.json").exists()
    code, body = req(base + "/jobs/" + V)
    assert body["job"]["state"] == "error" and body["job"]["failedIn"] == "captured"
```

- [ ] **Step 2:** Run `~/.local/bin/uv run --with pytest pytest -q tests/test_server.py tests/test_server_jobs.py` → 新測試 FAIL
- [ ] **Step 3: 實作**
- [ ] **Step 4:** Run `~/.local/bin/uv run --with pytest pytest -q --deselect tests/test_server.py::test_lessons_list_carries_cost` → PASS（那一條留給 Task 9）
- [ ] **Step 5: Commit** `git add server.py tests/test_server.py tests/test_server_jobs.py && git -c commit.gpgsign=false commit -m "feat(server): keys, key test with model list, usage endpoint, budget gate on new attempts and re-ingest"`

---

### Task 9: 前端：語言模型來源、key 欄位、模型清單、費用顯示、上限

**Files:** Modify `web/settings.js`、`web/index.html`（`<details id="settings">` 區塊）、`web/app.js`（`initSettings`、`postAdd`／`startJob`、進度卡、課程列）、`web/progress.js`、`web/style.css`；Modify `server.py` `_lessons`（每列多 `costUsd`、`provider`，有才帶）；Test `tests/web/settings.test.js`（**既有檔，修改**）、`tests/web/progress.test.js`、`tests/test_server.py`。

**Interfaces（Produces）:**
- `web/settings.js`：`PROVIDERS = { 'claude-cli': { label: 'Claude CLI（本機登入）', short: 'Claude CLI', key: null }, 'codex-cli': { label: 'Codex CLI（本機登入）', short: 'Codex CLI', key: null }, 'anthropic-api': { label: 'Anthropic API key', short: 'Anthropic API', key: 'anthropic' }, 'openai-api': { label: 'OpenAI API key', short: 'OpenAI API', key: 'openai' } }`；`KEYS = ['provider', 'model', 'effort', 'workers', 'budgetUsd']`；`DEFAULTS` 多 `provider: 'claude-cli'`、`budgetUsd: null`；`normalize(obj, models = {})`：規則與 Task 2 逐字相同（含「缺 provider 視為 claude-cli、缺 budgetUsd 視為 null」）；`modelsFor(provider, models)`；`presetOf` 只比對 model/effort/workers（`PRESETS[*].settings` 維持三鍵）；`summary(s)` 以 `PROVIDERS[s.provider].short` 開頭（缺 provider 當 claude-cli）；`fmtUsd(x)`（`'約 $0.12'`；`null`/`undefined` → `'牌價未知'`）；`budgetText(u)`。
- `web/progress.js`：`costText(x)`（`x.usage` 存在 → `'約 $0.12・12.3k tokens'`；`costUsd` 為 `null` → `'牌價未知・500 tokens'`；沒 `usage` → `''`；token 為四欄合計，≥1000 以 `k` 一位小數）。
- 版面與行為同第 2 版：來源 radio、keybox（狀態文字含環境變數來源提示）、「測試連線」「移除」、每月上限欄、`#usage-line`；預設鈕在 `codex-cli`／`openai-api` 下 `disabled`；`startJob` 的 402 → 「這次仍要跑」按鈕 → `postAdd(id, { override: true })`；`warning` 顯示；進度卡 `building` 用 `costText(job.progress)`，`done`／`error` 用 `costText(job)`；課程列顯示 `fmtUsd(row.costUsd)`（有 `costUsd` 鍵才顯示）；載入與 job 終態後 `GET /usage` 更新 `#usage-line`（`warn`／`over` 加 class）。

- [ ] **Step 1: 遷移既有 web 測試**：`tests/web/settings.test.js` 第一個測試裡 `assert.deepEqual(PRESETS.standard.settings, DEFAULTS)` 改成比對三鍵；`normalize(p.settings)` 的期望改成 `{ ...p.settings, provider: 'claude-cli', budgetUsd: null }`；`summary` 測試的期望前面加 `'Claude CLI・'`（例：`'設定：Claude CLI・標準・sonnet・4 併行'`）；`normalize rejects` 的 `{ model, effort }`（缺 workers）仍須被拒，`settings` 殘餘比對加上 `provider: 'claude-cli', budgetUsd: null`。
- [ ] **Step 2: 寫失敗測試**

`tests/web/settings.test.js` 加（import 列加 `MODELS, modelsFor, fmtUsd, budgetText`）：
```js
test('normalize validates model per provider and budget', () => {
  const base = { provider: 'openai-api', model: 'gpt-6-astra', effort: 'default', workers: 4, budgetUsd: null };
  assert.ok(normalize(base, {}).errors.some((e) => e.includes('測試連線')));
  assert.deepEqual(normalize(base, { openai: ['gpt-6-astra'] }).errors, []);
  assert.deepEqual(normalize({ ...base, provider: 'codex-cli', model: 'whatever' }).errors, []);
  assert.ok(normalize({ ...base, provider: 'anthropic-api', model: 'claude-x' }).errors.length);
  const cli = { ...base, provider: 'claude-cli', model: 'claude-sonnet-5-5' };
  assert.deepEqual(normalize(cli).errors, []);
  assert.ok(normalize({ ...cli, budgetUsd: 0 }).errors.length);
  assert.equal(normalize({ ...cli, budgetUsd: 2.5 }).settings.budgetUsd, 2.5);
});
test('modelsFor, summary with provider, fmtUsd, budgetText', () => {
  assert.deepEqual(modelsFor('anthropic-api', { anthropic: ['claude-opus-6-0'] }), [...MODELS, 'claude-opus-6-0']);
  assert.deepEqual(modelsFor('codex-cli', {}), []);
  assert.equal(summary({ provider: 'openai-api', model: 'gpt-6-astra', effort: 'default', workers: 4, budgetUsd: null }), '設定：OpenAI API・自訂・gpt-6-astra・4 併行');
  assert.equal(fmtUsd(0.1234), '約 $0.12'); assert.equal(fmtUsd(null), '牌價未知');
  assert.equal(budgetText({ apiUsd: 0.85, budgetUsd: 1 }), '本月 API 約 $0.85／上限 $1.00（本機估算）');
  assert.equal(budgetText({ apiUsd: 0.85, budgetUsd: null }), '本月 API 約 $0.85（本機估算）');
});
```
`tests/web/progress.test.js` 加（import 列加 `costText`）：
```js
test('costText', () => {
  assert.equal(costText({ usage: { input: 12000, cacheRead: 0, cacheWrite: 0, output: 300 }, costUsd: 0.1234 }), '約 $0.12・12.3k tokens');
  assert.equal(costText({ usage: { input: 500, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: null }), '牌價未知・500 tokens');
  assert.equal(costText({ phase: 'segment', done: 1, total: 3 }), '');
});
```
`tests/test_server.py` 的 `test_lessons_list_carries_cost` 已在 Task 8 寫入（當時 FAIL 是可接受的，Task 8 的「全 PASS」排除它），本 Task 讓它通過。

- [ ] **Step 3:** Run `node --test tests/web/ && ~/.local/bin/uv run --with pytest pytest -q tests/test_server.py -k lessons` → 新測試 FAIL
- [ ] **Step 4: 實作 `settings.js`、`progress.js`、`server._lessons`** → 測試 PASS
- [ ] **Step 5: 實作 `index.html`、`app.js`、`style.css`**（DOM 只用 `el()`／`textContent`／`append`）
- [ ] **Step 6: 手動驗證**（`python3 server.py`，開 `http://127.0.0.1:8765/index.html#settings`）：四個來源切換、keybox、無 key 按測試連線→「請先貼上 API key」、選 API 來源沒 key 按儲存被拒、上限欄位存進 `data/settings.json`、`#usage-line` 出現；結果寫進 report。
- [ ] **Step 7: Commit** `git add web/ server.py tests/web/settings.test.js tests/web/progress.test.js tests/test_server.py && git -c commit.gpgsign=false commit -m "feat(web): provider source, API keys, model list, cost display and monthly budget"`

---

### Task 10: 擴充功能的 402 訊息與 README

**Files:** Modify `extension/background.js`（`runJob` 的 `/add` 回應處理）、`extension/README.md`；Test 新增 `tests/web/extension-add-error.test.js`（並在 `tests/web/index.js` import）。

**Interfaces（Produces）:** `ytLearnAddError(status, json, site) -> string`（`background.js` 頂層函式）：`status === 402 && json.code === 'budget'` → YouTube：`json.error + '（到 yt-learn 首頁可以選擇仍要跑）'`；其他站：`json.error + '（到 yt-learn 首頁調高或關閉每月上限後，再回這一頁重試）'`；其他 → `'加入工作失敗：' + serverError({ status, json })`（`serverError` 收的是 `{status, json}` 物件）。測試載入方式**比照 `tests/web/extension-overlay-messages.test.js`**（假 `chrome` 物件 + `ctx.importScripts` 載入 ytid.js，再 `vm.runInContext` 整支 background.js），然後從 `ctx.ytLearnAddError` 取函式；不要比照 `extension-ytid.test.js`（那支載的是無環境依賴的 ytid.js）。

- [ ] **Step 1: 寫失敗測試 `tests/web/extension-add-error.test.js`**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const YTID = readFileSync(new URL('../../extension/ytid.js', import.meta.url), 'utf8');

function load() {
  // Same shape as tests/web/extension-overlay-messages.test.js: a stub chrome whose on* hooks are inert.
  const on = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'ext', getManifest: () => ({ version: '0' }), onMessage: on(), onMessageExternal: on(), onInstalled: on(), getURL: (p) => p },
    action: { onClicked: on() }, contextMenus: { onClicked: on(), removeAll: (cb) => cb && cb(), create() {} },
    tabs: { onRemoved: on(), onUpdated: on() }, storage: { local: { get: async () => ({}), set: async () => {} } },
    permissions: { onRemoved: on(), contains: async () => false }, scripting: { getRegisteredContentScripts: async () => [] },
  };
  const ctx = { chrome, console, fetch: async () => { throw new TypeError('no network'); }, setTimeout, clearTimeout, URL };
  ctx.globalThis = ctx;
  ctx.importScripts = () => vm.runInContext(YTID, ctx);
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('budget 402 gets a site-specific hint', () => {
  const { ytLearnAddError } = load();
  const j = { ok: false, code: 'budget', error: '本月 API 費用已達上限 $1.00（本機估算）' };
  assert.equal(ytLearnAddError(402, j, 'youtube'), '本月 API 費用已達上限 $1.00（本機估算）（到 yt-learn 首頁可以選擇仍要跑）');
  assert.equal(ytLearnAddError(402, j, 'udemy'), '本月 API 費用已達上限 $1.00（本機估算）（到 yt-learn 首頁調高或關閉每月上限後，再回這一頁重試）');
  assert.match(ytLearnAddError(500, { error: 'x' }, 'youtube'), /^加入工作失敗：/);
});
```
- [ ] **Step 2:** Run `node --test tests/web/` → FAIL
- [ ] **Step 3: 實作並在 `runJob` 使用（`requested.site`）；`extension/README.md` 加「費用上限」一段。** 若上面的 stub `chrome` 少了 background.js 頂層就會碰到的某個 API，補到 stub 裡（以 `extension-overlay-messages.test.js` 的 stub 為準），不要改 background.js 來遷就測試。
- [ ] **Step 4:** Run `node --test tests/web/` → PASS
- [ ] **Step 5: Commit** `git add extension/background.js extension/README.md tests/web/extension-add-error.test.js tests/web/index.js && git -c commit.gpgsign=false commit -m "feat(extension): budget 402 message with a site-specific hint"`

---

### Task 11: README 與端到端驗證

**Files:** Modify `README.md`（英文開頭段；`## 需要什麼`；`## 設定`；`## 費用`；`## 專案結構` 列出 `pipeline/cost.py`、`keys.py`、`usage.py`、`prices.json`）。

- [ ] **Step 1: 改 README**（內容同第 2 版；另加：設定在**按下產課那一刻**綁定該次 attempt；上限只看帳本裡已結束的產課，**不含進行中與排隊中的**；CLI 來源的產課原樣繼承環境變數，API 來源才只拿到選定那一家的 key；失敗、中途停止的產課帳本列標 `partial: true`，server 當掉留下的孤兒產課在下次啟動時以 `state: "orphan"` 補記；OpenAI 清單只是帳號能用的推理模型，實際相容以產課結果為準；OpenAI 快取寫入 token 計法未經官方文件證實，屬估算）。
- [ ] **Step 2: 端到端**（實作者用自己的 key，不留紀錄；結果寫進 report）：Anthropic key 測試連線→產一支 ≤6 分鐘影片→進度卡顯示費用→完成卡與課程列顯示費用→lesson 檔有 `usage`／`costUsd`→帳本多一行→切回 `claude-cli` 重產同一支 `llm_calls=0`→上限設成比合計小→首頁 `/add` 402→「這次仍要跑」成功且擴充沒有再被擋→把 key 改成錯的再產一支：job error、訊息「API key 無效或沒有權限」、log 無 key。OpenAI 同一輪若有 key。
- [ ] **Step 3:** Run `~/.local/bin/uv run --with pytest pytest -q && node --test tests/web/` → 全綠
- [ ] **Step 4: Commit** `git add README.md && git -c commit.gpgsign=false commit -m "docs: API key providers, cost display and monthly budget"`

---

## 審查裁決

### 第四輪（獨立 opus 審稿，2026-11-04，「修改後核准」；以下修改已併入，第 5 版）

| # | 嚴重度 | 裁定 | 落點 |
|---|---|---|---|
| B-1 | blocker | 成立。`resolve` 的環境變數模型規則依最終 provider 走白名單／快取；`YTLEARN_PROVIDER=openai-api` 而沒有可用模型 → 退回 `claude-cli` 帶 warning；測試改寫。 | Task 2 |
| S-1 | should-fix | 成立。CLI 來源的環境變數模型維持白名單靜默忽略；CLI 來源永不帶 warning，`/add` 不受影響。 | Task 2 |
| S-2 | should-fix | 成立。新增 `slow_usage` 模式，`slow` 不動。 | Task 7 |
| S-3 | should-fix | 成立。五個測試檔的 import 逐一寫明。 | Task 4、8、9 |
| S-4 | should-fix | 成立。sweep 逐檔 try/except；`_runs.pop(vid, None)`；壞檔測試。 | Task 7 |
| N-1 | nit | 成立。沒快照時用 `resolve` 的 provider。 | Task 7 |
| N-2 | nit | 成立。先刪檔再記帳（sweep 與 `_finish` 同理）。 | Task 7 |
| N-3 | nit | 成立。`_run` 開頭掃全部。 | Task 7 |
| N-4 | nit | 成立。intro 的 except 在 `_ask`。 | Task 4 |
| N-5 | nit | 成立。Review Focus 測試名、`test_server.py:137`、`SETTINGS_ENV`、Task 10 測試寫成程式。 | 全部 |
| N-6 | nit | 成立。`GET /settings` 帶 resolve 的 warning；`/ingest` 遇到 warning 也擋。 | Task 8 |

### 第三輪（獨立 opus 審稿，2026-11-04，「退回」）

| # | 嚴重度 | 裁定 | 落點 |
|---|---|---|---|
| B-1 | blocker | 成立。用量檔名加 run id、內容記 pid；`sweep_orphans` 跳過還活著的 pid；`_finish` 只刪自己這個 run 的檔。 | Task 6、7 |
| B-2 | blocker | 成立。done 之後的重排改走 `add` 建立 attempt 2 → `claim` → `ingested(V, 2)`。 | Task 7 |
| B-3 | blocker | 成立。改用既有的 `updatedAt -=` 手法，不 patch `time`；加「被擋後狀態不變」斷言。 | Task 7 |
| S-1 | should-fix | 成立。遷移 `test_requeue_after_error_is_not_dropped` 的 `finish` 替身透傳 `**kw`。 | Task 7 |
| S-2 | should-fix | 成立。遷移清單加第 267、292 行；factory 慣例明寫「claude-cli 兩個位置參數」。 | Task 6 |
| S-3 | should-fix | 成立。Task 2 遷移清單逐行；Task 8 加 Step 0。 | Task 2、8 |
| S-4 | should-fix | 成立。segment 測試改用 `mk(20)`；vocab／intro 測試寫全。 | Task 4 |
| S-5 | should-fix | 成立。`resolve` 合併後做跨欄位檢查，不一致退回預設並帶 `warning`；`/add` 遇到 → 400。 | Task 2、8 |
| S-6 | should-fix | 成立，採 (a)：CLI 來源原樣繼承環境；API 來源才剝掉並注入。 | Task 3、7、11 |
| S-7 | should-fix | 成立。redirect 測試斷言 `redirect_request` 回 None 且型別不是原生 handler；transport 每次呼叫建 opener。 | Task 4 |
| N-1 | nit | 成立。0600 測試改成 spy `os.open` 的 flags／mode，並封掉 `chmod`／`fchmod`。 | Task 3 |
| N-2 | nit | 成立。Task 10 改比照 overlay-messages 的載入方式；`serverError` 的參數形狀寫明。 | Task 10 |
| N-3 | nit | 成立。`sweep_orphans(vid=None)`；檔名用 `rsplit`。 | Task 7 |
| N-4 | nit | 成立。`/ingest` 自己算 `_resolved()`。 | Task 8 |
| N-5 | nit | 成立。`_finish` 先 `store.finish` 再記帳。 | Task 7 |
| N-6 | nit | 成立。README 補「上限不含進行中與排隊中」。 | Task 11 |
| N-7 | nit | 成立。測試改名；web 的 `budgetUsd: 0` 測試改用合法基底；`pct` 用 `math.floor`。 | Task 6、8、9 |
| N-8 | nit | 成立。fixtures 與 `/lessons` 測試寫成程式；兩把 key 在 fixture 裡 `delenv`；`/keys/test` 無 key 時的行為寫明。 | Task 8 |
| N-9 | nit | 成立。`gate=None` 視為通過並設 `approved`。 | Task 7 |

### 第二輪（獨立 opus 審稿，2026-11-04，「退回」）

| # | 嚴重度 | 裁定 | 落點 |
|---|---|---|---|
| B1 | blocker | 成立。核准旗標改為 `approved`，`fail`／`finish(error)` 清掉；`needs_approval = not approved`。 | Task 7、8 |
| B2 | blocker | 成立。閘搬進 `JobStore.add` 的鎖內，只在三個建立新 attempt 的分支呼叫；lesson_ok → done 不過閘；`add` 回傳型別不變。 | Task 7、8 |
| S3 | should-fix | 成立。非 partial 的 `normalize` 缺 `provider`／`budgetUsd` 補預設，三鍵客戶端照常。 | Task 2 |
| S4 | should-fix | 以 B2 的做法（不改回傳型別）化解。 | Task 7 |
| S5 | should-fix | 成立。`settings.test.js` 既有，列出要改的斷言。 | Task 9 |
| S6 | should-fix | 成立。`usage_sink` 在鎖內呼叫；測試改成檢查快照序列單調。 | Task 4 |
| S7 | should-fix | 成立。用量檔名帶 attempt；`BuildQueue.__init__` 與 `_run` 回收孤兒（`state: "orphan"`）。 | Task 7 |
| S8 | should-fix | 成立。`env_for_build` 先移除兩個 key 變數再注入。 | Task 3、7 |
| S9 | should-fix | 成立。所有佔位測試改成可執行；`make_cues`；`RecordingFake` 定義；stub_build 加 `usage`／`dump` 模式。 | Task 4、6、7 |
| S10 | should-fix | 成立。別名測試斷言 `settings:` 列印 `provider=claude-cli`。 | Task 6 |
| S11 | should-fix | 成立。測試把 `os.chmod` 換成會丟例外的函式。 | Task 3 |
| S14 | should-fix | 成立。`load` 跨欄位失敗時同時丟 `provider` 與 `model`。 | Task 2 |
| nit | — | 行號改成符號名；新 import 寫在測試函式內；`pct` 為 int；`list_models` 單次、20 s；`ProviderFatal.status`。 | 全部 |

### 第一輪（Codex gpt-6-astra，2026-11-04，「退回」）

| # | 嚴重度 | 裁定 | 落點 |
|---|---|---|---|
| 1 | blocker | `save`／`load` 自行載入模型快取。 | Task 2 |
| 2 | blocker | 預算只在建立新 attempt 時檢查。 | Task 7、8 |
| 3 | blocker | 設定快照綁 attempt；error 重新 ingest 在 `/ingest` 過閘。 | Task 7、8 |
| 4 | blocker | `ProviderFatal` 穿透切句／挑字／背景卡，build 回 3。 | Task 4、6 |
| 5 | blocker | 用量走獨立快照檔，每次回應即寫；error 列 `partial: true`。 | Task 4、6、7 |
| 6 | should-fix | 先記用量再判斷狀態；累加加鎖。 | Task 4、5 |
| 7 | blocker | 暫存檔以 `O_CREAT\|O_EXCL, 0o600` 建立。 | Task 3 |
| 8 | should-fix | 只注入選定來源的 key；`scrub` 加 `sk-` 規則；CLI stderr 與 `_tail` 都遮。 | Task 3、4、7 |
| 9 | should-fix | transport 不跟隨 redirect。 | Task 4 |
| 10 | should-fix | HTTP 層錯誤一律 `ProviderFatal`；`retry-after` 不截短、超過預算放棄；單一 timeout。 | Task 4 |
| 11 | should-fix | OpenAI effort 原樣送、400 才降一次；清單 regex 收緊。 | Task 5 |
| 12 | should-fix | cache-write 假設含在 input 內並註明；計價用裸 `model_id`。 | Task 5、6 |
| 13 | blocker | `staticmethod`；fixture 回 bytes。 | Task 8 |
| 14 | should-fix | 各 Task 補遷移步驟。 | Task 2、6、7、9 |
| 15 | should-fix | `POST /settings` 在 API 來源時要求 key。 | Task 8、9 |
| 16 | should-fix | `/lessons` 與終態 job 帶 `costUsd`；外站 402 提示改法。 | Task 9、10 |
