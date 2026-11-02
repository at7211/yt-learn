# yt-learn：HelloInterview 課程頁的雙語字幕疊層（第四個站點轉接層）

第 1 版（2026-11-02）：依操作者裁定起草，照 Udemy 轉接層（`2026-10-31-udemy.md`）的路子走。
第 2 版（2026-11-02）：併入 Spike 結果（全螢幕於 2026-11-02 由使用者親按驗證）與 Codex gpt-6-astra 第一輪 7 條（0 blocker、6 should-fix、1 nit，「修改後核准」）。

## 背景與已驗證事實（2026-11-02，在使用者登入的 Chrome 上實測）

- 目標頁：`https://www.hellointerview.com/learn/<path>`，例如 `/learn/system-design/patterns/dealing-with-contention`。Next.js SPA（有 `next-route-announcer`），沒有 iframe，沒有 mux／vimeo／wistia／videojs／hls 這類第三方播放器 SDK。
- **播放器是 Vidstack**。頁面上一支原生 `<video>`，`controls=false`，桌面寬度 757×426，`readyState 4`，duration 1818 s。往上的 DOM：`VIDEO` → `DIV[data-media-provider]`（= `video.parentElement`，computed `position: relative`，與影片同 rect）→ `DIV.align-top[data-media-player][data-orientation][data-load][data-can-seek]`（computed `position: relative`，同 rect）→ `DIV.relative.w-full` → `DIV.overflow-hidden.rounded-xl…` → `DIV.relative` → `DIV.mb-4`。
- `[data-media-player]` 內、provider div 的兄弟節點是 `DIV.vds-video-layout.light`，裡面有 `.vds-controls`（z-index 10；含 `.vds-controls-group`、`span.vds-chapter-title`、slider `.vds-slider-chapter`）與 `.vds-captions`（z-index 10）。
- **網站自己在 DOM 畫字幕（`.vds-captions`）**：網站的 Captions 鈕（`button.vds-caption-button[aria-pressed="true"]`）開著時，`video.textTracks[0].mode` 仍是 `disabled`；把原生軌設成 `showing` 不會多出任何 DOM 節點。
- 疊層位置：在 `video.parentElement` append 一個 `position:absolute; bottom:12%; z-index:30; pointer-events:none` 的測試 div，截圖中可見，位於網站控制列與網站字幕框（緊貼進度條上方）之上。append 到 `[data-media-player]` 幾何相同（控制列 z-index 10 < 30）。
- 影片與字幕的 src 都是簽名的 Cloudflare R2 網址（`…r2.cloudflarestorage.com/hellointerview-files/premium-content/<slug>/720p.mp4?X-Amz-…`），**會過期**；lesson／raw 裡絕不存它們，log 也不印。付費內容，只有登入的使用者看得到。
- 字幕：`<video>` 底下恰好一個 `<track kind="captions" label="English">`，`srclang` 空字串，`src` 是簽名 R2 網址；從頁面 isolated world `fetch(track.src)` 回 200，內容 `WEBVTT`、637 條 cue，時間行像 `00:00.120 --> 00:00:01.201`（左 `mm:ss.mmm`、右 `hh:mm:ss.mmm`）。
- `video.currentTime = 60` → 讀回 60、維持暫停、沒有錯誤（沒有 Netflix 那種限制）。
- 快捷鍵：對 body、video、provider div 送 keydown Z／E／V／R／[ ／] 都沒有任何變化（時間、暫停、靜音、速率、音量、全螢幕、PiP）——網站沒有綁這些鍵。網站控制鈕（aria-label）：Play、Mute、Captions、Chapters、Settings、AirPlay、Google Cast、PiP、Fullscreen、Ask Tutor、讚／倒讚。`document.fullscreenEnabled` 為 true。
- SPA：點頁面內連結到 `/learn/system-design/patterns/realtime-updates`，pathname 改變；3.5 s 後舊 `<video>` 與其父層**已從 document 移除**，新的 `<video>` 帶 captions track 已存在，我們的測試 div 也不見了。`history.back()` 觸發一次 `popstate`、路徑還原，影片又是**新元素**（不是原本那支）。結論：網站每次換頁都重建整個播放器，`{root, video}` 身分隨課程改變。
- `document.title` 格式：`Dealing with Contention Pattern for System Design Interviews | Hello Interview System Design in a Hurry`、`System Design Course | Hello Interview` → 後綴 regex `/\s*\|\s*Hello\s*Interview.*$/i` 足夠，定案。
- 文章／索引頁 `/learn/courses/system-design`：0 個 `<video>`、0 個 `[data-media-player]`。該頁全部 76 個 learn 連結與課程頁上所有 learn 連結都符合 `^/learn/(?:[a-z0-9-]+/){0,5}[a-z0-9-]+/?$`；觀察到最多 4 段。
- **程式碼核對（不需 Spike）**：`extension/vtt.js:5` 的 `TS = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/` 對 cue 的起訖**各自**解析，`mm:ss.mmm`、`hh:mm:ss.mmm` 與同一行混用都吃（`tests/web/vtt.test.js:31`、`:37` 已分別測兩種）。**vtt.js 不用改**，只補一條「同一行混用」的測試。
- **全螢幕（已驗證，使用者親按網站全螢幕鈕）**：`document.fullscreenElement` 是 `[data-media-player]`（不是 `<video>`），它 `contains(video.parentElement)`，掛在它底下的測試 div 在全螢幕中仍可見；退出後再進一次結果相同。root 定案為 `[data-media-player]`。

## 耦合地圖（file:line，以 HEAD d7bf6a1 為準）

