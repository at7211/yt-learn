# yt-learn：YouTube 雙字幕學習播放器 — Design + Implementation Plan (v2, 已納入 Codex review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本文件同時是 design spec 與 implementation plan（規格小，拆兩份只會重複）。§1–§4 是設計決定，§5 起是任務。v2 變更摘要在 §9。

**Goal:** 給一個 YouTube 網址，產出一個本機網頁播放器：原片用 YouTube 嵌入，上面疊「中英雙字幕（正在講的重點字上色）」與「右側單字面板」，片尾有單字總複習；對照 MJ English 頻道 `pMJ8j8MioIE` 的呈現方式。

**Architecture:** 三段式。(1) **擷取**：一段在 YouTube 分頁內執行的 bookmarklet 抓 YouTube 自帶的逐字時間戳字幕，優先 POST 到本機 server，失敗則讓使用者複製貼到播放器頁匯入，存成 `data/raw/<id>.json`。(2) **產課**：Python pipeline 把逐字稿切句、翻成繁中、挑單字，產出 `data/lessons/<id>.json`；LLM 透過本機已登入的 `claude -p` CLI 呼叫。(3) **播放**：純靜態 `web/`，YouTube IFrame API + DOM 疊層，從 lesson JSON 驅動。

**Tech Stack:** Python 3.14 標準庫（server、pipeline）、pytest、`claude` CLI 2.1.x、原生 HTML/CSS/JS（無框架、無打包；純函式用 ESM 方便 `node --test`）、YouTube IFrame Player API、Google Fonts（Noto Sans TC / Noto Serif TC / Inter）。

**Spec:** 本文件 §1–§4。

## Global Constraints

- 不下載影片檔、不產出影片；只做個人學習用的本機網頁（版權與 ToS 風險留在個人使用範圍）。
- 翻譯語言固定 **繁體中文（台灣用語）**，口語、短句，對齊影片風格（例：「這不是在講黨派立場，」）。
- 不依賴 `ANTHROPIC_API_KEY`；LLM 走 `claude -p --output-format json`。provider 介面要能日後換成 Anthropic SDK，但 v1 不實作 SDK 路徑。
- 不裝新的 Python 套件到系統；pipeline 只用標準庫；測試用 `uv run --with pytest pytest`；JS 純函式用 `node --test`。
- 時間單位：raw 用毫秒整數（跟 YouTube 一樣），lesson 與播放器用秒（float，3 位小數）。
- 每一步 LLM 輸出都要經過**結構驗證再索引**；驗證失敗一律 fallback 到不影響播放的保守值（§4），不可讓一次壞回應讓整支影片建不出來。
- 本機 server 固定 `127.0.0.1:8765`，不綁 `0.0.0.0`。
- 一個網址一支影片：`index.html?v=<id>`；換影片 = 換網址整頁重載，不做頁內切換。

## Review Focus

1. **手動字幕（非 ASR）沒有逐字時間戳**：同一 event 內所有字共用 start。預期：字幕逐句正常顯示，單字高亮退化為「整句期間亮」（不是發明逐字時間）。→ Task 2 `test_untimed_event_marks_words_untimed`、Task 7 `timing.test.js: activeHitAt_untimed_uses_cue_span`。
2. **LLM 回來的 `en_tokens` 數量跟字數不合**。預期：該句英文顯示退回原始字串，不中斷。→ Task 4 `test_token_count_mismatch_falls_back_to_raw`。
3. **LLM 給的單字範圍 `a..b` 跟原文對不上**（指到別句、越界、文字不符、型別錯）。預期：該筆丟掉並記 log，不出現錯位高亮。→ Task 5 `test_hit_text_mismatch_dropped`、`test_hit_bad_shape_dropped`。
4. **網址帶的 id 沒有 lesson、或 lesson JSON 壞掉**。預期：顯示「尚未產課」+ 精確的 build 指令，不白頁、不丟未捕捉例外。→ Task 7 Step 1 手動清單 + `timing.test.js` 不涉及；用 `web/app.js` 的 `loadLesson()` 錯誤分支手動驗。
5. **YouTube 分頁 POST 到 127.0.0.1 被 Chrome 擋**（Local Network Access 權限閘；今天實測一次 hang 45 秒）。預期：直接 POST 是「可選加速路徑」，失敗時 bookmarklet 在頁面上放出含 JSON 的 textarea 與複製鈕，播放器頁有貼上匯入框；整條路至少一條走得通並記錄 Chrome 版本。→ Task 1 Step 7 手動驗證三種情境（允許／拒絕／server 沒開）。

---

## 1. 目標畫面（從參考影片六個時間點歸納）

