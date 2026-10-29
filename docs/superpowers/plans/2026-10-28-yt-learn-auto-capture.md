# yt-learn v1.1：貼網址自動擷取（Chrome 擴充功能 + 自動產課）— Design + Implementation Plan (v2, 已納入 Codex review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> 延續 `2026-10-27-yt-learn-player.md`（v1，已合併 main）。本文件同時是 design 與 plan。v2 變更摘要在 §9。

**Goal:** 使用者在 http://127.0.0.1:8765 貼上 YouTube 網址後不再做任何手動步驟：字幕自動擷取、課程自動產出、頁面顯示進度、完成後直接可點進播放器。

**主要入口（v2 新增，使用者要求）：** 使用者在 YouTube 影片頁按擴充功能工具列圖示 → 擴充功能在**目前分頁**擷取字幕（不另開分頁）→ POST `/ingest` → 自動開新分頁 `http://127.0.0.1:8765/index.html?v=<id>`：有 job 進行中時顯示進度卡，完成後自動切換成播放器；lesson 已存在則直接開播放器。貼網址入口保留為第二入口。

**Architecture:** (0) **可行性閘門**：最小擴充功能證明「背景分頁靜音播放會發出字幕請求」「MAIN world 注入能呼叫播放器 API」「worker 能 POST 到 127.0.0.1」。(1) **Server**：記憶體內 job 狀態機、`POST /add`、`GET /jobs/<id>`、窄的 `claim`/`fail` 動作、`/ingest` 觸發序列化的 build 子行程。(2) **擴充功能（MV3，未封裝）**：首頁 content script 橋接 → worker 開啟靜音背景分頁 → MAIN world 擷取 → POST `/ingest` → 關分頁。(3) **首頁**：網址輸入、握手偵測、進度卡、完成連結；無擴充功能時退回 v1 的 bookmarklet／匯入框。

**Tech Stack:** 同 v1 + Chrome Extension Manifest V3（`scripting`、`tabs`、`storage`；host_permissions `https://www.youtube.com/*`、`http://127.0.0.1:8765/*`）。

**Spec:** 本文件 §1–§4；v1 的 §1–§4 仍然有效。

## Global Constraints

- 擷取機制與 v1 bookmarklet **相同**：在使用者自己的 Chrome、自己的登入狀態下，讀取播放器自己發出的字幕請求再重抓 json3。不偽裝 client、不匯出 cookie、不從 server 端打 YouTube。
- `bookmarklet.js` **原封不動**保留為備援；擷取邏輯複製到 `extension/capture.js`（接受暫時重複；檔頭註明「與 bookmarklet.js 步驟 (1)–(5) 同源，改一邊請同步另一邊」）。擴充功能版本必須保留 v1 的 ASR 缺 offset = 0 規則與 videoId/網址一致性檢查。
- Server 仍只綁 `127.0.0.1:8765`。擴充功能對本機的 fetch 全部在 worker 內、靠 host_permissions；**不改 CORS**（`chrome-extension://*` 不是合法 ACAO 值）。
- Job 只存在記憶體；server 重啟後未完成的 job 消失，頁面顯示「請重試」。lesson/raw/log 仍在磁碟。
- 同一時間只跑一個 build（序列佇列）；子行程 `[sys.executable, "-m", "pipeline.build", id]`，`cwd = Handler.root`，stdout/stderr 直接導到 `<root>/data/jobs/<id>.log`，逾時 20 分鐘，server 關閉時終止子行程。
- 背景分頁用 `chrome.tabs.update(tabId, {muted:true})` 先靜音再導航；擷取函式在 `play()` 前再設 `video.muted = true`。三段各自有上限：導航 ≤ 15 秒、擷取 ≤ 25 秒、每次對 server 的請求 ≤ 5 秒。任何結果都關閉分頁。
- 不新增 Python 套件；不改 pipeline 的 LLM 邏輯。
- 自動化測試不呼叫真實 `claude` CLI、不開真實 YouTube；build 子行程用環境變數 `YTLEARN_BUILD_CMD` 指到 stub。Task 0 與 Task 4 的手動驗收是明確例外。

## Review Focus

