# 工作卡進度條 — 設計與計畫

**Goal:** 貼網址／按擴充圖示之後的工作卡（擷取字幕 → 產生課程 → 完成）多一條進度條：擷取階段是不定長度的流動條＋已耗秒數，產課階段是真實百分比（切句 k/n → 挑單字 → 前情提要）。

**為什麼擷取沒有百分比：** 擷取是擴充在 YouTube 分頁裡等字幕請求出現，沒有可量化的中間進度，只有階段訊息（已在卡片上顯示）。產課則由 build 子行程逐 chunk 呼叫 LLM，可以精確回報。

**Architecture:** build 子行程把進度寫到 `--progress-file` 指定的 JSON（原子寫入）；server 在 `GET /jobs/<id>` 且狀態為 `building` 時讀該檔附上 `progress`；前端卡片每次輪詢（既有 `POLL_MS`）重畫進度條。不新增端點、不改狀態機。

## Global Constraints
- Python 3 標準庫；無新依賴。進度檔寫失敗（OSError）只忽略，不影響 build。
- `progress` 為選填欄位；舊 server／沒有進度檔時前端顯示不定長度條。
- 既有測試的 `FakeProvider` 呼叫次數不變（進度回呼不呼叫 provider）。
- `tests/fixtures/stub_build.py` 忽略多出來的參數（它只讀 `sys.argv[1]`），不需修改。

## 進度資料
```json
{"phase": "segment", "done": 3, "total": 12, "updatedAt": "2026-10-28T06:10:00+00:00"}
```
- 單位：`total = chunks + 3`（每個 chunk 1 單位、挑單字 2 單位、前情提要 1 單位）。
- 順序：每個 chunk 完成後 `("segment", i, total)`；挑單字開始 `("vocab", chunks, total)`；前情提要開始 `("intro", chunks + 2, total)`；全部完成 `("finish", total, total)`。

## 任務

### Task 1: build 回報進度
**Files:** Modify `pipeline/build.py`; Test `tests/test_build.py`。
- [ ] 測試：`build_lesson(raw, fake_provider(), progress=calls.append)` 後，`calls == [("segment",1,5),("segment",2,5),("vocab",2,5),("intro",4,5),("finish",5,5)]`（raw_small 有 2 個 chunk）。
- [ ] 測試：`main(["CR94QQXO_4s", "--progress-file", str(p)], ...)` 結束後檔案存在、`phase == "finish"`、`done == total`。
- [ ] 實作：`build_lesson(..., progress: Callable[[str, int, int], None] | None = None)`；先 `chunks = list(chunk_words(words))` 取得總數。CLI 加 `--progress-file PATH`：回呼把 JSON 寫到 `PATH.tmp` 再 `os.replace`，失敗吞掉 `OSError`。
- [ ] Commit: `feat(pipeline): build reports progress to --progress-file`

### Task 2: server 附上 progress
**Files:** Modify `pipeline/jobs.py`, `server.py`; Test `tests/test_jobs.py`, `tests/test_server_jobs.py`。
- [ ] 測試（jobs）：`BuildQueue._cmd(vid)` 預設指令尾端多 `--progress-file <log_dir>/<vid>.progress.json`（`cmd_factory`／`YTLEARN_BUILD_CMD` 也附加同參數）；`queue.progress(vid)` 在檔案不存在時回 `None`、存在時回 dict、JSON 壞掉時回 `None`；`_finish` 後檔案被刪除。
- [ ] 測試（server）：用 `STUB_MODE=slow` 讓工作停在 `building`，手動寫進度檔後 `GET /jobs/<id>` 回應含 `job.progress`；`done` 之後不含。
- [ ] 實作：`BuildQueue.progress_path(vid)`、`BuildQueue.progress(vid) -> dict | None`；`_run` 開始前先刪舊進度檔；`_finish` 刪檔。`server.py` 的 `GET /jobs/<id>`：`job["state"] == "building"` 時 `pub["progress"] = queue.progress(vid)`（`None` 則不放鍵）。
- [ ] Commit: `feat(server): /jobs/<id> carries build progress`