播放器主舞台是 16:9，以 1280×720 為設計座標，CSS 用百分比與 `clamp()` 縮放。**舞台底部 12% 是 YouTube 控制列保留區**：不放任何可點的疊層元素，字幕底緣在保留區之上。

**(a) 底部雙字幕（常態）**
- 英文：白色粗體無襯線（Inter 700），約 44px，深色陰影；**正在講到的那個 hit**（時間落在 `[words[hit.a].t, words[hit.b].e)`）整個詞變橘 `#F0A868`；同句其他尚未講到或已講過的重點字維持白色。
- 中文：金色 `#E8C87A` 襯線（Noto Serif TC），約 30px，在英文下方。
- 置中、英文最多兩行（超過時縮字級到 34px），中文一行（超過縮到 24px）；底緣貼在控制列保留區上方 2%。
- 字幕層 `pointer-events:none`。

**(b) 右側單字面板**
- 佔舞台 x 60%–97%、y 4%–84%；背景由左透明到右 `rgba(10,12,18,.85)` 的漸層。
- 頂部：細線 + 「本集精選 N 個字」（字距加寬、小字），右邊「k / N」。**定義**：N = 不重複 term 數；k = 開始時間 ≤ 目前時間的 hit 所對應的不重複 term 數（往回 seek 會變小）。
- 列表 = **所有 hits 依開始時間排平的序列**（同一 term 出現兩次就兩列，跟參考影片一致）。固定 5 列，當前列在第 3 列；當前列 = 開始時間 ≤ 目前時間的最後一個 hit；時間早於第一個 hit 時顯示前 5 列全部暗色、無當前列。
- 每列：第一行 term（薄荷綠 `#A8D8B9`，Inter 600）+ 右側「×n」（n = 該 term 總 hit 數）；第二行中文（灰白）。**當前列**：底色淡亮、term 變橘，並附 pos 與 IPA。（v1 不做右側小圓點。）
- 列可點（`pointer-events:auto`）→ seek 到該 hit 開始前 0.3s。

**(c) 片尾總複習**
- `onStateChange === ENDED` 時舞台切成深色卡片：「總複習／本集精選 N 個字」，3 欄 × 6 列 = 18 字一頁，按 `id` 排序分頁；每字有 pos、中文，總 hit 數 ≥2 顯示「×n」膠囊；右上角文字「截圖存下來」只是提示語，**不實作匯出**。
- 複習模式下 `←/→` 翻頁；點任一字 → 離開複習、seek 到第一個 hit 前 0.3s 並播放。

**(d) 舞台下方（參考影片沒有、網頁才有的互動）**
- 全文逐句列表（點句跳播、當前句高亮並自動捲入可視範圍）、單字總表（點字跳到第一個 hit）。
- 自備「播放／暫停」按鈕與「重播本句」按鈕（因為 iframe 取得焦點時鍵盤事件到不了父頁）。
- 鍵盤（僅在焦點不在 `input/textarea` 且非複習模式時）：`Space` 播放/暫停、`←/→` 上一句/下一句、`R` 重播本句、`Z` 切換中文、`E` 切換英文。
- 全螢幕：playerVars `fs:0` 關掉 YouTube 原生全螢幕；自備按鈕對 stage 元素 `requestFullscreen()`，疊層跟著進去。

**Non-goals（v1 不做）**：開場鉤子版型（v2：只允許全片前三句、連續前綴）、查證卡、會員卡與推薦卡、影片輸出、多語言、帳號/雲端儲存、頁內切換影片、單字面板出現次數圓點。

## 2. 資料格式

**`data/raw/<videoId>.json`**（bookmarklet 或匯入框產出）
```json
{"videoId":"CR94QQXO_4s","title":"...","channel":"CTV News","duration":344,
 "lang":"en","kind":"asr","capturedAt":"2026-10-27T23:00:00+08:00","chrome":"142.0.7444.60",
 "events":[{"t":280,"d":5160,"segs":[[0,"pretends"],[400,"like"],[560,"he's"],[840,"self-made"]]},
           {"t":5600,"d":2100,"segs":[[null,"what a clown"]]}]}
```
- `events[].t/d` 毫秒；`segs[i] = [offsetMs | null, text]`。`offsetMs = null` 表示該 seg 沒有逐字時間（手動字幕）。
- 匯入驗證（server 與 build 都做）：`videoId` 符合 `^[A-Za-z0-9_-]{11}$`；`events` 非空、`t` 為非負整數且非遞減、`d ≥ 0`；每 seg 是長度 2 的陣列、text 非空字串；`title/channel/duration/lang/kind` 必填。