1. **擴充功能沒裝／停用／裝好沒重新整理**：頁面先註冊 listener → 送 `ping` → 3 秒內沒收到 `ack` → 進度卡顯示安裝步驟（含「裝好後重新整理本頁」）與 bookmarklet 備援；job 留在 `queued`。→ Task 3 手動清單 + `tests/web/handshake.test.js`（純函式：ack 逾時判斷）。
2. **背景分頁播不起來／字幕請求沒出現**：擷取輪詢到 25 秒 → `fail`（訊息「背景分頁未能載入字幕，請改用書籤小工具」）；分頁一定關閉。→ Task 0 實證 + Task 2 capture 測試（以假 DOM/假 performance 模擬延遲就緒、無字幕、翻譯軌排除、逾時）。
3. **重複送出**：lesson 已存在且有效且非 preview → `/add` 回 `done`；進行中 → 回同一 job；只有 `queued` 才觸發擷取；ingest 在 `captured/building/done` 冪等。→ Task 1 測試。
4. **重試競態**：舊 attempt 的延遲 ingest/fail 不得影響新 attempt。→ Task 1 `test_stale_attempt_rejected`。
5. **build 失敗或 stub 成功但沒有合法 lesson**：→ `error` 附 log 最後 5 行；既有 lesson 不被覆蓋（v1 Ruling 11）。→ Task 1 測試。

---

## 1. 使用流程與畫面

- **圖示入口（主要）**：在 `https://www.youtube.com/watch?v=<id>` 分頁按圖示 → worker 對該分頁 `POST /add {url}` 取得 job → 若 `done` → 直接開 `index.html?v=<id>`；若 `queued` → `claim` → 對目前分頁注入 `capture.js`（`expectVideoId` = 網址的 `v`；影片若在播就不改變播放狀態，只在需要時開 CC；若影片是暫停的，靜音播放最多 3 秒後恢復暫停）→ `POST /ingest?attempt=` → 開新分頁 `index.html?v=<id>` → 該分頁顯示進度卡直到 `done` 再自動載入播放器。在非 YouTube 影片頁按圖示 → 開 `index.html`（貼網址頁）。

- 首頁最上方：「貼上 YouTube 網址」輸入框 + 「開始」。按下後：前端 `parseVideoId` → `POST /add` → 顯示**進度卡**（影片 id、三段狀態列「擷取字幕 → 產生課程 → 完成」、每 2 秒輪詢 `GET /jobs/<id>`）。
- `/add` 回 `queued` 且握手成功 → 頁面 `postMessage` 請擴充功能擷取；回 `queued` 但無擴充功能 → 卡片顯示安裝說明 + 備援（bookmarklet 走完後卡片會自己變 building → done）。
- `done` → 「開始學習」連到 `index.html?v=<id>`，並重新載入課程清單；`error` → 原因 + 「重試」（再 `POST /add`）。
- 匯入框收合在卡片下方（「手動匯入（備援）」）；匯入成功時若該影片有 job，顯示進度卡而不是 CLI 指令；沒有 job 才顯示 v1 的指令。
- 安裝說明文字：`chrome://extensions` → 右上「開發人員模式」→「載入未封裝項目」→ 選 `<repo>/extension/` → 回到本頁按重新整理。

## 2. 協定

**網址解析**（Python `pipeline/jobs.py::parse_video_id` 與 `web/ytid.js` 用同一張表，表存 `tests/fixtures/urls.json`）：接受 `https?://(www.|m.)?youtube.com/watch?v=<id>[&...]`、`https?://youtu.be/<id>[?...]`、`https?://(www.)?youtube.com/shorts/<id>`、`https?://(www.)?youtube.com/embed/<id>`、純 `<id>`；`<id>` 必須是 `^[A-Za-z0-9_-]{11}$`；其他主機或格式 → `None`。一律正規化為 `https://www.youtube.com/watch?v=<id>`（擴充功能只開這個網址，所以 v1 的 `v=` 一致性檢查對 Shorts 也成立）。

**`POST /add`** `{"url"}` → 200 `{"job"}`；400 `{"ok":false,"errors":[...]}`。規則：`data/lessons/<id>.json` 存在且 `validate_lesson` 通過且 `coveredSeconds >= duration` → `done`（附 `lessonUrl`）；有未完成 job（非 done/error）→ 回它；`error` 的 job → 重設為 `queued`（新 attempt）；否則建立 `queued`。
**`GET /jobs/<id>`** → job 或 404。Job：`{"videoId","state","attempt","message","updatedAt","lessonUrl"?}`，`state ∈ queued|capturing|captured|building|done|error`。
**`POST /jobs/<id>/claim`** → 原子 `queued → capturing`，回 `{"attempt": n}`；非 `queued` → 409。
**`POST /jobs/<id>/fail`** `{"attempt","message"}` → 僅當 state=`capturing` 且 attempt 相符 → `error`；否則 409。
**`POST /ingest[?attempt=n]`**（v1 端點）：寫 raw 後，若該 id 有 job：`queued|capturing → captured` 並排入 build（帶 attempt 的話必須相符，否則 409 且不寫 raw）；`captured|building|done` → 不重排、回 200（冪等）；`error` → 設 `captured` 並排入（手動備援可救回）。無 job 的 ingest 行為同 v1（回 `next` 指令）。
**Build 佇列**：單一 worker thread；`captured → building`；子行程結束：exit 0 且 lesson 檔通過 `validate_lesson` → `done`；否則 `error`（message = log 最後 5 行）。所有 store 操作加鎖；raw 寫檔的暫存檔名含 pid 與計數器。