**id 規則（四份路由複本＋一份共用 fixture）**
- `pipeline/ids.py:14-22`（`YOUTUBE_ID_RE`／`UDEMY_ID_RE`／`NETFLIX_ID_RE`／`LESSON_ID_RE`／兩個 URL regex）、`:76-89 parse_lesson_id`、`:92-100 source_of`。下游 `pipeline/build.py:16,167`、`pipeline/schema.py:4,93,150`、`pipeline/jobs.py:24-28 canonical_url`（非 youtube 回 None）都從這裡 import，**自動跟上**。
- `web/ytid.js:28-73`（ESM：`LESSON_ID_RE`、`parseLessonId`、`lessonSource`、`parseUdemyUrl`、`netflixWatchUrl`）。
- `extension/ytid.js:24-56`（全域：`ytLearnParseLessonId`、`ytLearnLessonSource`、`ytLearnParseUdemyUrl`…；background.js:1 `importScripts`）。
- `extension/overlay-state.js:4-8`（URL regex 複本）、`:17-30 lessonIdFromUrl`。**這份沒有 `LESSON_ID_RE`**，hello 分支的 120 字元上限要自己檢查（設計決定 1）。
- 第五份（非路由，但同一條規則）：擷取腳本自己的網址解析（Udemy 是 `extension/udemy-capture.js:22-28 lectureIdNow/checkNav`）。
- 共用表 `tests/fixtures/lesson_ids.json`（鍵：`parse`／`udemyUrl`／`netflixUrl`／`source`），讀者：`tests/test_ids.py`、`tests/web/ytid.test.js:35`、`tests/web/extension-ytid.test.js:40`、`tests/web/overlay-state.test.js:231` 起。

**伺服器／管線**
- `pipeline/schema.py:2`（import）、`:22-43 _source_errors`：`source` 必須等於 `source_of(id)`；`sourceUrl` 依站點分支（udemy 解析比對 id、netflix 與 canonical 完全相等、其他 → `sourceUrl is only allowed for …`）。**這裡是硬寫分支，要加 hellointerview。**
- `server.py:219-224 _add`：`parse_lesson_id` 後錯誤訊息「無法辨識的 YouTube、Udemy 或 Netflix 網址」（硬寫字串）。`server.py:146-158 _lessons` 已原樣帶 `source/sourceUrl`（通用）。`server.py:134-137 _serve_data` 用 `resolve()+is_relative_to`、檔名帶點的 id 已在 udemy／netflix 用過（通用）。Origin 白名單 `server.py:44-80` 不用動（worker 帶 `chrome-extension://`）。
- 以 id 當檔名的地方：`pipeline/build.py:170,181`、`pipeline/jobs.py:228`（`<id>.progress.json`，最長後綴 14 字元）、`:255,275`、`server.py:213,272`。
- 擷取失敗的訊息路徑：worker 把 throw 的 message 序列化送 `/fail`，伺服器保留 500 字元——所以擷取 throw 的訊息裡不能有簽名網址（設計決定 3、Codex 1）。

**擴充：worker**
- `extension/background.js:193-201 siteOfUrl`（三個分支，硬寫）。
- `:136-148 ytlearn:build`：靠 `siteOfUrl(msg.url)` 與 `ytLearnParseLessonId`，**通用**。`:122` lesson／job 的 id 驗證用 `ytLearnParseLessonId`，**自動跟上**。
- `:236-245 onIconClicked`：「只能在頁面上」的判斷硬寫 `udemy`（`const udemy = ytLearnLessonSource(videoId) === 'udemy'`）。
- `:382 runJobInner`：`requested.site === 'udemy' && mode !== 'inplace'` → 「Udemy 講座只能在講座頁上擷取」（硬寫）。
- `:464-476 captureInPlace`：udemy／netflix 分支後**預設落到 YouTube 的 `capture.js`（MAIN）**——不加分支的話 hello id 會跑錯腳本。
- `:514-544 injectCapture(tabId, args, {files, world, fn})`：通用。
- `:503 waitForWatchPage` 只給 YouTube background 模式，無關。

**擴充：疊層**
- `extension/site.js:1-8`（轉接器契約註解）、`:39-63 udemy`（`lessonId`／`findPlayer`／`isAd`／`nativeCaptionCss`／`navEvents:[]`）、`:136-147 netflix`（`navEvents:[{target:'window',name:'popstate'}]`）、`:149-154 siteFor`（硬寫三個 hostname）。
- `extension/overlay.js` 引擎已站點無關：`:107,111` 走 `site.lessonId/findPlayer`；`:269` 套 `site.nativeCaptionCss`；`:273-286 holdPosition`（static root 暫設 relative，teardown 還原）；`:620-628` 沒有 `site.seek` 時引擎自己設 `video.currentTime`；`:674-689` 每秒輪詢比對 href／id／`{root, video}` 身分 + 註冊 `site.navEvents`；`:86-99` 沒有播放器時回 `{handled:false}` 讓 worker 走後備。**引擎沒有 history patching**（只有事件＋輪詢），而且 isolated world 的 `history` 包裝跟頁面不是同一個物件，patch 了也看不到頁面的 `pushState`。只需改 `:1-2`、`:92`、`:676-678` 的註解。
- `tests/web/overlay-engine.test.js`：換頁測試只有 Netflix（`:334-346`），跨站排除測試只列 YouTube／Udemy（`:243-245`）——要補 HelloInterview（步驟 4）。
- `extension/overlay.js:9` Trusted Types 註解；檢查測試 `tests/web/extension-overlay-messages.test.js:1159-1164`（檔名清單，要加新檔）。
- `extension/manifest.json:4`（version 1.6.0）、`:12-16 host_permissions`、`:33-42` overlay content script matches、`:55-59` WAR matches。對應測試 `tests/web/extension-overlay-messages.test.js:322-328`（`version === '1.6.0'`）、`:330-342`（`deepEqual(overlay.matches, [youtube, udemy])`）——**兩條都會紅，要改。**

**本機頁**
- `web/lesson-source.js:6-9`（各站文案常數）、`:11-27`（`udemyLessonLink` 驗 sourceUrl；`netflixLessonLink` 只從 id 推導）、`:29-38 SITES`（通用接縫：`externalSite`／`listRowSite`／`listRowSourceLink`／`canBuildHere` 都讀它）。
- `web/app.js:52`（「無法辨識的 YouTube、Udemy 或 Netflix 網址」硬寫）、`:54`、`:552` 註解；`:448-455` 列表連結、`:548-575 setupExternalLesson` 都走 `site.*`，**通用**。

