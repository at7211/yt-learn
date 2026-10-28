# 左上角「前情提要」卡 — 設計與計畫

**Goal:** 每堂課多一張 LLM 產生的背景卡，影片第一次開始播放時顯示在畫面左上角約 10 秒後淡出，模仿參考影片（MJ English）的「前情提要」。

**Spec / 觀察依據:** `docs/superpowers/notes/2026-10-28-reference-layout-observations.md`（0:25 有卡、1:00 已消失；結構＝眉標「前情提要」→ 粗體主標兩行 → 細線 → 兩行補充）。

**Architecture:** pipeline 多一個獨立 LLM 呼叫 `make_intro()`，輸出寫進 lesson JSON 的選填欄位 `intro`；舊 lesson 沒有該欄位時播放器不顯示卡片。web 端純 DOM＋CSS 淡入淡出，計時器掛在第一次 `PLAYING`。

## Global Constraints
- Python 3 標準庫；LLM 走既有 `Provider.complete_json(system, user, schema)`；失敗（`ProviderError`、格式不符）**不得**讓整個 build 失敗，只記 `stats["intro_failed"] = 1` 並省略欄位。
- `intro` 為**選填**；`validate_lesson` 對舊 lesson（無欄位）維持通過。
- 文字全為繁體中文（台灣用語）；人名、機構名保留原文或通用中譯（由 LLM 決定，不強制）。
- 不改既有 `promptVersion`（新呼叫有自己的 cache key，不影響舊 cache）。
- 無新依賴、無打包。

## 資料格式
```json
"intro": { "title": "2023 年 11 月 14 日\n參議院勞工委員會", "lines": ["參議員 Mullin 質詢", "工會會長 O'Brien 作證"] }
```
- `title`: 非空字串，最多 **2 行**（以 `\n` 分行），每行去頭尾空白後非空且 ≤ 14 個字元。
- `lines`: 1–2 個字串，每個去頭尾空白後非空、≤ 22 個字元（原 18，三支影片中有兩支被擋，2026-10-28 放寬）、不含換行。
- 任何欄位不得含 `\n` 以外的控制字元；`intro` 非物件、`title` 非字串、`lines` 非陣列 → 錯誤。
- 任一條件不符 → 視為失敗（省略欄位），不做截斷修補。

## LLM 呼叫（`pipeline/intro.py`）
- `INTRO_SYSTEM`：角色＝替英文影片寫「前情提要」卡的編輯；要求：主標寫**場合或主題**（字幕或標題裡有明確日期、事件才寫日期＋事件；否則寫主題），補充行寫**人物與角色**或**背景一句**；**只能用字幕、標題、頻道名裡出現的事實，不得補上任何未出現的日期、地點、人名、職稱；不確定講者是誰時寫主題，不要把頻道名當講者**；不要劇透結論；不要出現「本影片」字樣；嚴格遵守字數。system prompt 開頭含 `[intro-prompt v1]` 版本標記：修 prompt 或驗證時 bump 它，讓舊的（可能無效的）cache 失效。
- `intro_user_prompt(title, channel, duration, cues)`：影片標題、頻道、長度，以及**前 40 句**字幕英文（`#編號: 句子`），加一行「全片共 N 句」。
- `INTRO_SCHEMA`：`{"type":"object","properties":{"title":{"type":"string"},"lines":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":2}},"required":["title","lines"]}`。
- `make_intro(meta: dict, cues: list[dict], provider, stats: dict | None = None) -> dict | None`
  - `meta` 取 `title / channel / duration`。
  - 回傳驗證後的 `{"title","lines"}`，或 `None`（並 `stats["intro_failed"] = 1`，印一行 warning 到 stderr，風格同 `vocab._warn`）。
  - 回答被驗證拒絕時**重試一次**，user message 尾端加 `RETRY_NOTE`（prompt 不同 → cache key 不同，避免壞答案卡在 cache）；provider 錯誤不重試。
  - 模型常把換行寫成字面的「反斜線 n」兩個字元：驗證前先轉成真正換行。
  - 驗證函式獨立：`validate_intro(obj) -> list[str]`，供 `schema.validate_lesson` 重用。

## 任務

### Task 1: `pipeline/intro.py` ＋ schema
**Files:** Create `pipeline/intro.py`; Modify `pipeline/schema.py`（`validate_lesson` 內：有 `intro` 時呼叫 `validate_intro`，錯誤前綴 `intro: `）; Test `tests/test_intro.py`。
- [ ] 測試：`FakeProvider([{"title":"主題","lines":["講者 A"]}])` → `make_intro` 回傳同值；`stats` 無 `intro_failed`。
- [ ] 測試：`title` 三行、`title` 單行 17 字、`lines` 為空、`lines` 3 個、`lines` 含空字串 → 各回 `None` 且 `stats["intro_failed"] == 1`。
- [ ] 測試：provider 丟 `ProviderError` → `None`，不拋例外。
- [ ] 測試：`intro_user_prompt` 只含前 40 句、含「全片共 N 句」。
- [ ] 測試：`validate_lesson(lesson_min)` 仍通過；加合法 `intro` 通過；`intro` 為 `null`、`intro.lines` 為字串、`title` 只有空白、`lines` 含換行、含 `\t` → 各回錯誤。
- [ ] 實作並跑 `python3 -m pytest tests/test_intro.py tests/test_schema.py -q`。
- [ ] Commit: `feat(pipeline): intro card generation + schema`