**頁面 ⇄ 擴充功能**（同分頁 `window.postMessage`；雙方都檢查 `event.source === window`、`event.origin === "http://127.0.0.1:8765"`、`data.type` 前綴 `ytlearn:`；`targetOrigin` 明確）：
- 頁 → ext：`{type:"ytlearn:ping"}`、`{type:"ytlearn:capture", videoId}`。
- ext → 頁：`{type:"ytlearn:ack", version}`（對 ping 的回應，由 worker 經 bridge 回；不是 bridge 自己回）、`{type:"ytlearn:status", videoId, attempt, state, message}`（即時顯示用；真相以 server 為準）。

## 3. 元件與檔案

```
extension/
  manifest.json   MV3；name "yt-learn 擷取"；version 1.1.0；permissions: scripting, tabs, storage；
                  host_permissions: https://www.youtube.com/*, http://127.0.0.1:8765/*；
                  background.service_worker = background.js；content_scripts: matches ["http://127.0.0.1:8765/*"] → bridge.js
  background.js   頂層註冊 onMessage/onUpdated/onRemoved；流程：claim → 建空白分頁(active:false) → 靜音 → 記錄 ownedTabs 到 storage.session →
                  導航到正規化網址 → 等 complete（≤15 s，同時檢查現況）→ executeScript files:["capture.js"] world:MAIN →
                  executeScript func: ytLearnCapture({expectVideoId, timeoutMs:25000}) world:MAIN → 回傳 {ok,raw}|{ok:false,error} →
                  POST /ingest?attempt= 或 POST fail → 關分頁 → status 給 bridge。啟動時關掉 storage.session 內殘留的 ownedTabs。
  bridge.js       首頁 content script：轉送 ping/capture 到 worker；把 ack/status 回拋頁面
  capture.js      globalThis.ytLearnCapture(opts) -> Promise<raw>；輪詢：播放器就緒(movie_player.getPlayerResponse 的 videoId == expect) →
                  開 CC、muted play → 每 500 ms 找符合的 timedtext 資源直到有或到期 → json3 → raw；錯誤皆 throw 中文訊息
web/
  index.html / app.js / style.css   首頁：輸入框、握手、進度卡、收合匯入框、匯入後依 job 顯示
  ytid.js         parseVideoId(url) -> id|null；canonicalUrl(id)
  handshake.js    純函式：waitForAck(post, listen, timeoutMs) -> Promise<bool>（可注入，測試用）
pipeline/jobs.py  parse_video_id、JobStore（記憶體、鎖、transition 驗證、attempt）、BuildQueue（thread、subprocess、timeout、shutdown）
server.py         /add、/jobs/<id>、claim、fail、ingest 觸發；OPTIONS 回 Allow-Methods: GET, POST, OPTIONS
tests/test_jobs.py tests/test_server_jobs.py tests/fixtures/urls.json tests/fixtures/stub_build.py
tests/web/ytid.test.js tests/web/handshake.test.js tests/web/capture.test.js（以假 window/document/performance 跑 extension/capture.js）
```

## 4. 狀態機

```
queued ──claim──▶ capturing ──ingest──▶ captured ──worker──▶ building ──▶ done
  │  ▲                │                     ▲
  │  └──/add(retry)───┤──fail──▶ error ─────┘ (ingest from manual fallback)
  └──ingest(manual)───┘
```
合法轉移：`queued→capturing`(claim)、`queued→captured`(ingest)、`capturing→captured`(ingest, attempt 相符)、`capturing→error`(fail, attempt 相符)、`captured→building`、`building→done|error`、`error→queued`(/add)、`error→captured`(ingest)。其他 → 409。

進度卡文字：queued「等待擴充功能…」、capturing「正在背景開啟影片擷取字幕…」、captured/building「正在翻譯與挑選單字（約 1–3 分鐘）…」、done「完成」、error「失敗：<message>」。

---

## 5. Tasks

