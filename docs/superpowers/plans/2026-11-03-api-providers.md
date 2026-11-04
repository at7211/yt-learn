# yt-learn：用 API key 直連 Anthropic／OpenAI 當產課的語言模型（第三、第四個 Provider）＋費用換算與每月上限

第 1 版（2026-11-03）：設計稿。依與使用者的腦力激盪寫成；「我的判斷」標註處是起草者的決定，可反對。尚未做 Spike，尚未經 Codex 審查。
第 3 版（2026-11-04）：Codex gpt-6-astra 審了實作計畫（`2026-11-04-api-providers-plan.md`）後退回 16 條，裁決寫在計畫文末；對本設計的修訂：決定 6 的「連線逾時 20 s」取消（單一 urllib timeout）、HTTP 層錯誤一律致命不進後綴重試；決定 9／11 的「用量寫在 progress 檔」改為獨立的用量快照檔（每次回應即寫）；決定 12 的預算閘只在建立新 attempt 時檢查，error 重新 ingest 的路在 `/ingest` 過閘，外站 402 提示改為「調高或關閉上限後回原頁重試」；決定 19 改為設定快照在 `/add` 那一刻綁定 attempt；新增 `ProviderFatal`（認證／額度錯誤讓產課停下，不降級）；`POST /settings` 選 API 來源時要求 key 已存在；只把選定來源的 key 注入產課子行程。衝突時以計畫為準。
第 2 版（2026-11-03）：併入建造者檢查（一個沒看過對話的 opus 審稿）的 7 個問題，全部由起草者裁定後寫進設計決定 1、4、7、9、11、12 與新增的 16–19（原第 15 點「文件」改編號為 20）；裁定處標「（第 2 版裁定）」。

## 意圖與為什麼

現在產課（切句、中譯、挑字、背景卡）只能透過本機已登入的 `claude` 或 `codex` CLI 呼叫語言模型。這對兩種人不夠：

1. 使用者本人想改用 API 計費（按 token 付），不再吃 CLI 訂閱額度。
2. 想分享給沒裝 Claude Code、沒裝 Codex 的朋友：他們只要有一把 Anthropic 或 OpenAI 的 API key，貼上就能跑，不必安裝、登入任何 CLI。

API 計費看得見錢，所以同時要：每堂課產完顯示用了多少 token、換算成大約多少美元；可以設一個每月上限，快到時提醒、到了就不再開新的產課。

**誠實的限制**：Anthropic 與 OpenAI 都沒有一支給一般 API key 查「帳戶還剩多少額度」的端點（Anthropic 的用量／成本報表要 Admin key；OpenAI 只有後台儀表板）。所以「額度快到提醒」做的是**本機帳本**：記錄這個工具自己花掉的估算金額，對照使用者設的上限。UI 文案要寫明「這是本機估算，不是帳戶餘額」。

## 目標

- 設定頁多一塊「語言模型來源」，四選一：`claude-cli`（現況預設）、`codex-cli`、`anthropic-api`、`openai-api`。後兩者各有一個 key 欄位與「測試連線」。
- key 存本機、不進 git、不回傳整把給瀏覽器；環境變數 `ANTHROPIC_API_KEY`／`OPENAI_API_KEY` 也吃。
- 兩個新的 Provider 走現有 `complete_json(system, user, schema)` 介面，沿用快取、一次重試、effort 對應。
- 每次呼叫回報 token 用量；每堂課的進度卡與完成列顯示 token 與估算美元；首頁顯示「本月已花 / 上限」。
- 每月上限（美元）：到 80% 顯示提醒；到 100% 新的產課不開（可按「這次仍要跑」繞過一次）；正在跑的那支讓它跑完。
- 零新依賴：Python 標準函式庫的 `urllib` 直接打 HTTP（我的判斷，見設計決定 3）。
- 安裝需求從「要有登入的 CLI」變成「CLI 或一把 key 擇一」；README 與未來的 home page 跟著改。

## 非目標