### Task 2: 接進 `build_lesson`
**Files:** Modify `pipeline/build.py`; Test `tests/test_build.py`。
- [ ] 測試：provider 依序回 segment×chunks / vocab / intro 的 Fake 回應時，`lesson["intro"]` 存在；intro 回應不合法時 `"intro" not in lesson` 且 `stats["intro_failed"] == 1`、build 回傳正常。
- [ ] **既有 `tests/test_build.py` 全部 fake provider 補第 4 個回應**（合法 intro 或 `ProviderError`），精確比對 `stats` 的斷言加 `"intro_failed"`；`FakeProvider` 用完會丟 `AssertionError`，不是 `ProviderError`。
- [ ] 實作：`pick_vocab` 之後呼叫 `make_intro({"title":..,"channel":..,"duration":..}, cues, provider, stats)`；`stats` 初始值加 `"intro_failed": 0`；結果非 `None` 才寫入 `lesson["intro"]`。CLI 總結行加印 `intro=ok|failed`。
- [ ] 跑全部 pytest。Commit: `feat(pipeline): build writes intro card`

### Task 3: 播放器顯示
**Files:** Modify `web/index.html`, `web/app.js`, `web/style.css`。
- [ ] `index.html`：`#stage .frame` 內（`shade` 之後、`panel` 之前）加
  `<div id="intro" class="layer intro" hidden><div class="intro-eyebrow">前情提要</div><div class="intro-title" id="intro-title"></div><div class="intro-rule"></div><div class="intro-lines" id="intro-lines"></div></div>`
- [ ] `app.js`：lesson 載入時 `renderIntro(lesson.intro)` 包在 try/catch（壞資料 → 保持 `hidden`，不影響整堂課）：無 → 保持 `hidden`；有 → 填 title（`\n` → 兩個 `<div>`）與 lines（每行一個 `<div>`），移除 `hidden`。第一次 `PLAYING`（既有 `S.started` 分支）→ `#intro` 加 class `show`，`setTimeout(INTRO_SECONDS * 1000)` 後移除 `show`（底層 opacity 本來就是 0，不需要 `gone`）。`INTRO_SECONDS = 10`。進入 review 時移除 `show`；review 的 CSS 已隱藏所有 `.layer`，`S.started` 保證重播不再出現。
- [ ] `style.css`：`.intro { left: 4%; top: 5%; width: 34%; opacity: 0; transition: opacity .6s ease; }`（寬度調整在 `.intro` 外層，不在標題）、`.intro.show { opacity: 1 }`；眉標綠色（`#a7d58f`）、`letter-spacing: .5em`、`clamp(8px, 1.1cqw, 20px)`；主標 `font: 700 clamp(12px, 2.3cqw, 40px)/1.3 var(--serif)` 白色；細線 `width: 3cqw; height: 1px; background: rgba(255,255,255,.5)`；補充行 `clamp(10px, 1.45cqw, 26px)` 淺灰 `#e3e6eb`；全部帶 `text-shadow` 同字幕；`prefers-reduced-motion` 時無 transition。
- [ ] 驗證：headless 截圖（scratch harness 強制 `started` + `show`）看位置與字級；Commit: `feat(web): intro card fades in on first play, out after 10 s`

### Task 4: 回填既有課程
- [ ] 對 `data/lessons/*.json` 逐一 `python3 -m pipeline.build <id>`（整堂課重建；分段與單字通常命中 cache，但 cache 未命中或模型不同時內容會變，接受），確認每個 lesson 有 `intro` 且內容沒有捏造事實；在播放器實看一支。
- [ ] Commit 更新後的 lesson JSON（僅已在 git 追蹤的那幾支）。

## Review Focus
1. 影片字幕一開始就是正文、沒有任何背景資訊（例如純教學影片）→ LLM 仍須產出「主題＋講者/頻道」卡，不得空白；測試用 FakeProvider 無法覆蓋，Task 4 回填時人工檢查。
2. 中文字元寬度：主標 16 字在 2.3cqw 下寬約 34cqw（含半形數字與空白會更窄） → `.intro` 寬 34%；Task 3 截圖確認不壓到人物中央。
3. 使用者在第一次播放前就拖進度條到中段 → 卡片仍在第一次播放時出現 10 秒（可接受，記錄即可）。
4. `intro` 文字含 `\n` 以外的控制字元 → `validate_intro` 拒絕（`\r`、`\t`）。
5. 卡片與面板同時淡入 → 面板最早在第一個單字前 1 秒出現，兩者不衝突；但卡片在 `.no-vocab` 下照常顯示。