**`data/lessons/<videoId>.json`**（pipeline 產出；播放器唯一輸入）
```json
{
 "videoId":"CR94QQXO_4s","title":"...","channel":"...","duration":344,"lang":"en",
 "generatedAt":"2026-10-27T23:00:00+08:00","model":"claude-sonnet-5-5","promptVersion":1,
 "coveredSeconds":344,
 "words":[{"t":0.28,"e":0.68,"w":"pretends","timed":true}, ...],
 "cues":[{"a":0,"b":6,"en":"Pretends like he's self-made. What a clown.",
          "tokens":["Pretends","like","he's","self-made.","What","a","clown."],
          "zh":"假裝自己白手起家，真是個小丑。"}],
 "vocab":[{"id":0,"term":"run your mouth","pos":"phr.","ipa":null,"zh":"嘴砲、亂講話",
           "hits":[{"cue":3,"a":46,"b":48}]}]
}
```
- `words` 由 events 攤平：有 offset 的 seg → 一個字，`t = (ev.t+offset)/1000`、`timed=true`；offset 為 null 的 seg → 以空白切成多個字，全部 `t = ev.t/1000`、`timed=false`。
- `words[i].e` = 下一字的 `t`（若相同則下一個不同的 `t`），上限 `t+1.5`；最後一字 `e = min(t+1.0, duration)`。
- `cues[].a..b` **含頭含尾** word index；`tokens` 與 `words[a..b]` 一一對應（長度 `b-a+1`），是加了大小寫、標點、拼字修正的顯示版；`en = " ".join(tokens)`。本例 `a:0,b:6` 對應 7 個 token。此範例即 `tests/fixtures/lesson_min.json`。
- `vocab[].hits[]` 的 `a..b` 是 word index，必須落在 `cues[cue]` 的 `a..b` 內；`count = len(hits)`，播放器自己算。
- cue 的顯示區間 `[words[a].t, words[b].e)`；cue 連續不重疊。
- `coveredSeconds < duration` 代表 preview 產物，播放器頂部顯示「僅前 N 秒」橫幅。

## 3. 元件與檔案

```
yt-learn/
  server.py                  靜態 + POST /ingest + GET /lessons
  bookmarklet.js             貼進 YouTube 分頁 console 或做成書籤
  pipeline/
    __init__.py
    schema.py                raw 與 lesson 的驗證函式（server 與 build 共用）
    words.py                 raw events → 帶 e/timed 的 words（秒）
    chunk.py                 words → LLM 分批範圍 [(a,b)]
    llm.py                   Provider 介面：ClaudeCli、Fake；complete_json()
    segment.py               每批 → cues（切句 + tokens + zh），含結構驗證與規則式 fallback
    vocab.py                 cues → vocab（LLM 挑 + 驗證 + 補掃同形出現）
    build.py                 CLI：python3 -m pipeline.build <videoId> [--limit-seconds N] [--model M] [--force]
  web/
    index.html  app.js  style.css
    timing.js                純函式（ESM）：cueIndexAt / activeHitAt / panelState / seenCount
  tests/
    test_schema.py test_server.py test_words.py test_chunk.py test_segment.py test_vocab.py test_build.py
    fixtures/raw_small.json  （CR94QQXO_4s 前 60 秒的 events）
    fixtures/lesson_min.json （§2 範例）
    web/timing.test.js       （node --test）
  data/raw/  data/lessons/  data/cache/<videoId>/<sha>.json
```

## 4. LLM 呼叫設計