- 不做帳戶餘額查詢（做不到，見上）。
- 不做多把 key、不做 key 輪替、不做團隊共用。
- 不改切句／挑字／背景卡的 prompt 與 schema；兩個新 Provider 必須吃現有的 system／user／schema 不動（prompt 版本不變，快取鍵不變）。
- 不做串流輸出；產課是批次呼叫，等整個 JSON 回來即可。
- 不把 key 放進擴充功能（extension）；擴充只跟 127.0.0.1:8765 講話，key 永遠只在 server 端。
- 不處理 Bedrock／Vertex／第三方相容端點；只有官方 `api.anthropic.com` 與 `api.openai.com`。

## 反目標（做出來也算失敗）

- key 以明文出現在瀏覽器、log、progress 檔、lesson 檔、錯誤訊息、git 任何一處。
- 用了 API 之後既有的 CLI 路徑任何行為改變（包括快取命中）。
- 費用數字看起來精確其實是猜的：牌價表沒有日期、沒有來源、或用模型的記憶填。
- 朋友貼了 key 卻還要先裝別的東西才能跑。

## 已核對的事實（2026-11-03，HEAD e0d6e4b）

- `pipeline/llm.py:24-26` `Provider` Protocol 只有一個方法 `complete_json(system, user, schema) -> dict`。`:68-148 _CliProvider` 包了快取（`_cache_fields` 以 model／promptVersion／system／user／schema／effort 做 sha256 鍵）、一次重試（`RETRY_SUFFIX`）、`calls`／`cache_hits` 計數；子類只實作 `_call`。`:150-187 ClaudeCliProvider` 用 `--json-schema` 拿 `structured_output`；`:190-` `CodexCliProvider` 用 `--output-schema`。
- `pipeline/build.py:117 PROVIDERS = {"claude": ClaudeCliProvider, "codex": CodexCliProvider}`；`:120 _default_provider(model, cache_dir, provider, effort)`；`:143-162` argparse（`--provider` 預設 `$YTLEARN_PROVIDER` 或 `claude`、`--model`、`--effort`）；`:164 model_label`（codex 寫成 `codex:<model>`）；`:52 stats` 只有 chunks／fallback_chunks／vocab_failed／intro_failed；`:94` lesson 檔記 `model`、`effort`、`promptVersion`；`:124 progress_writer` 原子寫 `{phase, done, total}` JSON；`:151 --progress-file`（env `YTLEARN_PROGRESS_FILE`）。
- `pipeline/settings.py:12-18`：`MODELS` 三個 claude 名稱白名單、`EFFORTS`、`DEFAULTS = {model, effort, workers}`、`ENV` 對應 `YTLEARN_MODEL/EFFORT/WORKERS`；`:33-54 normalize`（未知鍵是錯誤）、`:57 load`、`:83 save`（原子寫 `data/settings.json`）、`:120 resolve`、`:130 apply_to_env`。
- `pipeline/jobs.py:180` 產課子行程指令可由 `YTLEARN_BUILD_CMD` 覆寫；`:256` 用 `settings.apply_to_env(saved, {**os.environ, YTLEARN_PROGRESS_FILE})` 組子行程環境；`:227 progress_path`；`:156` 失敗時 SIGKILL 整個 process group。
- `server.py:119,184-209` `GET/POST /settings`；`:9` 檔頭路由說明。
- `web/settings.js:3 MODELS`、`:7 DEFAULTS`、`:10-12 PRESETS`（快／標準／細緻）、`:15 KEYS`、`:17-35 normalize`（與 server 同規則）、`:49 shortModel`、`:54 summary`。`web/index.html:140-160` 設定區塊（`<details id="settings">`）；`web/app.js:10` import、`:126` POST、`:145` GET。`extension/background.js:44` 右鍵選單「設定」開 `/index.html#settings`。
- 進度卡：`web/app.js:167-340`（`job.progress`、`job.state`、`stepOf`）；`web/progress.js` 從 build 的單位算百分比。
- 測試：`tests/test_llm.py`、`tests/test_settings.py`、`tests/test_server.py`、`tests/test_server_jobs.py`、`tests/test_build.py`（`FakeProvider` 在 `llm.py:31`）；web 用 `node --test tests/web/`。CI：`.github/workflows/test.yml`（Node 22；Python 3.11／3.12；`pip install pytest` 之外不裝東西）。
- `.gitignore` 已排除整個 `data/`。
- README `## 費用`（第 83–96 行）目前以 CLI 訂閱額度為前提，附牌價換算表（Sonnet 輸入 $2／輸出 $10 每百萬 token）；`## 需要什麼` 第 37 行寫「一個已登入的 LLM CLI」。
- **未核對、交給實作者查文件**：Anthropic Messages API 的結構化輸出參數與 effort／thinking 參數的現行寫法、`GET /v1/models` 的回傳欄位、用量欄位名稱（含 cache read／write token）；OpenAI Responses API 的 JSON schema 輸出寫法、`reasoning.effort` 的合法值、`GET /v1/models`、用量欄位。實作者必須載入 `claude-api` skill 讀現行文件，OpenAI 的看官方 API reference；**不得憑記憶寫 API 形狀或牌價**。

