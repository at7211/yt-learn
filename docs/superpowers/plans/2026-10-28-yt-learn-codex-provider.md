# Codex 作為第二個 LLM provider — 設計與計畫

**Goal:** `python3 -m pipeline.build <id> --provider codex` 用本機已登入的 Codex CLI 產課；預設仍是 Claude，所有既有行為不變。

**Probe（2026-10-28，codex-cli 0.158.0）:**
`printf '<prompt>' | codex exec --skip-git-repo-check --sandbox read-only --ephemeral --output-schema schema.json -o last.txt -C <dir> -`
→ exit 0；`last.txt` 與 stdout 都是純 JSON `{"answer":"好","n":3}`；stderr 是 banner（model: gpt-6-astra, approval: never）。沒有 system prompt 旗標。

**Architecture:** `pipeline/llm.py` 抽出共用基底 `_CliProvider`（cache、一次重試、`complete_json`），`ClaudeCliProvider` 與新的 `CodexCliProvider` 各自實作 `_call(system, user, schema)`。`build.py` 加 `--provider`，佇列用環境變數 `YTLEARN_PROVIDER` 帶給子行程。

## Global Constraints
- 預設 provider 是 `claude`；不傳參數、不設環境變數時，指令列、cache key、lesson 的 `model` 欄位與今天完全相同（既有測試不改斷言）。
- Codex 以 `--sandbox read-only --ephemeral -C <暫存目錄>` 執行，`--color never`，不給專案目錄，不開任何工具權限。
- Codex 的 cache key 多一個 `"provider": "codex"`，與 Claude 的 cache 互不干擾；Claude 的 key 格式不變（舊 cache 繼續命中）。
- 標準庫、無新依賴。

## 介面
- `CodexCliProvider(model: str | None = None, cache_dir=None, prompt_version=1, timeout=300.0)`；`model=None` 表示用使用者 Codex 設定檔的預設模型。
- `_call`：把 schema 寫到暫存檔（`tempfile.TemporaryDirectory`，同時當 `-C` 工作目錄），argv =
  `["codex", "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--color", "never", "-C", tmpdir, "--output-schema", schema_path, "-o", last_path]` ＋（有 model 時）`["-m", model]` ＋ `["-"]`；stdin = `system + "\n\n---\n\n" + user`（system 寫在前面，因為沒有 system prompt 旗標）。
- 回覆：優先讀 `-o` 檔；檔案不存在或空白時退回 stdout 最後一個非空行。去 code fence、`json.loads`、必須是物件；否則 `_Failure`（觸發一次 RETRY_SUFFIX 重試，再失敗 → `ProviderError`）。
- `FileNotFoundError` → `ProviderError("codex CLI not found on PATH")`；timeout → `_Failure`；exit ≠ 0 → `_Failure` 帶 stderr 最後 200 字。
- `build.py`：`--provider {claude,codex}`，預設 `os.environ.get("YTLEARN_PROVIDER", "claude")`；`--model` 預設：claude → `DEFAULT_MODEL`，codex → `None`。`model_label`：claude 時維持 `args.model`；codex 時 `"codex:" + (args.model or "default")`。provider 選錯值 → argparse 自己擋。
- `_default_provider(model, cache_dir, provider="claude")`；`provider_factory` 的既有兩參數簽名在測試中仍可用（第三個參數有預設）。

## 任務