- **Provider 介面** `complete_json(system: str, user: str) -> dict`。`ClaudeCliProvider(model: str | None, cache_dir: Path | None)` 執行 `claude -p --output-format json --system-prompt <system> [--model M]`，`user` 走 stdin，timeout 180s；讀 stdout JSON 的 `result` 欄位，剝掉 ```json fence 後 `json.loads`；非 dict、非法 JSON、CLI 非零退出或 timeout → 重試 1 次（prompt 尾端附「上一次輸出不是合法 JSON」）；再失敗 raise `ProviderError`。**快取 key** = `sha256(json.dumps({"model": model or "default", "promptVersion": 1, "system": system, "user": user}, sort_keys=True))`；快取檔內含 `model` 與 `promptVersion`，不符視為 miss。
- **分批**：`chunk.py` 以 `words[i+1].t - words[i].t ≥ 1.0` 為可切點；從 `a` 起找 `[a+target-30, a+target+30]` 視窗內最靠近 `a+target` 的可切點，沒有則在 `a+hard_max-1` 硬切；`target=120, hard_max=160`。
- **segment prompt** 給「編號字列表」`i: word`，要求回 `{"cues":[{"a":int,"b":int,"tokens":[str],"zh":str}]}`，規則：cue 覆蓋整批不重疊不遺漏、每 cue ≤ 14 字、`tokens` 長度必須等於 `b-a+1`、可修正 ASR 拼字但不得增減 token、zh 繁中台灣口語。
- **segment 驗證順序**（`segment.validate_cues(resp, a, b) -> list[dict] | None`）：(1) 結構：`cues` 是 list、每項 `a,b` 為 int、`tokens` 是 list[str]、`zh` 是 str；(2) 範圍：`a ≤ b`、都在 `[a_chunk, b_chunk]`；(3) 排序後連續無重疊且覆蓋整批。任一不符 → 整批回 `None`，由 `rule_cues(words, a, b)` 以「gap ≥ 1.0 或滿 14 字」規則切句、`tokens=原字`、`zh=""`。結構全對但單一 cue `len(tokens) != b-a+1` → 只有該 cue `tokens=原字`。`ProviderError` → 同規則 fallback 並印 warning。
- **vocab prompt** 一次給整支影片的 cues（編號 + tokens），挑「中級學習者值得學、在這支影片語境裡有意思」的單字與片語，數量目標 `≈ 字數/10`、上限 120，回 `{"vocab":[{"term","pos","ipa","zh","hits":[{"cue","a","b"}]}]}`。pos 限 `n. v. adj. adv. phr. idiom`；單字給 IPA，片語 `ipa: null`。`ProviderError` → `vocab=[]` 並印 warning。
- **vocab 驗證**（純函式）：hit 結構與型別正確、`cue` 存在、`a..b` 在該 cue 內；`norm(words[a..b])` 或 `norm(cues[cue].tokens[對應切片])` 其一等於 `norm(term)`（`norm` = 小寫、去除首尾標點、空白正規化；**不做詞形變化**）；不符丟棄；term 無 hit 則整筆丟棄；同 term 以 `(cue,a,b)` 去重。`expand_hits(vocab, cues, words)`：用 term 的 norm token 序列掃全片 `words`，新 hit 需能定位到唯一 cue 且在其範圍內，否則不加。

---

## 5. Tasks

### Task 1: 擷取端（schema + server + bookmarklet + 匯入框）

**Files:**
- Create: `pipeline/__init__.py`, `pipeline/schema.py`
- Modify: `server.py`
- Create: `bookmarklet.js`, `web/index.html`（先只有匯入框 + lesson 清單）
- Test: `tests/test_schema.py`, `tests/test_server.py`

**Interfaces:**
- Produces: `schema.validate_raw(obj) -> list[str]`（錯誤訊息列表，空 = 合法）；`schema.VIDEO_ID_RE`。
- Produces: `POST /ingest` body = raw JSON（§2）→ 200 `{"ok":true,"videoId","events":N,"next":"python3 -m pipeline.build <id>"}`；400 `{"ok":false,"errors":[...]}`。寫入 `<root>/data/raw/<id>.json`。
- Produces: `GET /lessons` → `[{"videoId","title","channel","duration","vocabCount","coveredSeconds"}]`。
- Produces: `Handler.root: Path` class attribute；`make_server(root, port) -> ThreadingHTTPServer`。

- [ ] **Step 1: 失敗測試** `tests/test_schema.py`：`test_valid_raw_ok`（§2 範例）、`test_rejects_bad_video_id`（`"../x"`、長度 10）、`test_rejects_unsorted_events`、`test_rejects_bad_seg_shape`（`["x"]`、`[0, ""]`）、`test_rejects_missing_meta`。
- [ ] **Step 2: 失敗測試** `tests/test_server.py`（`make_server(tmp_path, 0)` 於 thread 啟動）：`test_ingest_writes_raw_file`、`test_ingest_400_lists_errors`、`test_options_preflight_headers`（204、`Access-Control-Allow-Origin: *`、`Access-Control-Allow-Private-Network: true`）、`test_data_path_traversal_sibling_blocked`（建立 `tmp/data-backup/x.json`，GET `/data/../data-backup/x.json` → 404）、`test_lessons_lists_root_dir_only`。
- [ ] **Step 3: 跑測試確認失敗**：`uv run --with pytest pytest tests/test_schema.py tests/test_server.py -v`。
- [ ] **Step 4: 實作** `schema.py`、`server.py`（路徑包含用 `Path.resolve()` + `is_relative_to`；`/ingest` 用 `validate_raw`，不用 `assert`）。
- [ ] **Step 5: 跑測試確認通過**。
- [ ] **Step 6: 寫 `bookmarklet.js`**（IIFE，可貼 console）：(1) 讀 `ytInitialPlayerResponse.videoDetails.videoId` 與 `captionTracks`，沒有字幕軌 → `console.warn` 並結束；(2) 開 CC → 播 2 秒 → 暫停；(3) 從 `performance.getEntriesByType('resource')` 取 `/api/timedtext` 中 **`v=` 等於當前 videoId 且無 `tlang` 參數** 的最後一筆；沒有 → 提示「請手動開啟 CC 再執行」；(4) 加 `fmt=json3` 重抓，檢查 `events` 非空且最後一個 event 的 `t ≤ duration*1000`；(5) 組 §2 raw（`segs` 的 offset 用 `tOffsetMs ?? null`；text 去掉 `\n`，空白跳過；`chrome` 取自 `navigator.userAgentData?.brands`）；(6) `fetch` POST，`AbortController` 5 秒，`response.ok` 才算成功；(7) 失敗任一步 → 在頁面右下角插入 `position:fixed` 面板：`<textarea readonly>`（內容 = JSON，自動 select）+「複製」按鈕（`navigator.clipboard.writeText`，失敗也沒關係，使用者可手動複製）+ 說明「貼到 http://127.0.0.1:8765 的匯入框」。全程不用 `alert`。
- [ ] **Step 7: 寫 `web/index.html` 最小版**：標題；`<textarea id="import">` +「匯入」按鈕（POST 同源 `/ingest`，成功後顯示 `next` 指令與「產課完成後重新整理」）；lesson 清單（`GET /lessons`，每項連到 `index.html?v=<id>`）。
- [ ] **Step 8: 手動驗證三情境**（server 已啟動；Chrome 擴充在 `https://www.youtube.com/watch?v=CR94QQXO_4s` 執行 `bookmarklet.js`）：(a) 允許本機網路 → server log `[ingest] CR94QQXO_4s ...`；(b) 拒絕/被擋 → 頁面出現 textarea，貼到匯入框 → 同一檔案產生；(c) server 沒開 → 5 秒內出現 textarea。把走通的路徑與 Chrome 版本記到 §8。
- [ ] **Step 9: Commit** `feat(ingest): schema, local server, youtube bookmarklet, import box`