**測試入口與文件**
- `tests/web/index.js:1-23`：`node --test tests/web/` 只跑這裡 import 的檔（Node 22），**新測試檔要登記**。
- `README.md:3`、`:28`、`:31-39`（支援站點表與「三站」一句）、`:54`、`:88`（快捷鍵）、`:109-119`（已知限制、條款）；`extension/README.md:2`、`:14`。

## 設計決定

1. **id 格式**：`hello.<path>`，`<path>` 是 `/learn/` 之後的路徑、`/` 換成 `.`。段字元 `[a-z0-9-]`、1–6 段、**`<path>` 部分（含點）最多 120 字元**（id 最多 126）。理由：目前路徑約 50 字元（實測最多 4 段），120 留兩倍以上餘裕；最長檔名 `<id>.progress.json` ≤ 140 bytes，遠低於 APFS／ext4 的 255；`index.html?v=<id>` 與列表顯示也不會爆。點不在 YouTube 字元集內，不會和 11 碼 id 碰撞；前綴 `hello.` 與 `udemy.`／`netflix.` 不重疊；空段被 `+` 排除，所以不會出現 `..` 或 `/`，檔名安全。
   - Python `LESSON_ID_RE` 新增分支 `hello\.(?=[a-z0-9.-]{1,120}$)[a-z0-9-]+(?:\.[a-z0-9-]+){0,5}`（Python 與 JS 都支援 lookahead；`fullmatch` 下尾端 `\n` 仍被拒，`test_lesson_id_re_is_anchored` 要加 hello 的案例）。新增 `HELLO_ID_RE = re.compile(r"hello\.((?=[a-z0-9.-]{1,120}$)[a-z0-9-]+(?:\.[a-z0-9-]+){0,5})")`。
   - URL：`HELLO_URL_RE = https://www\.hellointerview\.com/learn/((?:[a-z0-9-]+/){0,5}[a-z0-9-]+)/?(?:[?#]\S*)?`（fullmatch；https、host 恰為 `www.hellointerview.com`、無 port／userinfo；可帶結尾斜線、query、hash），解析後再確認 `'hello.' + path.replace('/', '.')` 符合 `LESSON_ID_RE`（有 `LESSON_ID_RE` 的三份，長度上限只寫在那條 regex）。**原始字串解析器對明寫的 `:443` 也拒絕**（選擇：規則只認瀏覽器正規化後的形式，不替使用者正規化；瀏覽器的 `location.href` 本來就不會帶 `:443`）。結尾點 host、IDN／形近字 host、百分比編碼 host、路徑裡的 `%2F` 與 `%2E%2E` 都因為 regex 字元集而被拒。
   - 新函式（三端同名對應）：Python `parse_hello_url(url) -> path|None`、`hello_learn_url(lesson_id) -> 'https://www.hellointerview.com/learn/' + path`；`source_of` 回 `'hellointerview'`；`parse_lesson_id` 在 netflix 之後、YouTube 之前試 hello。JS `web/ytid.js`：`parseHelloUrl`、`helloLearnUrl`；`extension/ytid.js`：`ytLearnParseHelloUrl`、`ytLearnHelloLearnUrl`；`lessonSource`／`ytLearnLessonSource` 加 `'hellointerview'`。`overlay-state.js:lessonIdFromUrl` 加 `HELLO_URL_RE` 分支（在 YouTube `new URL` 之前）；**這份沒有 `LESSON_ID_RE`，所以明寫 `path.length <= 120` 檢查**，超過回 null（Codex 3）。