### Task 3: 卡片進度條
**Files:** Create `web/progress.js`; Modify `web/app.js`, `web/style.css`; Test `tests/web/progress.test.js`（加進 `tests/web/index.js`）。
- [ ] `web/progress.js` 純函式 `barState(job, elapsedSec) -> {mode, pct, label}`：
  - 無 job／`queued`／`capturing`／`captured` → `{mode:"indet", pct:0, label:"擷取字幕中… N 秒"}`（`captured` 用「等待產課…」）。
  - `building` 無 `progress` → `{mode:"indet", label:"準備中…"}`；有 → `mode:"det"`，`pct = round(done/total*100)`，label 依 phase：`segment` → `切句 ${done}/${chunks}`（`chunks = total - 3`）、`vocab` → `挑選單字`、`intro` → `前情提要`、`finish` → `收尾`。
  - `done` → `{mode:"done", pct:100, label:"完成"}`；`error` → `{mode:"error", pct: 上一次 pct（由呼叫端傳入 job.lastPct，預設 0）, label:""}`。
- [ ] 測試：上述每個分支一個斷言；`total` 為 0 或缺欄位時 `pct = 0` 且不拋例外。
- [ ] `app.js`：`mountCard` 記 `card.startedAt = Date.now()`、`card.lastPct = 0`；`renderCard` 在 `steps` 之後插入 `<div class="bar"><div class="bar-fill"></div></div><p class="bar-label">`；`startPolling` 之外，`queued/capturing` 期間每秒重畫一次以更新秒數（沿用 `card.timer` 的 `POLL_MS` 即可，不另開計時器；秒數顯示整數）。
- [ ] `style.css`：`.bar { height: 6px; background: #1c222d; border-radius: 3px; overflow: hidden; margin: .4rem 0 .2rem; }`、`.bar-fill { height: 100%; width: 0; background: var(--orange); transition: width .4s ease; }`、`.bar.done .bar-fill { background: var(--mint); }`、`.bar.error .bar-fill { background: #ff7a7a; }`、`.bar.indet .bar-fill { width: 35%; animation: bar-slide 1.3s ease-in-out infinite; }`、`@keyframes bar-slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }`、`.bar-label { margin: 0 0 .3rem; color: var(--muted); font-size: 13px; }`、reduced-motion 時停用動畫。
- [ ] 驗證：`node --test tests/web/`；實際貼一個新網址看三個階段的條；Commit: `feat(web): progress bar on the job card`

## Review Focus
1. build 被殺（逾時）後殘留的進度檔 → `_run` 開始前刪除、`_finish` 刪除，兩頭都清。
2. server 重啟後 `GET /jobs` 404 的既有路徑不受影響（卡片已顯示「server 已重啟」）。
3. `total - 3` 在 `segment` 階段算 chunks 數；若日後單位權重改了，label 會錯但條不會 → 把權重常數集中在 `pipeline/build.py` 並在 `progress.js` 註明來源。
4. 進度檔與 lesson 寫入的競態：進度檔只讀不寫入狀態，壞 JSON 回 `None`，前端退回不定長度條。
5. 手動匯入（`/ingest`）啟動的 build 走同一個 `BuildQueue`，自然有進度。

## Codex 審查後的裁定（2026-10-28）
- 進度檔路徑用環境變數 `YTLEARN_PROGRESS_FILE` 傳給子行程（CLI 旗標 `--progress-file` 仍可用，優先於環境變數）；`_cmd` 三條路徑都不改，自訂指令與 stub 不會收到未知旗標。
- 回呼測試用 `lambda phase, done, total: calls.append((phase, done, total))`。
- 暫存檔名帶 PID（同 lesson 寫入），寫失敗時刪暫存檔並忽略。
- `_run`：先刪舊進度檔再 `set_building`；`_finish` 刪檔包在 try 裡，清檔失敗不影響 `store.finish`。
- `queue.progress()` 直接 open 並捕捉 `OSError`／`ValueError`，不先 exists；`building` 但暫時沒有 progress 是正常狀態。
- payload 不含 `updatedAt`。文案稱「加權步驟進度」，不稱真實百分比。
- 不做每秒重畫：耗時秒數跟著既有 2 秒輪詢更新。不做寬度過渡動畫；流動條的 `animation-delay` 設為 `-(Date.now() % 週期)`，整卡重畫時相位連續。
- `card.lastPct` 在 `applyJob` 看到 `progress` 時更新，錯誤狀態的條用它。
- server 測試：stub 在 `STUB_MODE=slow` 時先把進度 JSON 寫到 `YTLEARN_PROGRESS_FILE` 再睡 3 秒；測試輪詢到 `building` 且有 `progress` 為止（上限 2.5 秒），之後等 `done` 並確認不含 `progress`。
- `/ingest` 走佇列的前提是已有工作；純手動匯入只寫 raw（既有行為，不在本計畫內）。
- Windows 不是目標平台（個人 macOS 工具），不另測。