## 設計決定

1. **四個來源名稱與設定鍵。** `settings.json` 新增 `provider`（`claude-cli`｜`codex-cli`｜`anthropic-api`｜`openai-api`，預設 `claude-cli`）與 `budgetUsd`（`null` 或正數，預設 `null`）。既有 `model`／`effort`／`workers` 不動。build.py 的 `--provider` 與 `YTLEARN_PROVIDER` 接受新名稱，舊名 `claude`／`codex` 仍接受（對應到 `*-cli`），`PROVIDERS` 表加兩個類別。`apply_to_env` 多傳 `YTLEARN_PROVIDER` 與 `YTLEARN_BUDGET_USD`（後者只給 build 寫進 stats，不在 build 端擋）。（第 2 版裁定）`resolve` 把環境變數 `YTLEARN_PROVIDER`（含舊名 `claude`／`codex`）對應成四個新名稱之一呈現在設定頁，所以原本靠 `YTLEARN_PROVIDER=codex` 的人打開設定頁看到的就是 `codex-cli`，按儲存會原樣寫回，不會被改成 `claude-cli`；檔案有值仍優先於環境變數，與其他鍵一致。
2. **key 的存放與流向。** `data/keys.json`，內容 `{"anthropic": "...", "openai": "..."}`，寫檔後 `chmod 0600`，原子寫（比照 `settings.save`）。讀取優先序：檔案 > 環境變數 `ANTHROPIC_API_KEY`／`OPENAI_API_KEY`。server 的 `GET /keys` 只回 `{"anthropic": {"set": true, "tail": "ab12", "source": "file"|"env"|null}, "openai": {...}}`；`POST /keys` 收 `{"anthropic": "sk-…"}`（缺的鍵不動，空字串代表刪除）。key 經環境變數 `ANTHROPIC_API_KEY`／`OPENAI_API_KEY` 傳給產課子行程（jobs.py 組 env 時注入），**不**走指令列參數（`ps` 看得到）。Provider 的任何錯誤訊息、log、progress 檔都不得含 key；實作時對錯誤字串做一次 `key[:8]`／整把的替換防呆。
3. **零依賴，`urllib` 直打。**（我的判斷）這個專案到現在只有標準函式庫，CI 只 `pip install pytest`；朋友安裝時不必 `pip install anthropic openai`。代價是 request／response 形狀要照文件手寫，且沒有 SDK 的自動重試，所以第 6 點自己做退避。若實作者讀文件後發現某個必要功能（例如結構化輸出）只有 SDK 才能用，回報後再議，不要自行加依賴。
4. **兩個新 Provider 繼承 `_CliProvider` 的快取與重試層。** 把 `_CliProvider` 改名為 `_CachedProvider`（保留舊名為別名，避免測試壞），`AnthropicApiProvider`／`OpenAiApiProvider` 實作 `_call`。快取鍵的 `model` 欄位放完整模型名（例如 `claude-sonnet-5-5`），所以 CLI 與 API 用同一個模型名時會互相命中快取：這是刻意的，回覆內容只看模型與 prompt。（第 2 版裁定）互相命中只在 Claude CLI 與 Anthropic API 之間：`AnthropicApiProvider` 的 `_cache_fields` 與 `ClaudeCliProvider` 完全相同（不加 `provider` 欄位），`effort` 放設定裡的字串（`low`…`max`），不是對應後送給 API 的值。`OpenAiApiProvider` 比照 `CodexCliProvider` 在鍵裡加 `"provider": "openai"`，與 Codex 互不命中（兩邊的模型名與 effort 對應都不同，刻意分開）。
5. **結構化輸出。** 兩家都用其原生的 JSON schema 輸出功能把現有 `schema` 送進去；拿不到結構化結果時退回 `_parse_object` 解析文字，再走既有的一次重試。schema 本身不改；若某家對 schema 有限制（例如必填 `additionalProperties: false`），在 Provider 內做一份轉換後的副本送出，快取鍵仍用原 schema。
6. **HTTP 細節。** 逾時：連線 20 s、整體 180 s（Anthropic）／300 s（OpenAI），沿用兩個 CLI 的 `default_timeout`。對 408／429／500／502／503／529 做最多 3 次指數退避（1、2、4 s，加抖動），尊重 `retry-after`；401／403 直接 `ProviderError("API key 無效或沒有權限")`；400 帶回 server 的錯誤訊息前 200 字。併行數沿用 `workers`（預設 4）；429 退避足以應付。
7. **effort 對應。** 設定裡的 `effort`（default／low／medium／high／xhigh／max）：Anthropic 依文件對應到現行的 effort／thinking 參數（`default` = 不送參數）；OpenAI 對應到 `reasoning.effort`，超出該模型支援範圍的降到最高可用值（比照 `CODEX_EFFORT`）。（第 2 版裁定）lesson 檔的 `effort` 仍寫設定裡的字串（與快取鍵一致），另加 `effortSent` 記實際送出的值；Codex 現況（lesson 寫對應後的值）維持不動。
8. **模型清單不寫死。** `POST /keys/test` 用那把 key 打 `GET /v1/models`（兩家都有）：成功即代表 key 可用，回傳清單存到 `data/models.json`（依 provider 分開，帶抓取時間）。設定頁的模型下拉在 API 模式下顯示這份清單（Anthropic 只列 `claude-*`；OpenAI 列名稱含 `gpt`／`o` 開頭的推理模型，其餘過濾掉，實作者可依清單實況調整過濾規則但要寫在測試裡）。`normalize` 在 API 模式下接受「出現在快取清單裡」的模型名；CLI 模式維持現有白名單。清單抓不到（離線）時沿用上次的檔案；完全沒有就只允許 `DEFAULTS["model"]`（Anthropic）或要求使用者先測試連線（OpenAI）。
9. **用量與費用。** `Provider` 多一個屬性 `usage`：累計 `input`、`output`、`cacheRead`、`cacheWrite` token（CLI Provider 填 0，但 `claude -p` 的 JSON 輸出若有 `usage`／`total_cost_usd` 欄位也收下，標示來源）。`build_lesson` 的 `stats` 多 `usage` 與 `costUsd`；progress 檔每次呼叫後多寫 `usage`／`costUsd`（進度卡可即時顯示）；lesson 檔多 `provider`、`usage`、`costUsd`、`priceDate`。（第 2 版裁定）lesson 的 `model` 標籤：`anthropic-api` 與 `claude-cli` 一樣寫裸名，`openai-api` 寫 `openai:<model>`（比照 `codex:<model>`）；來源一律另看新加的 `provider` 欄位。
10. **牌價表 `pipeline/prices.json`。** 每個模型一列：`input`、`output`、`cacheRead`、`cacheWrite`（每百萬 token 美元）、`source`（網址）、`asOf`（日期）。實作時從 `claude-api` skill 的現行文件與 OpenAI 官方定價頁抄，**不得憑記憶**。表裡沒有的模型：費用顯示「未知牌價」、帳本記 token 但金額為 `null`，不擋產課。README 說明怎麼自己改這張表。
11. **帳本 `data/usage.jsonl`。** 產課子行程結束時（成功或失敗都記）由 jobs.py 追加一行：`{ts, videoId, provider, model, usage, costUsd, state}`。server `GET /usage` 回本月（本機時區、自然月）的合計與上限、各 provider 分項；首頁設定區上方顯示「本月約 $x.xx／上限 $y（本機估算）」。CLI 模式也記（金額多半為 `null` 或 CLI 回報的數字），所以切換來源不影響帳本格式。（第 2 版裁定）**上限只對 `*-api` 的列合計**：訂閱制 CLI 的「等值金額」只是參考，不吃預算；`GET /usage` 回 `{month, apiUsd, cliUsd, budgetUsd, byProvider}`，首頁顯示「本月 API 約 $x／上限 $y」，CLI 等值另列一行小字。失敗、逾時被 SIGKILL 的產課也要記：build 每次呼叫後把累計 `usage`／`costUsd` 寫進 progress 檔（決定 9），jobs.py 在 `_finish` 清掉 progress 檔**之前**先把這兩個欄位讀出來寫入帳本；`progress()` 給前端的公開視圖照舊只回 `phase/done/total`，再加 `usage`／`costUsd` 兩個欄位。
12. **上限的強制點。**（第 2 版裁定，取代第 1 版）在 **`POST /add`**（server.py:264 附近，網頁與擴充功能發起產課都走這裡，在擷取字幕之前）判斷，只當 `provider` 是 `*-api` 時才查帳：本月 API 合計 ≥ 上限 → 回 HTTP 402 `{error: "本月 API 費用已達上限 $y（本機估算）", code: "budget"}`，不建 job；≥ 80% → 照建 job，回應多一個 `warning` 字串，job 的公開欄位也帶 `warning` 讓進度卡顯示。`/add` 接受 `override: true` 跳過這個檢查（只跳過一次，不記住）。**網頁**：`code === "budget"` 時進度卡位置顯示訊息與「這次仍要跑」按鈕，按了帶 `override: true` 重送 `/add`。**擴充功能**：按圖示或右鍵發起時收到 402 就把訊息顯示在播放器左下角的小 pill（現有的錯誤顯示路徑）並加一句「到 yt-learn 首頁可以選擇仍要跑」；不在擴充裡做繞過，超出預算應該是一個刻意的動作。`/ingest` 與 `enqueue` 不再檢查（字幕已經抓了，擋在那裡只會浪費）。正在跑的產課不中斷。build.py 本身不擋（指令列使用者自己負責）。`extension/README.md` 要補這一句。
13. **設定頁版面。** `<details id="settings">` 內最上面加「語言模型來源」四個單選；選 API 時展開該家的 key 欄位（`type=password`，已設定時顯示「已設定 ••••ab12（檔案／環境變數）」與「更換」「移除」）、「測試連線」按鈕與結果列；下方模型／effort／併行數三欄維持，模型選項依來源換。三個預設組合只在 `claude-cli`／`anthropic-api` 下可用（它們指定 claude 模型）；其他來源把預設鈕 disabled 並說明。「儲存」仍是一顆，存 `settings`；key 由「測試連線」成功後立刻存（不等儲存），避免使用者測完忘了存。
14. **錯誤文案。** key 無效：「API key 無效或沒有權限，請到 <該家後台> 檢查」；沒 key 就選 API 模式按儲存：拒絕並指出要先貼 key；產課中途 401：job 轉 error，訊息同上，不印 key。
16. **`model` 欄位依來源驗證（第 2 版裁定）。** `normalize` 先讀 `provider` 再驗 `model`（partial 載入也一樣：兩個鍵都收齊後才做跨欄位檢查，舊檔沒有 `provider` 就當 `claude-cli`）：`claude-cli`／`anthropic-api` → 現有 `MODELS` 白名單，或（僅 `anthropic-api`）`data/models.json` 裡的 Anthropic 清單；`openai-api` → 必須在 `data/models.json` 的 OpenAI 清單；`codex-cli` → `model` 照存但不驗、UI 把欄位 disabled 並寫「照 Codex 自己的設定」（build 現況本來就忽略）。前端 `web/settings.js` 的 `normalize` 實作同一套規則，並從 `GET /settings` 多拿 `models`（兩家清單）來驗。設定頁切換來源時：切到 `anthropic-api`／`claude-cli` 保留目前的 claude 模型（不合法才換成 `DEFAULTS["model"]`）；切到 `openai-api` 換成清單第一個；切到 `codex-cli` 不動。
17. **`GET /settings` 的回傳多兩個欄位（第 2 版裁定）。** `keys`（決定 2 的遮罩形狀）與 `models`（`data/models.json` 的內容，缺檔為 `{}`），讓設定頁一次請求就能畫完；`POST /settings` 的請求體維持只收設定鍵。
18. **`POST /add` 的請求體（第 2 版裁定）。** 現有欄位不動，多一個選填 `override`（布林）。
19. **帳本的 provider／model 欄位來源（第 2 版裁定）。** jobs.py 在排程時就把當下生效的 `provider`／`model`（`settings.resolve` 的結果）記在 job 上，結束時連同 progress 檔讀出的 usage 一起寫入帳本；不依賴 lesson 檔（失敗時沒有）。
20. **文件。**（原第 15 點，改編號）README：`## 需要什麼` 改成「CLI 或 API key 擇一」；`## 設定` 補來源與 key；`## 費用` 改寫成兩段（CLI 訂閱／API 計費與本機帳本），保留現有估算表；英文開頭段落同步。`extension/README.md` 不需動（擴充不碰 key）。