2. **sourceUrl**：一律是從 id 推導的 canonical `hello_learn_url(id)`（不帶 query／hash／結尾斜線）。`_source_errors` 的 hellointerview 分支要求 `sourceUrl == hello_learn_url(vid)`（同 Netflix 的完全相等）；「only allowed for」訊息改成列出三種。本機頁連結**只從 id 推導**（同 `netflixLessonLink`），不信任 lesson 裡的字串。
3. **擷取**：新檔 `extension/hellointerview-capture.js`（isolated world，worker 先注入 `vtt.js` 再注入它，同 Udemy）：`globalThis.ytLearnHelloCapture({expectLessonId, timeoutMs}) -> Promise<raw>`，錯誤一律 throw 繁中訊息；結構照 `udemy-capture.js`（deadline、`later`/`sleep`、`withAbort`、`finally` 清計時器）。
   - 頁面檢查（Codex 2）：用與共用規則相同語意的錨定 regex（`HELLO_URL_RE`：https、host 恰為 `www.hellointerview.com`、無 userinfo／port、可帶結尾斜線／query／hash）驗 **`location.href`**，path 從這個 match 取得，並確認 path ≤ 120；不符 →「這不是 HelloInterview 課程頁」。不再分開看 `location.hostname`／`location.pathname`。`lessonIdNow = 'hello.' + path.replace(/\//g, '.')`；起點與回傳前各 `checkNav()`，不符 →「換頁了，請回到原課程頁再試」。這是規則的第五份複本，用它自己的 href 表與共用 fixture 的長度邊界案例鎖住（見步驟 3）。
   - 找影片：`[...document.querySelectorAll('video')].find((v) => v.querySelector('track[kind="captions"]'))`；每 200 ms 重找，最多 `FIND_MS = 5000`（實測 SPA 換頁後新播放器在 3.5 s 內就位）。頁面上完全沒有 `<video>` →「這一頁沒有影片」；有影片但沒有 captions track →「找不到字幕」。
   - 挑字幕（Codex 4）：該 video 下 `track[kind="captions"]` 中 `track.src` 以 `https:` 開頭、且（`srclang` 符合 `/^en([_-]|$)/i`，或 `srclang` 為空且 `label` 符合 `/english/i`）者，取第一條。`srclang` 有值時以它為準（`srclang=fr` 即使 label 是 English 也不收）。沒有 captions track 或都沒有 https src →「找不到字幕」；有 https 軌但沒有符合英文條件的 →「這一頁沒有英文字幕」（與 Udemy 同字樣）。**不再有「第一條」後備**（實測頁 srclang 空、label English，仍會被選中）。
   - fetch：`fetch(track.src, {credentials: 'omit', signal})`（跨源本來就不帶 cookie；R2 的 CORS 在實測已放行；`credentials:'omit'` 保留）；401／403 →「字幕連結已過期，請重新整理頁面再試」；其他非 2xx →「字幕檔下載失敗（HTTP n）」；開頭不是 `WEBVTT`（允許 BOM）→「字幕檔格式不對」；`ytLearnParseVtt` 不存在 →「vtt.js 未載入」；0 條 →「字幕內容為空」。
   - **例外遮罩**（Codex 1）：fetch、讀 body、解析包在同一個 try 裡；abort → 與 Udemy 相同的逾時訊息（`逾時：n 秒內沒有取得字幕`）；我們自己 throw 的已知訊息原樣往外；**其他任何非預期例外一律換成固定訊息「字幕讀取失敗」**，不帶原始 message／stack（瀏覽器的 fetch 錯誤可能夾帶網址，而 worker 會把 message 送 `/fail`、伺服器存 500 字元）。
   - duration：`video.duration` 有限正數才用；否則等 `loadedmetadata` 最多 5 s；仍沒有 →「讀不到影片長度」。超過長度的 cue 過半 →「字幕時間超出影片長度」，否則濾掉（同 Udemy `:117-119`）。
   - 回傳前的換頁檢查（Codex 6）：除了 `checkNav()`，選中的 `video` 必須仍 `document.contains(video)`，且 `location.href` 與起點讀到的完全相同；否則「換頁了，請回到原課程頁再試」（實測網站換頁會移除舊 video，所以這擋得住「新網址配舊影片」）。
   - raw：`{videoId: lessonIdNow, source: 'hellointerview', sourceUrl: 'https://www.hellointerview.com/learn/' + path, title, channel: 'HelloInterview', duration, lang: 'en', kind: 'unknown', capturedAt, events}`。`title` = `document.title` 去掉後綴，regex 定案為 `/\s*\|\s*Hello\s*Interview.*$/i`（實測兩種格式都吃），空則取 path 最後一段的 kebab 轉空白。**raw 裡沒有任何 R2 網址**（`track.src`／`video.src` 都不進 raw、不進 throw 的訊息）。
   - 安全（Codex 5 部分採納後的措辭）：只讀 `<video>`／`<track>` 的屬性與一次字幕 fetch；不讀 cookie、不讀 storage、不發其他請求。字幕與標題是**不受信任的輸入**，會進入四個站共用的既有 LLM 管線；擴充本身從不執行或依循頁面內容。不把 `track.src` 放進 raw 只能防止我們手上的網址被複製出去，**不能**防止字幕文字本身夾帶任意內容。管線 prompt 強化列在「v1 不做」。
4. **疊層轉接器** `site.js` 新增 `hellointerview`：
   - `lessonId(url)`：`lessonIdFromUrl(url)` 且以 `hello.` 開頭，否則 null。
   - `findPlayer(doc)`：第一個帶 `track[kind="captions"]` 子節點的 `<video>`（與擷取同規則），**`root = video.closest('[data-media-player]')`，沒有這個屬性時退回 `video.parentElement`**（不印 log，直接用）；沒有 video 就 null。**理由（Spike 定案）**：網站字幕框 `.vds-captions` 在 provider div 的兄弟 `.vds-video-layout` 裡，`ytlearn-on` 範圍的 CSS 只有 root 是播放器元素才碰得到它；`[data-media-player]` 也是 Vidstack 的全螢幕宿主（第 1 步 b 待使用者確認）；它與影片同 rect、computed `position: relative`，實測疊層 z-index 30 在控制列（10）之上可見；用 data 屬性而不是 Tailwind class。網站每次換頁重建播放器，引擎既有的 `{root, video}` 身分比對會讓疊層重掛。
   - `isAd: () => false`；`seek` 不提供（引擎設 `currentTime`，實測可用）。
   - `nativeCaptionCss`：`.ytlearn-on .vds-captions{visibility:hidden !important}` 加 `.ytlearn-on video::cue{color:transparent !important;background:transparent !important;text-shadow:none !important}`（root 已不是 video 的直接父層，所以拿掉 `>`；`::cue` 只用這三個屬性）。只在疊層開著時隱藏網站字幕，關掉即恢復。
   - `navEvents: [{target: 'window', name: 'popstate'}]`（實測上一頁觸發一次 popstate）；`pushState` 換頁靠引擎既有的 1 s 輪詢（Udemy 完全只靠輪詢、Netflix 是 popstate＋輪詢；不做 history patching，理由見耦合地圖）。
   - `siteFor('www.hellointerview.com')` 回它。快捷鍵沿用引擎的 `onKey`（Z／E／V／R／[ ]），不改；實測網站沒有綁這些鍵，不會衝突。