### Task 2: words 正規化

**Files:** Create `pipeline/words.py`; Test `tests/test_words.py`; fixture `tests/fixtures/raw_small.json`（從 `data/raw/CR94QQXO_4s.json` 取 `t < 60000` 的 events）。

**Interfaces:**
- Produces: `normalize_words(events: list[dict], duration: float) -> list[dict]`，回 `[{"t","e","w","timed"}]`，§2 規則。

- [ ] **Step 1: 失敗測試**
  - `test_timed_segs_become_words_with_end_capped`：`[{"t":0,"d":6000,"segs":[[0,"a"],[500,"b"],[5000,"c"]]}]`, duration 10 → `t=[0,0.5,5.0]`、`e=[0.5,2.0,6.0]`、全部 `timed=True`。
  - `test_untimed_event_marks_words_untimed`：`[{"t":1000,"d":2000,"segs":[[null,"we can go"]]},{"t":3000,"d":1000,"segs":[[0,"now"]]}]` → 前三字 `t=1.0`、`timed=False`、`e=3.0`；第四字 `timed=True`。
  - `test_last_word_end_clamped_to_duration`：最後一字 `t=9.5`, duration 10 → `e=10.0`。
  - `test_strips_entities_newlines_and_blank`：`"&#39;"`→`"'"`、`"\n"` 與 `""` 跳過。
- [ ] **Step 2: FAIL** → **Step 3: 實作** → **Step 4: PASS** → **Step 5: Commit** `feat(pipeline): normalize words`

### Task 3: 分批

**Files:** Create `pipeline/chunk.py`; Test `tests/test_chunk.py`.

**Interfaces:**
- Produces: `chunk_words(words, target=120, hard_max=160, gap=1.0, window=30) -> list[tuple[int,int]]`，含頭含尾、連續、覆蓋全部；規則見 §4。

- [ ] **Step 1: 失敗測試**
  - `test_chunks_cover_all_words_contiguously`（fixture）。
  - `test_picks_gap_closest_to_target_within_window`：150 字、間隔 1.2s 在 index 100 與 125 後 → 第一批 `(0,125)`（125 比 100 靠近 120）。
  - `test_gap_uses_next_start_minus_current_start`：字 i `t=10.0,e=11.5`、字 i+1 `t=10.9` → 不是切點；字 i+1 `t=11.0` → 是切點。
  - `test_hard_max_forces_split_without_gap`：200 字零間隔 → 每批 ≤ 160。
- [ ] Step 2 FAIL → Step 3 實作 → Step 4 PASS → **Step 5: Commit** `feat(pipeline): chunk words`

### Task 4: LLM provider + 切句翻譯

**Files:** Create `pipeline/llm.py`, `pipeline/segment.py`; Test `tests/test_segment.py`, `tests/test_llm.py`。

**實作前先載入 `claude-api` skill 確認 CLI flags 與 model id。**