### Task 0: 可行性閘門（throwaway 可，但若通過就保留為擴充功能骨架）
**Files:** Create `extension/manifest.json`, `extension/background.js`, `extension/capture.js`（先只做擷取 + POST `/ingest`，觸發方式：worker 收到 `chrome.runtime.onMessage {type:"probe", videoId}`；bridge 先不用，由 controller 在擴充功能的 service worker console 或一個 `probe.html` 擴充頁面觸發）。
- [ ] 使用者載入未封裝擴充功能（一次）。
- [ ] Controller 驗證三件事並記到 §8：(a) `active:false` 的新分頁靜音播放後 `performance` 出現該影片的 timedtext 請求（記錄等待秒數）；(b) MAIN world 注入能呼叫 `movie_player.getPlayerResponse()` 並回傳 raw（attempt 以 expectVideoId 比對）；(c) worker 的 `fetch('http://127.0.0.1:8765/ingest', POST)` 成功寫出 raw（server log 有 `[ingest]`）。另測：沒有字幕的影片 → 25 秒逾時 → 分頁關閉。
- [ ] 任一不通過 → 回到本文件改設計（例如改為 `active:true` 短暫前景分頁），再繼續。
- [ ] Commit `spike(extension): capture feasibility gate`

### Task 1: jobs 狀態機 + server 端點 + 自動 build
**Files:** Create `pipeline/jobs.py`, `tests/test_jobs.py`, `tests/test_server_jobs.py`, `tests/fixtures/urls.json`, `tests/fixtures/stub_build.py`（可用環境變數 `STUB_MODE=ok|fail|ok_invalid` 控制：寫合法 lesson／非零退出／exit 0 但寫壞檔）；Modify `server.py`。
**Interfaces:** `parse_video_id(s) -> str|None`；`canonical_url(id) -> str`；`JobStore()`: `get`, `add(id, lesson_ok: bool)`, `claim(id) -> int`, `fail(id, attempt, msg)`, `ingested(id, attempt|None)`, `set_building(id)`, `finish(id, ok, msg, lesson_url)`；`BuildQueue(store, root, cmd_factory=None, timeout=1200)`: `enqueue(id)`, `shutdown()`。
- [ ] 失敗測試：`test_parse_video_id_table`（讀 `urls.json`）、`test_transitions_legal_and_illegal`、`test_add_creates_queued`、`test_add_existing_valid_full_lesson_is_done`、`test_add_preview_or_invalid_lesson_rebuilds`、`test_add_in_progress_returns_same_job`、`test_add_error_job_requeues_with_new_attempt`、`test_claim_atomic_once`（兩執行緒同時 claim 只有一個成功）、`test_stale_attempt_rejected`（舊 attempt 的 ingest/fail → 409）、`test_ingest_without_claim_from_manual_fallback`、`test_ingest_idempotent_in_captured_building_done`（不重排）、`test_ingest_with_job_builds_to_done`（stub ok）、`test_build_failure_sets_error_with_log_tail`（stub fail，既有 lesson 不變）、`test_build_exit0_but_invalid_lesson_is_error`、`test_two_videos_build_serially`、`test_worker_survives_spawn_failure`（cmd 指到不存在的程式 → 該 job error，下一個 job 仍會跑）、`test_server_responds_during_build`、`test_subprocess_cwd_is_root`（stub 把 cwd 寫進 lesson 的 `channel` 欄位以便斷言）。
- [ ] FAIL → 實作 → PASS → Commit `feat(server): in-memory jobs, /add, claim/fail, auto build queue`

### Task 2: 擴充功能完整版
**Files:** Modify `extension/background.js`, `extension/capture.js`；Create `extension/bridge.js`；Test `tests/web/capture.test.js`（node：用假 `globalThis.document/performance/fetch/location` 跑 capture.js：延遲就緒後成功、videoId 不符、無字幕軌、翻譯軌排除、timedtext 永不出現→逾時、json3 空→錯誤、ASR 缺 offset=0）、`node --check` 全部。
- [ ] capture.js 依 §3 輪詢設計；錯誤訊息中文；成功回 raw（含 `chrome` 版本）。
- [ ] background.js 依 §3；attempt 與 status 轉發；storage.session 記錄 ownedTabs；啟動清理。
- [ ] bridge.js 依 §2 協定。
- [ ] `chrome.action.onClicked`：圖示入口流程（§1），含 `/add` → done 直開、queued → 目前分頁擷取、擷取失敗時用 `chrome.notifications` 或在新開的 yt-learn 分頁顯示錯誤（job `fail`）。
- [ ] Commit `feat(extension): bridge, attempts, bounded phases, polling capture`