5. **worker**：`siteOfUrl` 第四個分支 `ytLearnParseHelloUrl(url) → 'hellointerview'`；`onIconClicked` 的「只能在頁面上」改成 `const pageOnly = ['udemy', 'hellointerview']`，source 在其中且 `site !== source` 或沒有 tab id → 開首頁；`runJobInner` 在 `:382` 旁加 `(requested.site === 'hellointerview' || ytLearnLessonSource(requested.id) === 'hellointerview') && mode !== 'inplace'` →「HelloInterview 課程只能在課程頁上擷取」；`captureInPlace` 在 udemy 之後加分支 `{files: ['vtt.js', 'hellointerview-capture.js'], world: 'ISOLATED', fn: 'ytLearnHelloCapture'}`、參數 `{expectLessonId: requested.id, timeoutMs: CAPTURE_TIMEOUT_MS}`。`ytlearn:build` 與 lesson／job 訊息不用改（通用）。
6. **manifest**（1.7.0）：`host_permissions`、overlay 的 `content_scripts.matches`、WAR `matches` 加 `https://www.hellointerview.com/*`；WAR resources 不用加（`vtt.js`／擷取腳本由 `scripting.executeScript` 注入，不需 web-accessible）。解壓縮載入的擴充重新載入即取得新 host permission，不用 optional 流程（不是 Netflix 那種需要 hook 的情況）。
7. **伺服器**：`/add` 錯誤訊息改「無法辨識的 YouTube、Udemy、Netflix 或 HelloInterview 網址」；`/lessons` 不用改。建課沿用現有管線（沒有官方中文參考軌）。
8. **本機頁**：`lesson-source.js` 加 `HELLO_BUILD_MSG = 'HelloInterview 課程請在課程頁按擴充圖示產生'`、`HELLO_PLAY_HINT = '在 HelloInterview 頁面上播放'`、`helloLessonLink(lesson, id)`（只從 id：`lessonSource(id) === 'hellointerview'` → `helloLearnUrl(id)`）、`SITES.hellointerview = {name: 'HelloInterview', buildMsg, playHint, note: '這堂課只能在 HelloInterview 頁面上疊字幕', linkText: '回到課程頁', link: helloLessonLink}`。`app.js:52` 改成同上的四站訊息；`:54`、`:552` 註解補 HelloInterview。沒有播放器、單字格不 seek、列表標「HelloInterview」並連到課程頁——都由既有 `externalSite` 接縫自動得到。
9. **v1 不做**：hellointerview.com 以外的子網域、非 `/learn/` 的頁面（例如模擬面試頁）、沒有英文字幕的頁、逐字對時、截圖（付費內容）；`pipeline/intro.py`／`segment.py`／`vocab.py` 的 prompt 強化（對抗字幕裡夾帶的指令）——**這是整條管線、四站共用的項目，不是 HelloInterview 專屬**，另開計畫處理，本計畫不加對抗性管線測試。

## 檔案

新增：`extension/hellointerview-capture.js`、`tests/web/hellointerview-capture.test.js`、`tests/fixtures/hello_small.vtt`（手寫 6–8 條 cue，**全是自己寫的句子**：BOM、`mm:ss.mmm` 與 `hh:mm:ss.mmm` 混用的時間行、NOTE 區塊、一條空 cue、一條逆序 cue）。
修改：`pipeline/ids.py`、`pipeline/schema.py`、`server.py`、`web/ytid.js`、`web/lesson-source.js`、`web/app.js`、`extension/ytid.js`、`extension/overlay-state.js`、`extension/site.js`、`extension/overlay.js`（只改註解）、`extension/background.js`、`extension/manifest.json`、`tests/fixtures/lesson_ids.json`、`tests/test_ids.py`、`tests/test_schema.py`、`tests/test_server_jobs.py`、`tests/web/ytid.test.js`、`tests/web/extension-ytid.test.js`、`tests/web/overlay-state.test.js`、`tests/web/vtt.test.js`、`tests/web/site.test.js`、`tests/web/overlay-engine.test.js`、`tests/web/extension-overlay-messages.test.js`、`tests/web/lesson-source.test.js`、`tests/web/index.js`、`README.md`、`extension/README.md`。

## 步驟（每步一個 commit，`git -c commit.gpgsign=false commit`，不加 Co-Authored-By；分支 `feat/hellointerview`）

每步完成條件：`node --test tests/web/` 與 `~/.local/bin/uv run --with pytest pytest -q` 全綠，並由另一個新 context 的審查者看過 diff。實作者一次只做一步。

0. **Codex 審本計畫**（gpt-6-astra）：**已完成**，7 條裁決見文末「Codex 審查裁決」，已併入本版。
1. **Spike**（Claude-in-Chrome，使用者已登入的分頁；只讀與暫時性 DOM 操作，不存任何字幕內容）：
   a. **已驗證**：測試 div（`createElement`／`textContent`，`position:absolute;bottom:12%;z-index:30;pointer-events:none`）掛在 `video.parentElement` 或 `[data-media-player]` 都可見，位於網站控制列（z-index 10）與網站字幕框之上。
   b. **已驗證**：使用者按網站全螢幕鈕後，`document.fullscreenElement` = `[data-media-player]`，含 video 與疊層 root，測試 div 仍可見（進出兩次皆同）。
   c. **已驗證**：SPA 換頁後舊 video 與父層被移除、新 video 帶 track；`history.back()` 觸發一次 `popstate`，video 又是新元素。
   d. **已驗證**：網站在 DOM 畫字幕（`.vds-captions`），原生軌維持 `disabled`；設 `showing` 不多 DOM 節點。
   e. **已驗證**：`video.currentTime = 60` 讀回 60、維持暫停、無錯誤（網站控制列是否同步留給第 6 步目視）。
   f. **已驗證**：`document.title` 兩種格式（見背景），後綴 regex 定案；Z／E／V／R／[ ] 網站無反應。
   g. **已驗證**：文章頁 `/learn/courses/system-design` 0 個 `<video>`、0 個 `[data-media-player]`；所有 learn 連結符合路徑規則，最多 4 段。
   結果已寫回本計畫。commit：`hellointerview plan v2: spike results + Codex round 1`。b 的結果出來後若需改 root，另一個 plan commit。