## 交給實作者決定的事

- 兩個 Provider 的請求／回應解析細節、結構化輸出的確切參數、用量欄位名稱（必讀現行文件）。
- `data/models.json` 的過濾規則與快取有效期（建議 7 天後在設定頁提示「重新測試連線以更新清單」）。
- 進度卡上 token／費用的呈現位置與格式（沿用現有 meta 樣式即可）。
- 測試用的假 HTTP 層：建議在 Provider 內把「送請求」抽成一個可注入的函式（`transport(method, url, headers, body) -> (status, headers, text)`），測試注入假的，不用 mock `urllib` 全域。
- 牌價表的實際數字與來源網址。

## 驗證方式（接受條件）

- `pytest -q` 與 `node --test tests/web/` 全綠；CI 仍只裝 pytest。
- 單元：兩個 Provider 對假 transport 的 200／結構化、200／純文字 fence、400、401、429 後成功、逾時各一條；快取鍵與 CLI 相同模型互相命中；錯誤訊息不含 key（用一把假 key 跑過所有錯誤路徑後 `assert key not in message`）。
- settings：新鍵的 normalize／resolve／apply_to_env；舊 `settings.json`（沒有 `provider`）載入後 provider 為 `claude-cli`。
- server：`GET /keys` 永遠不回整把；`POST /keys` 後檔案權限 0600；`GET /usage` 的月合計；上限拒絕與 override。
- 端到端（使用者的 key，實作者不留紀錄）：設定頁貼 Anthropic key → 測試連線成功、模型清單出現 → 產一支短片（例如既有 fixture 的 6 分鐘影片）→ 進度卡顯示 token 與美元 → lesson 檔含 `usage`／`costUsd` → 帳本多一行 → 首頁本月合計更新。OpenAI 同一輪。再把上限設成比合計小的數字 → 開新產課被拒 → 「這次仍要跑」可繞過。
- 切回 `claude-cli` 產同一支影片：快取全中、零呼叫（證明 CLI 路徑沒變）。

## 風險

- 兩家 API 的結構化輸出對 schema 的限制可能與 CLI 不同（例如不接受某些 JSON Schema 關鍵字）；第 5 點的轉換副本是保險，實作者要用三個現有 schema（segment／vocab／intro）各打一次真請求確認。
- 429 在併行 4 時可能頻繁（新帳號的 rate limit 低）；退避之外，設定頁的「快」預設是 8 併行，在 API 模式下要不要降，實作時看實測。
- 牌價會變；表帶日期並在 README 寫明是估算。
- `urllib` 不走系統 proxy 設定以外的東西；企業 proxy 環境不在範圍。