**Interfaces:**
- Produces: `class Provider(Protocol): def complete_json(self, system: str, user: str) -> dict`；`class ProviderError(Exception)`。
- Produces: `ClaudeCliProvider(model: str | None = None, cache_dir: Path | None = None, prompt_version: int = 1)`、`FakeProvider(responses: list[dict | Exception])`。
- Produces: `segment.validate_cues(resp: dict, a: int, b: int) -> list[dict] | None`、`segment.rule_cues(words, a, b, max_words=14) -> list[dict]`、`segment.make_cues(words, chunk, provider) -> list[dict]`、`segment.finalize_cues(cues, words) -> list[dict]`（補 `en`、排序、斷言全片覆蓋）、`SEGMENT_SYSTEM`、`segment_user_prompt(words, a, b)`。

- [ ] **Step 1: 失敗測試** `tests/test_llm.py`（全部 monkeypatch `subprocess.run`）：`test_parses_result_field_and_strips_fence`、`test_cache_hit_skips_subprocess`、`test_cache_key_includes_model`（同 prompt 不同 model → 不同檔）、`test_retries_once_on_invalid_json_then_succeeds`、`test_raises_provider_error_after_two_failures`、`test_nonzero_exit_is_failure`、`test_timeout_is_failure`、`test_missing_cli_raises_provider_error`（`FileNotFoundError`）。煙霧測試 `test_live_cli_smoke` 以 `@pytest.mark.skipif(not os.environ.get("YTLEARN_LIVE"))` 跳過。
- [ ] **Step 2: 失敗測試** `tests/test_segment.py`：`test_cues_cover_chunk_and_tokens_align`、`test_token_count_mismatch_falls_back_to_raw`（只該 cue 退回原字）、`test_overlapping_cues_reject_batch_to_rule_cues`、`test_out_of_range_index_rejects_batch`、`test_bad_types_reject_batch`、`test_provider_error_uses_rule_cues_with_empty_zh`、`test_rule_cues_split_on_gap_or_14_words`。
- [ ] Step 3 FAIL → Step 4 實作 → Step 5 PASS → **Step 6: Commit** `feat(pipeline): claude cli provider + segmentation with fallbacks`

### Task 5: 單字挑選與驗證

**Files:** Create `pipeline/vocab.py`; Test `tests/test_vocab.py`.

**Interfaces:**
- Consumes: Task 4 `Provider`/`ProviderError`、cues；Task 2 words。
- Produces: `pick_vocab(cues, words, provider, max_items=120) -> list[dict]`（§2 vocab，`id` 依第一個 hit 的 `words[a].t` 排序重編）；純函式 `norm(s) -> str`、`validate_hits(vocab_raw, cues, words) -> list[dict]`、`expand_hits(vocab, cues, words) -> list[dict]`。

- [ ] **Step 1: 失敗測試**
  - `test_hit_text_mismatch_dropped`、`test_hit_bad_shape_dropped`（`a` 是字串、`cue` 不存在）、`test_hit_outside_cue_dropped`。
  - `test_hit_matches_corrected_token_when_raw_is_asr_typo`：raw `hofa`、token `Hoffa.`、term `Hoffa` → 通過。
  - `test_no_inflection_matching`：term `expose`、字 `exposed` → 丟棄。
  - `test_expand_finds_other_exact_occurrences_within_a_cue`：`thug` 只給 1 hit、全片 3 處 → 3 hits；跨 cue 邊界的序列不加。
  - `test_ids_ordered_by_first_hit_time`、`test_max_items_cap`、`test_provider_error_returns_empty`。
- [ ] Step 2 FAIL → Step 3 實作 → Step 4 PASS → **Step 5: Commit** `feat(pipeline): vocab selection with exact-match validation`

### Task 6: build CLI 與端到端產課

**Files:** Create `pipeline/build.py`; 補 `schema.validate_lesson(obj) -> list[str]`；Test `tests/test_build.py`。

**Interfaces:**
- Produces: `build_lesson(raw, provider, limit_seconds=None) -> dict`；CLI `python3 -m pipeline.build <videoId> [--limit-seconds N] [--model M] [--force]`：讀 `data/raw/<id>.json` → 寫 `data/lessons/<id>.json`；**若既有 lesson 的 `coveredSeconds ≥ duration` 而本次是 preview，拒絕覆寫除非 `--force`**；結束印 cue 數、vocab 數、LLM 呼叫數、快取命中數、耗時。