2. **id 統一 + 伺服器端到端**：
   - `pipeline/ids.py`、`pipeline/schema.py`、`server.py:224`、`web/ytid.js`、`extension/ytid.js`、`extension/overlay-state.js`（設計決定 1、2、7；overlay-state 明寫 `path.length <= 120`）。
   - fixture `lesson_ids.json`：`_comment` 補 `helloUrl`／`helloUrlLength`；`parse` 加（有效）`hello.system-design.patterns.dealing-with-contention`、兩側空白、`https://www.hellointerview.com/learn/system-design/patterns/dealing-with-contention`（含 `/`、`?x=1`、`#y`、`/?a=b#c` 變體 → 同一 id）、單段 `/learn/system-design` → `hello.system-design`、6 段；（拒絕 → null）`Hello.x`、`hello.`、`hello.a..b`、`hello.a_b`、`hello.A`、7 段 id、path 121 字元的 id、`http://`、`hellointerview.com`（無 www）、`www.hellointerview.com.evil.com`、結尾點 host `www.hellointerview.com.`、形近字 host（`www.hellointerview.com` 中一個 `a` 換成西里爾 `а`）、百分比編碼 host（例如 `www.hellointerv%69ew.com`）、明寫 `:443`（原始解析器拒絕，見設計決定 1）、其他 port `:444`、`user@`、`/learn/`、`/learn`、`/learn/a//b`、`/learn/System-Design/x`、`/learn/a%2Fb`、`/learn/a/../b`、`/learn/a/%2E%2E/b`、7 段 URL、`/practice/x`、`https://evil.com/www.hellointerview.com/learn/x`。新鍵 `helloUrl`（原始字串 → path 字串或 null，**只給四份解析器**）：同上各 URL 案例，加前導空白 → null、`?x=1 2` → null、hello id → null、Udemy URL → null。新鍵 `helloUrlLength`（Codex 3，**五份都跑**）：path 恰 120 字元的 URL → 接受，121 字元 → 拒絕，各帶結尾斜線、`?q=1`、`#h` 變體（結尾斜線不算進 path 長度）。`source` 加 `hello.a.b → "hellointerview"`、`hello.A → null`、hello URL → null。
   - 測試：`tests/test_ids.py` 新增 `test_parse_hello_url_table`、`test_hello_url_length_boundary`、`test_hello_learn_url`（id → canonical URL；`parse_hello_url(hello_learn_url(id))` 往返）、`test_non_strings` 補兩個新函式、`test_lesson_id_re_is_anchored` 補 `hello.a\n`；`tests/test_schema.py` 新增 `test_raw_accepts_hello_id_with_and_without_source_fields`、`test_raw_rejects_bad_hello_ids`、`test_hello_source_url_must_be_canonical`（帶 query、結尾斜線、別的 path、http 都拒）、`test_source_must_match_id` 補 hello；`tests/test_server_jobs.py` 新增 `test_hello_url_end_to_end`（照 `test_udemy_url_end_to_end:101-121`：`/add` 帶 `?x=1#y` 的課程頁網址 → claim → `/ingest`（`source='hellointerview'`、`sourceUrl` canonical、`kind='unknown'`、兩條自寫句子）→ done → raw／lesson／`/lessons` 列帶 source 與 sourceUrl → 再 `/add` 裸 id 回 done）、`test_add_rejects_non_learn_hello_urls`、`test_ingest_rejects_non_canonical_hello_source_url`；`tests/web/ytid.test.js` 新增 `parseHelloUrl and helloLearnUrl agree with lesson_ids.json (helloUrl and helloUrlLength)`；`tests/web/extension-ytid.test.js` 新增 `ytLearnParseHelloUrl and ytLearnLessonSource agree with lesson_ids.json (helloUrl and helloUrlLength)`；`tests/web/overlay-state.test.js` 新增 `lessonIdFromUrl agrees with the shared fixture for HelloInterview learn URLs`（含 `helloUrlLength` 的 120／121）。
   - commit：`hellointerview step 2: hello.<path> lesson ids end to end (ids, schema, /add, ytid copies, overlay-state)`
3. **擷取腳本**：
   - `extension/hellointerview-capture.js`（設計決定 3）；`tests/fixtures/hello_small.vtt`；`tests/web/vtt.test.js` 新增 `mixed mm:ss.mmm and hh:mm:ss.mmm on one timing line`；`tests/web/index.js` 加 `import './hellointerview-capture.test.js';`；`extension-overlay-messages.test.js:1160` 的檔名清單加 `hellointerview-capture.js`、`udemy-capture.js`、`vtt.js`、`site.js`（不加 `overlay.js`：它 `:9` 的註解本身含 `innerHTML` 字樣，會誤觸）。
   - `tests/web/hellointerview-capture.test.js`（vm，照 `udemy-capture.test.js:1-60` 的假頁：`location`、`document.querySelectorAll('video')`、`document.contains`、假 video 有 `querySelector('track[kind="captions"]')`／`querySelectorAll`、`duration`、`addEventListener`；假 `fetch`），案例：`happy path: raw shape, canonical sourceUrl, no R2 URL anywhere in the raw`（`JSON.stringify(raw)` 不含 `r2.cloudflarestorage.com`、`X-Amz`）、`fetch uses track.src with credentials omit, exactly one request`、`video without a captions track is skipped; the first one with a track wins`、`track selection: srclang en / en-US accepted; empty srclang + label English accepted`、`French-only (srclang=fr) -> 這一頁沒有英文字幕`、`srclang=fr + label English -> 這一頁沒有英文字幕 (srclang wins)`、`no label and no srclang -> 這一頁沒有英文字幕`、`no video -> 這一頁沒有影片 after FIND_MS`、`video appears after 1 s (SPA) -> captured`、`video without captions track -> 找不到字幕`、`non-https track src -> 找不到字幕`、`403 -> 字幕連結已過期，請重新整理頁面再試`、`500 -> 字幕檔下載失敗（HTTP 500）`、`not WEBVTT -> 字幕檔格式不對`、`empty VTT -> 字幕內容為空`、`unexpected fetch rejection containing a signed URL -> fixed message, URL absent from the thrown message`（假 fetch reject 一個 message 含 `https://x.r2.cloudflarestorage.com/…?X-Amz-Signature=…` 的 Error → throw「字幕讀取失敗」，message 不含 `r2.cloudflarestorage`／`X-Amz`）、`abort -> 逾時訊息`、`duration from loadedmetadata; none -> 讀不到影片長度`、`cues beyond duration: dropped, or refused when most are`、`path changes during fetch -> 換頁了，請回到原課程頁再試`、`video replaced during fetch -> 換頁了，請回到原課程頁再試`（fetch 期間 `document.contains(video)` 變 false、href 不變）、`expectLessonId mismatch at start`、`page check uses location.href`（自己的短 href 表，都是瀏覽器會給的正規化網址：https 課程頁 → 接受；http、userinfo、`:444`、別的 host、非 learn 路徑 → 這不是 HelloInterview 課程頁；結尾斜線、query、hash → 接受且 id 相同）、`path length boundary agrees with lesson_ids.json helloUrlLength`（逐筆設 `location.href` 跑一次擷取，比對 `videoId`／錯誤）、`title from document.title without the site suffix (both observed formats); falls back to the last path segment`、`no timers left behind`。共用 fixture 的 `helloUrl` 原始字串案例**不**拿來跑擷取（那是給解析器的，瀏覽器 href 不會長那樣）。
   - 這步無法在真擴充裡單獨跑（worker 還沒接線）；isolated world 的 fetch 已在事實中實測 200，真機確認放到第 6 步。
   - commit：`hellointerview step 3: hellointerview-capture.js (isolated world, track VTT, no signed URLs kept)`