### Task 3: 首頁網址輸入、握手、進度卡
**Files:** Modify `web/index.html`, `web/app.js`, `web/style.css`；Create `web/ytid.js`, `web/handshake.js`, `tests/web/ytid.test.js`, `tests/web/handshake.test.js`。
- [ ] `ytid.test.js` 讀同一份 `tests/fixtures/urls.json`；`handshake.test.js`：ack 在時限內 → true；逾時 → false；重複 ack 不炸。
- [ ] 進度卡與匯入框行為依 §1；輪詢在 done/error 停止；離開頁面清掉 timer。
- [ ] `index.html?v=<id>` 且 lesson 不存在：先 `GET /jobs/<id>`；有 job → 顯示進度卡並輪詢，`done` 後不重新整理直接載入播放器；無 job → v1 的「尚未產課」畫面加一顆「用擴充功能擷取」按鈕（走 `/add` + 握手）。
- [ ] 手動驗證（無擴充功能）：貼網址 → 安裝說明；bookmarklet 備援走完 → 卡片自動 building → done。
- [ ] Commit `feat(web): paste a URL, handshake, progress card`

### Task 4: 端到端驗收
- [ ] 重新載入擴充功能（chrome://extensions 的重新整理）與本頁。
- [ ] 圖示入口：在一支新影片的 YouTube 分頁按圖示 → 不碰任何東西 → 新分頁出現進度卡 → 自動變播放器；記錄秒數。再按一次圖示 → 直接開播放器。
- [ ] 成功路徑（貼網址）：貼一支新影片 → 不碰任何東西 → queued → capturing → building → done → 「開始學習」播放正常；記錄各階段秒數到 §8。
- [ ] 失敗路徑：無字幕影片 → error 訊息正確、分頁已關閉；server 沒開 → 卡片顯示連線錯誤。
- [ ] 重複貼同一支 → 立即 done；擷取中再貼 → 同一 job、不開第二個分頁。
- [ ] 慢速導航：在擷取中手動關掉該 YouTube 分頁 → job error、不卡住。
- [ ] `uv run --with pytest pytest -q && node --test tests/web/` 全綠；fresh-context（opus）整支 review；數字補到 §8。

## 6. 風險
| 風險 | 處置 |
|---|---|
| 背景分頁不觸發字幕請求 | Task 0 先證實；不通過則改為 `active:true` 的短暫前景分頁（擷取完立刻關掉並把焦點還給原分頁），plan 更新後再繼續。 |
| MV3 worker 被回收 | 三段各自設上限；listener 在頂層；ownedTabs 存 storage.session，啟動時清理；server 端 `capturing` 超過 60 秒無後續 → 頁面重試按鈕可用（`/add` 對 capturing 超時 job 視同 error 重排，Task 1 實作 `STALE_CAPTURE_SECONDS = 60`）。 |
| 使用者沒裝擴充功能 | 握手失敗時清楚顯示並保留 bookmarklet 備援。 |

## 7. 假設
- A：擴充功能由使用者手動載入一次；不打包、不上架。
- B：序列 build。
- C：commit 授權與執行方式沿用 v1（每 task 一 commit；subagent-driven；Task 0 由 controller 親自驗證）。

## 8. 實測記錄
（Task 0 與 Task 4 後填）
- Task 0 閘門（2026-10-28，Chrome 155）：使用者載入未封裝擴充功能後，由本機頁面以 externally_connectable 觸發探針（一支 6 分鐘的新聞片段）：`active:false` 靜音分頁導航 1657 ms、擷取 1754 ms（字幕請求確實出現）、POST /ingest 6 ms 回 200、總計 3456 ms、144 events。三項假設全部成立。

## 9. v2 變更摘要（對 Codex review 的處置）
採納：Task 0 可行性閘門；capture 改輪詢到期限、三段各自上限、先靜音再導航、listener 頂層註冊、ownedTabs 記錄；狀態機補 `queued→captured`、`error→queued`、`error→captured`，ingest 冪等，只有 queued 觸發擷取，原子 claim + attempt token，stale 拒絕；store 加鎖、raw 暫存檔名唯一；build 子行程 cwd/逾時/關機處理、worker 容錯、exit 0 但壞檔 → error；握手改 ping/ack 3 秒、origin/source 檢查、「裝好後重新整理」；網址表與正規化、Shorts；done 僅限有效且非 preview；匯入框依 job 顯示；測試清單補齊；砍掉 Ruling A 產生器、持久化、`GET /jobs`、泛用 PATCH、CORS wildcard。
不採納：無。