### Task 1: `CodexCliProvider` ＋ 基底抽取
**Files:** Modify `pipeline/llm.py`; Test `tests/test_llm.py`。
- [ ] 測試（Claude 既有測試全部不動、全部仍過）。
- [ ] 測試：`CodexCliProvider().complete_json("sys","usr",{"type":"object"})` 用 monkeypatch 的 `subprocess.run`：斷言 argv 開頭 `["codex","exec"]`、含 `--sandbox read-only`、`--ephemeral`、`--output-schema <存在的檔案，內容 == schema>`、`-o`、結尾 `-`、無 `-m`；`kwargs["input"]` 以 `"sys"` 開頭、以 `"usr"` 結尾；fake 把 JSON 寫進 `-o` 路徑 → 回傳該物件。
- [ ] 測試：`-o` 檔未寫、stdout 為 banner 行＋最後一行 JSON → 取最後一行；stdout 含 ```json fence → 去 fence。
- [ ] 測試：`model="gpt-6-astra"` → argv 含 `-m gpt-6-astra`。
- [ ] 測試：exit 1 → 第二次呼叫 user 以 RETRY_SUFFIX 結尾；兩次都失敗 → `ProviderError`；`FileNotFoundError` → `ProviderError` 含 `codex`。
- [ ] 測試：cache key 含 provider：同 system/user/schema 下 Claude 與 Codex 的 `_cache_path` 不同；Claude 的 path 與抽取前相同（用一個固定字串的 sha256 斷言，從目前實作先算出來寫死）。
- [ ] 實作；`uv run --with pytest pytest tests/test_llm.py -q`。Commit: `feat(pipeline): CodexCliProvider`

### Task 2: build 的 `--provider`
**Files:** Modify `pipeline/build.py`, `extension/README.md`（一行）; Test `tests/test_build.py`。
- [ ] 測試：`main(["CR94QQXO_4s", "--provider", "codex"], data_dir, provider_factory=spy)` → spy 收到 `provider="codex"`、`model=None`；寫出的 lesson `model == "codex:default"`。不帶 `--provider` → `provider="claude"`、`model == DEFAULT_MODEL` 且 lesson `model == DEFAULT_MODEL`（既有行為）。
- [ ] 測試：`YTLEARN_PROVIDER=codex` 環境變數 → 預設成 codex；`--provider claude` 覆蓋環境變數。
- [ ] 實作；全套 pytest。Commit: `feat(build): --provider claude|codex (env YTLEARN_PROVIDER)`

### Task 3: 實跑比對
- [ ] 複製 `data/raw/x0ae-Mhz1AI.json` 到暫存 data 目錄，`main(["x0ae-Mhz1AI","--provider","codex"], data_dir=<暫存>)`；記錄秒數、cues/vocab 數、intro 是否成功、fallback_chunks；與 Claude 版（data/lessons/x0ae-Mhz1AI.json：50 句／27 字）並排看前 5 句切法與譯文。
- [ ] 若 Codex 的 fallback_chunks > 0 或結構驗證常失敗，記錄原因（schema 不嚴格遵守？）並決定是否在 `_call` 加 `-c model_reasoning_effort=...`；寫進本文件 §結果。

## Review Focus
1. `codex exec` 的 `-` 讀 stdin：prompt 很長（一個 chunk ≈ 120 字＋翻譯指示）時 stdin 是否完整；probe 只試過短 prompt → Task 3 實跑驗證。
2. 暫存目錄在 `subprocess.run` 結束前不得刪除（`with TemporaryDirectory()` 包住整個呼叫與讀檔）。
3. Codex 可能在 stdout 印出非 JSON 的事件文字（`--json` 未開時應只有最後訊息）；只信 `-o` 檔，stdout 是退路。
4. `--sandbox read-only` 下 Codex 仍可能嘗試執行指令讀檔；`-C` 指到空暫存目錄，讀不到專案。
5. 佇列（server）啟動的 build 透過 `YTLEARN_PROVIDER` 切換，server 本身不需要改；README 註明。

## 結果（2026-10-28 實跑，x0ae-Mhz1AI，1:38，317 字）
| | Claude（claude-sonnet-5-5） | Codex（gpt-6-astra，reasoning low） |
|---|---|---|
| 秒數（無 cache） | ≈52 | 131 |
| 句數 / 單字數 / 前情提要 | 50 / 27 / 有 | 44 / 16 / 有 |
| fallback chunks | 0/3 | 0/3 |
| 切句風格 | 短句、常把一句拆成兩段 | 整句、較長 |
| 單字選法 | 偏多、含單字 | 偏少、偏片語，釋義較口語 |

- 第一次實跑全部失敗：OpenAI 嚴格 schema 要求每個物件都有 `additionalProperties: false`，`strict_schema()` 補上後三種呼叫都成功。
- Codex 的 `-c features.hooks=false` 必要：使用者的 SessionStart hook 會在每次呼叫跑一次。
- 預設仍是 Claude；要整站用 Codex：`YTLEARN_PROVIDER=codex python3 server.py`。