4. **疊層轉接器 + worker + manifest**：
   - `extension/site.js`（設計決定 4，`export const hellointerview`、`helloLessonId`、`helloFindPlayer`）；`extension/background.js`（設計決定 5，`siteOfUrl` 註解 `:193-194` 一起改）；`extension/manifest.json`（設計決定 6）；`extension/overlay.js` 註解 `:1-2`、`:92`、`:676-678`。
   - 測試：`tests/web/site.test.js` import 加 `hellointerview`；`siteFor` 測試改名為 `siteFor: www.youtube.com, www.udemy.com, www.netflix.com and www.hellointerview.com only`（`hellointerview.com`、`app.hellointerview.com` → null）；新增 `hellointerview.lessonId: learn URLs -> hello.<path>, everything else null`、`hellointerview.findPlayer: first video with a captions track, root is closest [data-media-player], else its parent; null without one`（假 doc 要支援 `querySelectorAll('video')`、`closest`、`parentElement`）、`hellointerview: never an ad, hides .vds-captions and native ::cue under ytlearn-on, popstate plus the poll, engine seeks`。`tests/web/overlay-engine.test.js`（Codex 6）：新增 `engine on HelloInterview: pushState lesson change with a new {root, video} -> old overlay torn down, new id routed and remounted when a lesson exists`、`… collapses when the new lesson has none`，並把 `:243-245` 的跨站排除測試擴充到 HelloInterview。`tests/web/extension-overlay-messages.test.js`：`:322-328` 版本改 `1.7.0`；`:330-342` 的 `deepEqual` 改三站並新增 `manifest: hellointerview.com gets the host permission, the overlay content script and the overlay resources`；新增 `icon on a HelloInterview learn page: overlay not handled -> /add with the tab url -> claim -> hello capture (ISOLATED, vtt.js + hellointerview-capture.js) -> /ingest`、`icon on a HelloInterview learn page: overlay handled -> nothing else`、`icon on a non-learn HelloInterview page opens the home page`、`HelloInterview never runs in background mode`（錯誤字串「HelloInterview 課程只能在課程頁上擷取」）、`ytlearn:build from a HelloInterview overlay carries the page url; a url naming another page is refused`、`ytlearn:lesson / ytlearn:job accept hello ids`、`captureInPlace never falls back to capture.js for a hello id`。
   - commit：`hellointerview step 4: site adapter, worker routing (in-place only), manifest 1.7.0`
5. **本機頁與首頁**：`web/lesson-source.js`、`web/app.js`（設計決定 8）。測試 `tests/web/lesson-source.test.js`：`:18` 那條改名並加 hello（`externalSite('hello.a.b').name === 'HelloInterview'`）、新增 `helloLessonLink derives the learn URL from the id and ignores sourceUrl`、`listRowSourceLink needs source=hellointerview for hello rows`、`canBuildHere is false for hello ids`。commit：`hellointerview step 5: local page treats hello.* like Udemy (no player, link back, list label)`
6. **實測**（使用者的 Chrome，`chrome://extensions` 重新載入）：在範例課程頁按圖示 → pill（擷取字幕 → 產生課程 x% → 完成）→ 疊層；疊層開著時網站自己的字幕框隱藏、關掉後恢復；Z／E／V／R／[ ] 都有效、`[ ]` 跳句後網站控制列同步；點字開字典；**請使用者按網站的全螢幕鈕**確認疊層仍在（並補完第 1 步 b）；站內換到另一個 learn 頁 → 疊層拆掉（有課程就換上、沒有就收起）；上一頁回來 → 換回；關閉後換頁不重掛；文章型頁按圖示 → 開首頁或明確錯誤；**過期路徑**（Codex 7）：選一個還沒有課程的 learn 頁（或先刪掉它的 lesson 檔），放置一小時後不刷新就按圖示，並在 worker log／network 面板確認**確實發出了字幕 fetch**，再看是否出現「字幕連結已過期…」（沒有 fetch 就不算通過）；本機 `index.html?v=hello.…` 顯示提示、單字格、連結；YouTube（puh91fohvTA：疊層、廣告、換片）與 Udemy 一堂課回歸。發現的修正各自一個 commit：`hellointerview step 6: <修了什麼>`。不截圖。
7. **README**：`README.md:3` 一句加 HelloInterview；`:28` 字幕條件；`:31-39` 支援站點表加一列 `| HelloInterview | 已登入帳號的 learn 課程頁按圖示 | HelloInterview 播放器上的疊層 | 影片自帶的英文字幕軌（VTT） |`，「三站」改「四站」並把 HelloInterview 併入「本機頁面只有逐字稿與單字複習」那句；`:54` 括號補 HelloInterview 課程頁；`:88` 疊層快捷鍵那行加 HelloInterview（Spike f：網站沒有綁 Z／E／V／R／[ ]，不需另註衝突）；「已知限制」加一條：`HelloInterview：只支援 www.hellointerview.com/learn/ 底下有影片的課程頁；付費內容只在你自己登入的瀏覽器、本機使用；影片與字幕是會過期的簽名網址，擷取失敗時先重新整理頁面，課程裡不保存這些網址。`；`:119` 條款句把 HelloInterview 併入（「Udemy、Netflix 與 HelloInterview 的字幕…；測試與截圖不含任何這些站的字幕內容」）。「素材出處」不動。`extension/README.md:2` 改四站並加一句 HelloInterview 的流程（isolated world 注入 vtt.js＋hellointerview-capture.js、只讀 `<track>` 一次 fetch、換頁靠輪詢＋popstate、不存簽名網址），`:14` 檔案清單加 `hellointerview-capture.js`。README 與 fixture 裡**不出現任何 HelloInterview 字幕原文**。commit：`README: HelloInterview row, limits (premium, local only, signed URLs)`