- [ ] **Step 1: 失敗測試**：`test_build_with_fake_provider_matches_schema`（fixture → `validate_lesson` 空）、`test_limit_seconds_sets_covered_seconds`、`test_preview_refuses_to_overwrite_full_lesson`、`test_lesson_min_fixture_is_valid`。
- [ ] Step 2 FAIL → Step 3 實作 → Step 4 PASS
- [ ] **Step 5: 真跑一次（便宜版）**：`python3 -m pipeline.build CR94QQXO_4s --limit-seconds 60` → 人工讀譯文與單字，prompt 調整一輪以內。
- [ ] **Step 6: 全片**：`python3 -m pipeline.build CR94QQXO_4s` → 數字記到 §8。
- [ ] **Step 7: Commit** `feat(pipeline): build cli`（`data/lessons/CR94QQXO_4s.json` 一併進版）

### Task 7: 播放器

**Files:** Modify `web/index.html`; Create `web/timing.js`, `web/app.js`, `web/style.css`; Test `tests/web/timing.test.js`（`node --test tests/web/`）。

**Interfaces:**
- Consumes: `GET /data/lessons/<id>.json`、`GET /lessons`。
- Produces（`timing.js`，ESM 純函式）：
  - `cueIndexAt(cues, words, t) -> number` （-1 = 無）
  - `activeHitAt(flatHits, words, t) -> {vocabId, hitIdx} | null`：`flatHits` 由 `flattenHits(vocab, words)` 產生（依 `words[a].t` 排序）；當 `words[a].timed === false` 時區間改用所屬 cue 的 `[words[cue.a].t, words[cue.b].e)`。
  - `panelState(flatHits, words, t) -> {current: number, rows: number[]}`（current = 開始 ≤ t 的最後一個 index 或 -1；rows = 以 current 為中心的 5 個 index，邊界夾住）
  - `seenCount(flatHits, words, t) -> number`（不重複 vocabId 數）

- [ ] **Step 1: 失敗測試** `timing.test.js`：`cueIndexAt_boundaries_inclusive_start_exclusive_end`、`cueIndexAt_silence_returns_minus_one`、`activeHitAt_only_during_hit_interval`（同句另一個重點字不亮）、`activeHitAt_untimed_uses_cue_span`、`activeHitAt_overlap_later_start_wins`、`panelState_before_first_hit`、`panelState_centered_and_clamped`、`seenCount_decreases_after_backward_seek`、`zero_vocab_everything_empty`。
- [ ] **Step 2: FAIL** → **Step 3: 實作 `timing.js`** → **Step 4: PASS**。
- [ ] **Step 5: 骨架 `app.js`**：`loadLesson(id)`：無 `?v` → 顯示 lesson 清單與匯入框；fetch 404 或 JSON 解析失敗 → 顯示「尚未產課」+ `python3 -m pipeline.build <id>`；成功 → 建 stage、YouTube IFrame（`playerVars: {controls:1, rel:0, fs:0, cc_load_policy:0}`）。**時間迴圈**：`setInterval(100ms)`，只在 `getPlayerState() === PLAYING` 時讀 `getCurrentTime()` 更新；`onStateChange` 為 PAUSED/BUFFERING/ENDED 與每次自家 `seekTo` 後立刻讀一次並重繪；不做外推。`coveredSeconds < duration` 顯示橫幅。
- [ ] **Step 6: 字幕層**（§1a）。
- [ ] **Step 7: 單字面板**（§1b）。
- [ ] **Step 8: 片尾複習**（§1c）與鍵盤模式切換。
- [ ] **Step 9: 舞台下方**（§1d）：逐句列表、單字總表、播放/暫停與重播本句按鈕、stage 全螢幕按鈕、快捷鍵（焦點在 `input/textarea` 時忽略）。
- [ ] **Step 10: 視覺驗收**：Chrome 開 `http://127.0.0.1:8765/index.html?v=CR94QQXO_4s`，截圖：0:08、0:45、2:20（對照參考影片三格：字幕位置/字級/顏色、面板 5 列與當前列、k/N）、一句最長英文（兩行 + 縮字）、一句最長中文、複習第 1 頁與最後一頁、瀏覽器寬度 900px。手動測：暫停時高亮不前進、播放速度 1.5x 仍同步、往回 seek 後 k 變小、YouTube 控制列可點（進度條、音量）。列差異修到「一眼看過去像同一套版型」。
- [ ] **Step 11: Commit** `feat(web): player`

### Task 8: 收尾驗證

- [ ] `uv run --with pytest pytest -q && node --test tests/web/` 全綠；貼輸出。
- [ ] 一支**新的**影片（非開發用那支）從 bookmarklet 走到播放器全程跑一次，記錄卡關點到 §8。
- [ ] 依 `~/.claude/CLAUDE.md` 規則 1，派一個 fresh context（`opus`）做整支 branch review，重點：§Review Focus 五項、控制列保留區是否真的沒被擋、LLM 驗證 fallback 是否真的不會炸、`timing.js` 邊界。
- [ ] 把實測數字補到 §8。

---