## 驗收

- `node --test tests/web/` 與 `~/.local/bin/uv run --with pytest pytest -q` 全綠；新測試檔都在 `tests/web/index.js` 登記。
- `grep -rn "innerHTML\|outerHTML\|insertAdjacentHTML\|document\.write" extension/` 沒有程式碼命中。
- `grep -rn "r2.cloudflarestorage\|X-Amz" extension/ pipeline/ web/ tests/ README.md` 只出現在擷取測試的「不得出現」斷言與「非預期例外」測試的假錯誤訊息裡。
- 第 6 步清單全部打勾（全螢幕一項由使用者確認）；YouTube、Udemy 回歸無變化。
- 每一步的 diff 由新 context 的審查者看過（不自己驗自己）。

## 風險

- Vidstack 改版：root 依賴 `data-media-player` 屬性、隱藏依賴 `.vds-captions` class；屬性消失時退回 `video.parentElement`（疊層仍可見，但網站字幕可能不會被隱藏，兩層字幕重疊）。
- 簽名網址過期：若使用者停在頁面很久，`track.src` 可能已過期；錯誤訊息引導重新整理。我們不保存它，所以不影響已建好的課程。
- 規則有五份複本（Python、兩份 ytid.js、overlay-state.js、擷取腳本）；靠共用 fixture（`helloUrl` 給四份解析器、`helloUrlLength` 五份都跑）與擷取自己的 href 表防漂移。替代方案是讓擷取也注入 `ytid.js` 共用全域（少一份複本，但偏離 Udemy 的注入方式），v1 不採。
- `vtt.js` 的去標籤 regex `<\/?[^>]*>` 會吃掉字幕裡的字面 `<`…`>`（例如 `a < b and c > d`）；系統設計內容偶爾會有，v1 接受，觀察到再改成只去已知標籤。
- 路徑規則（小寫、`[a-z0-9-]`、≤6 段）是依目前網址推的（實測 76＋個連結全符合、最多 4 段）；網站若出現大寫或底線路徑，該頁會被視為不支援（`null`），不會誤判成別的 id。
- 條款：只讀頁面上已經給使用者的字幕軌、一次 fetch、使用者按圖示才觸發；付費內容只在本機、個人使用，README 寫明。
- 字幕與標題是不受信任的輸入，走四站共用的既有 LLM 管線；擴充不執行也不依循頁面內容；管線層的 prompt 強化不在本計畫範圍（見「v1 不做」）。

## Codex 審查裁決（gpt-6-astra 第一輪，「修改後核准」）

1. **擷取例外可能把簽名網址帶進 log 與 `/fail`** —— 採納：fetch／讀 body／解析包 try，非預期例外換成固定「字幕讀取失敗」、abort 用 Udemy 的逾時訊息，保留 `credentials:'omit'`；加測試（設計決定 3、步驟 3）。
2. **擷取的頁面檢查（hostname＋pathname）與共用 URL 規則不一致** —— 採納：改用錨定 regex 驗 `location.href`；fixture 原始字串案例只給解析器，擷取用自己的正規化 href 表；fixture 補結尾點、IDN、編碼 host、`%2F`、`%2E%2E`、userinfo、`:444`、明寫 `:443`（拒絕）（設計決定 1、3，步驟 2、3）。
3. **overlay-state 沒有 `LESSON_ID_RE`，URL 分支缺 120 上限** —— 採納：`lessonIdFromUrl` 明寫 path ≤ 120；fixture 新鍵 `helloUrlLength`（120 接受／121 拒絕，含斜線／query／hash 變體），五份都跑（設計決定 1、步驟 2、3）。
4. **「第一條」後備會把非英文軌標成 `lang:'en'`** —— 採納：只收 `srclang` 為 en 或（srclang 空且 label 含 English）的 https 軌，否則「這一頁沒有英文字幕」；加四條測試（設計決定 3、步驟 3）。
5. **「頁面內容從不當指令」沒有根據** —— 部分採納：改寫措辭（不受信任輸入、擴充不執行、省略 `track.src` 只防網址外洩）；管線 prompt 強化移到「v1 不做」並註明是四站共用項目；不採「本計畫加對抗性管線測試」，理由：不是站點專屬，應另開計畫（設計決定 3、9，風險）。
6. **SPA 換頁時可能把新網址配上舊影片** —— 部分採納：Spike 證實網站換頁會移除舊 video，所以只在回傳前加 `document.contains(video)`＋href 不變檢查與一條測試，不另做更重的同步機制；並把 `overlay-engine.test.js` 納入步驟 4 補 HelloInterview 換頁與跨站排除案例（設計決定 3，步驟 3、4）。
7. **第 6 步過期檢查可能沒有實際擷取就通過** —— 採納：改用尚無課程的 learn 頁，並在 worker log／network 面板確認確實發出字幕 fetch（步驟 6）。