## 6. 已知風險與處置

| 風險 | 處置 |
|---|---|
| YouTube 字幕端點需要 `pot` token，無法在 server 端抓（今天 yt-dlp 即使指定 Node runtime 仍被 bot 驗證擋） | 擷取固定在使用者瀏覽器內做（bookmarklet），server 只收。不要花時間在 cookies 路線上。 |
| Chrome Local Network Access 權限閘擋 https→127.0.0.1 POST | 直接 POST 是可選路徑；textarea + 匯入框是保底路徑（Task 1 Step 8 驗三情境）。 |
| ASR 錯字（`hofa`→Hoffa、`Mullen`→Mullin、`colle`）| segment prompt 允許在 `tokens` 修正拼字但不得增減 token 數；vocab 驗證同時接受原字或修正字。 |
| `claude -p` 每支影片約 6–10 次呼叫、每次 10–40 秒 | 快取（含 model）+ `--limit-seconds` 開發；可接受。 |
| iframe 取得焦點後鍵盤事件到不了父頁 | 自備播放/暫停與重播按鈕；快捷鍵為加分項。 |
| 在 iframe 上疊 DOM 違反 YouTube 嵌入條款的「不得遮蔽播放器」精神 | 僅個人本機使用；不公開部署；控制列保留區不遮。 |

## 7. 待使用者決定（不阻塞開工，先用假設）

- **假設 A**：LLM 預設模型 `claude-sonnet-5-5`；要更好的譯文可 `--model claude-opus-5-5`。
- **假設 B**：單字量目標 ≈ 字數/10、上限 120（參考影片 10 分鐘 106 個字）。
- **假設 C**：每個 task 結尾的 commit 需要你授權一次；若不授權，就全部做完後由你決定。

## 8. 實測記錄

（Task 1/6/8 完成後填：Chrome 版本與走通的擷取路徑、LLM 呼叫數、耗時、vocab 數）

**Task 1 擷取端（Step 8 實測）**：Chrome 155。從 https://www.youtube.com 直接 POST 到 http://127.0.0.1:8765 從未抵達 server（log 沒有 preflight），5 秒後 abort → 出現保底面板 → 按「複製」→ 貼進匯入框 → `POST /ingest` 200 → `data/raw/CR94QQXO_4s.json`（144 events、1046 words）。結論：在此 Chrome 上保底路徑才是可行路徑；直接路徑需使用者授予本機網路權限。

- **Task 6 build（全片實測）**：`python3 -m pipeline.build CR94QQXO_4s` → cues=142 vocab=42 llm_calls=9 cache_hits=1 seconds=160.6（模型 claude-sonnet-5-5，無 rule-cue fallback；60 秒 preview 第一次有一個 chunk 因模型跳號 fallback，prompt 加強索引連續性後解決）
- Task 8 收尾（2026-10-28）：全新影片 `GqD0rhajhr0`（Howard Stern Show / Trevor Noah，166 s）從 bookmarklet 保底面板 → 匯入框 → `POST /ingest`（81 events、603 segs、0 個 null offset）→ `python3 -m pipeline.build`：cues=62 vocab=28 llm_calls=6 cache_hits=0 seconds=102.3，無規則切句退回 → 播放器 `?v=GqD0rhajhr0` 在 21.5 s 正確高亮 `fly on the radar`、面板 4 / 28。測試：pytest 74 passed / 1 skipped，node --test 10 pass。

## 9. v2 變更摘要（對 Codex review 的處置）

採納：raw 保留 events/offset 並標 `timed`；手動字幕高亮退化為整句；直接 POST 降為可選 + textarea/匯入框保底；bookmarklet 驗證 `v=` 與非翻譯軌；segment 先驗結構再索引、整批壞 → 規則切句、provider 死 → vocab 空；快取 key 含 model/promptVersion；vocab 驗證同時比對原字與修正 token、不做詞形變化、expand 以 cue 為界；server 路徑用 resolve 包含檢查、ingest 走 schema 驗證；時間迴圈改狀態感知輪詢、不外推；高亮只在 active hit 區間；控制列保留區、`fs:0` + stage 全螢幕、快捷鍵焦點規則；`timing.js` 純函式 + `node --test`；CLI 失敗測試、live smoke opt-in；preview 不覆蓋完整 lesson、`coveredSeconds` 橫幅；匯入後顯示 build 指令；§2 範例 `b:6`；gap 公式明確化；複習模式方向鍵語義；「截圖存下來」只是提示語；砍開場鉤子與面板圓點。

不採納：面板列改為不重複單字（參考影片就是依出現排平，保留並補定義）；五列置中面板延後（是辨識度核心，保留）；頁內切換 lesson 的清理（v1 換網址整頁重載，不存在此問題）。
