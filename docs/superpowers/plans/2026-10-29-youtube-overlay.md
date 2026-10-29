# yt-learn：把雙語字幕與單字面板直接疊在 YouTube 頁面上（extension overlay 模式）

## Context

使用者看到沉浸式翻譯在 YouTube 播放器上直接疊雙語字幕（截圖），問 yt-learn 的擴充能不能也這樣，不必另開 127.0.0.1:8765 的播放器分頁。

研究結論：**可行，而且大部分零件已經存在。** 證據：

- 開源的 MoJo-Spy/youtube-bilingual-subs 與 Gythiro/yt-dual-subs 都用同一招：content script 把一個絕對定位的 div `appendChild` 進 `#movie_player`，用 CSS 把 YouTube 自己的 `.ytp-caption-window-container` 設成 `opacity:0`，用 `video.currentTime` 對時，用 `yt-navigate-finish` 處理 SPA 換片。`#movie_player` 是進全螢幕的元素，所以放在裡面的子節點全螢幕時仍可見。
- 本專案已有：server 的 CORS 已放行 `https://www.youtube.com`（`server.py:33-44`）；`GET /data/lessons/<id>.json` 已可用；service worker 已經從 127.0.0.1 取資料（`background.js:285` `api()`），所以不會碰到 Chrome 142+ 的 Local Network Access 提示（頁面端 fetch 才會）；`web/timing.js` 是純函式 ES module；`web/style.css:123-282` 的舞台樣式全用 `cqw`，只要 overlay 根節點設 `container-type: inline-size` 就能原樣沿用。
- 目前 `extension/` 在 youtube.com **沒有任何 content script**（manifest 只對 127.0.0.1 掛 `bridge.js`），擷取是用 `chrome.scripting.executeScript` 注入 `capture.js`。所以這是新增一個 content script，不改既有擷取流程。

目標：按擴充圖示後，課程直接疊在 YouTube 播放器上（字幕區雙語＋當前單字橘色、右側單字面板、開場前情提要卡），全螢幕、劇院模式都可用；本機播放器保留不動。

## 設計決定（我做的選擇，可反對）

1. **字幕與單字面板都放在 `#movie_player` 裡**，位置照本機播放器（字幕 left/right 5%、bottom 12%；面板 x 58–97%、y 4–84%）。放在播放器外（`#secondary`）全螢幕會消失，而且產品的 look 就是面板壓在影片右側暗區。
2. **Shadow DOM**：overlay 根節點開 shadow root，裡面放 `overlay.css`（從 `style.css` 的舞台段落抄出，去掉頁面 chrome），避免 YouTube 的全域 CSS 互相汙染。字體 v1 用系統字（Inter → system-ui；Noto Sans TC → PingFang TC；Noto Serif TC → Songti TC），不打包 woff2，等看過再決定。
3. **對時**：isolated world 的 content script 直接讀 `video.html5-main-video`，`requestAnimationFrame` 迴圈（播放中）＋ `seeking/pause` 事件；不用 `#movie_player` 的 undocumented API。
4. **課程資料走 service worker**：content script `sendMessage({type:'ytlearn:lesson', videoId})`，worker 用既有 `api()` 打 `/data/lessons/<id>.json`，回傳 JSON（404 → `{missing:true}`）。
5. **原生字幕**：overlay 啟用時只對 `.ytp-caption-window-container` 加 `opacity:0; pointer-events:none`，不關 CC 按鈕（擷取流程靠 CC 開著才拿得到 timedtext URL）。
6. **換片**：監聽 `document` 的 `yt-navigate-finish`，再加 1 s 的 URL 輪詢當保險；video id 變了就 teardown 再 mount。`<video>` 元素可能被換掉，每次 mount 都重新 query。
7. **廣告**：`#movie_player` 有 `ad-showing` / `ad-interrupting` class 時隱藏 overlay（同一個 media element，currentTime 會變成廣告的時間）。
8. **快捷鍵**（capture-phase keydown，只攔自己的鍵，輸入框內不攔）：`Z` 中文、`E` 英文、`V` 單字面板、`R` 重播本句、`[` `]` 上一句／下一句。不碰 YouTube 的 Space、←→、F、C、K、J、L、M、T。
9. **圖示行為改成**：在 watch 頁按圖示 → 有課程就切換 overlay（開/關）；沒課程就跑既有 `runJob('inplace')`，過程在播放器左下角顯示小 pill「擷取字幕 → 產生課程 x%」（輪詢 `/jobs/<id>`），完成後直接掛 overlay，**不再另開播放器分頁**。非 watch 頁維持原行為。
10. **v1 不做**：片尾總複習格（YouTube 自己會自動播下一部）、逐字稿區、Shorts、嵌入式播放器、miniplayer、PiP。先把播放中的體驗做對。

## 檔案

- 新增 `extension/overlay.js`：content script（`https://www.youtube.com/watch*`，`run_at: document_idle`）。內容：mount/teardown、時間迴圈、`renderSubtitle`/`fitSubtitle`/`buildPanel`/`renderPanel`/`renderIntro`/`showIntro` 從 `web/app.js:547-640, 380-400` 移植（改成以 shadow root 內的節點為對象，不用 `$('id')` 全域查）、快捷鍵、進度 pill。純函式用 `import(chrome.runtime.getURL('timing.js'))` 動態載入。
- 新增 `extension/timing.js`：`web/timing.js` 的複本（manifest 不能把 ES module 當 content script 直接掛）。
- 新增 `extension/overlay.css`：`web/style.css:123-282` 的舞台段落（`.frame/.layer/.subs/.sub-en/.kw/.sub-zh/.panel/.prow/.intro…`）＋ 變數 `--orange/--gold/--mint`，字體堆疊改成系統字；外加 `.ytlearn-on .ytp-caption-window-container{opacity:0;pointer-events:none}` 這條放主文件（shadow 裡管不到 YouTube 節點）。
- 修改 `extension/manifest.json`：加 content_scripts（youtube.com/watch）、`web_accessible_resources: [{resources:['timing.js','overlay.css'], matches:['https://www.youtube.com/*']}]`。
- 修改 `extension/background.js:80-102`：圖示點擊分支改成第 9 點；新增 message handler `ytlearn:lesson`（用既有 `api()`）；`runJob` 完成後對該 tab `sendMessage({type:'ytlearn:mount'})` 而不是 `tabs.create`。
- 修改 `extension/README.md`：說明 overlay 模式與快捷鍵。
- 測試：
  - 新增 `tests/web/extension-timing.test.js`：斷言 `extension/timing.js` 與 `web/timing.js` 逐字節相同（沿用 `extension-ytid.test.js` 的「複本必須一致」模式）。
  - 新增 `tests/web/overlay.test.js`：把 overlay.js 裡不碰 DOM 的部分（video id 判斷、快捷鍵對應表、ad 狀態判斷、lesson 訊息回應整形）抽成可 `vm.runInContext` 載入的純函式測試，比照 `capture.test.js`。
- `README.md` 的「開始用」加一行：在 YouTube 頁按圖示，課程直接疊在播放器上。

## 步驟

0. **開分支** `feat/youtube-overlay`（現在在 main）。
1. **Codex 審計畫**（使用者流程：計畫 → Codex 審 → 實作），重點問：Shadow DOM 內 `cqw` 容器查詢是否成立、`yt-navigate-finish` 之外的保險、`fitSubtitle` 在 shadow root 內量字高的做法。
2. **Spike（半天內可驗）**：先只做 mount 一個固定字串的字幕 div 進 `#movie_player` + 讀 `video.currentTime` 顯示在畫面上。用 Claude-in-Chrome 開 puh91fohvTA 驗四件事：一般模式、劇院模式、全螢幕都看得到；換片後重掛；worker 取 lesson 沒有 LNA 提示；有廣告時 class 偵測成立。任一不成立就回到計畫改設計。
3. 移植渲染（字幕＋橘色單字＋面板＋前情提要卡），CSS 搬過來，shadow root 根節點 `container-type: inline-size`。
4. 圖示流程與進度 pill、快捷鍵、原生字幕隱藏、廣告隱藏、teardown。
5. 測試、README、每個可獨立驗證的步驟一個 commit（`git -c commit.gpgsign=false commit`，不加 Co-Authored-By）。
6. 收尾：對 puh91fohvTA（CC BY）截圖三張（一般／劇院／全螢幕）放 `docs/screenshots/`，供 README。

## 驗證

- `node --test tests/web/`（含新的兩個測試檔）與 `~/.local/bin/uv run --with pytest pytest -q` 全綠。
- Claude-in-Chrome 實測 `https://www.youtube.com/watch?v=puh91fohvTA`（已有課程）：按圖示 → 兩秒內出現雙語字幕與面板；播放到 13:04 附近字幕裡「use cases」標橘、面板第 42 列亮；`V` 關掉面板、`Z` 關中文；全螢幕後字幕與面板仍在、尺寸隨 `cqw` 放大；按 YouTube 推薦影片換片後 overlay 消失或重掛（視該片有無課程）。
- 無課程的影片（例：新影片）：按圖示 → pill 顯示進度 → 完成後 overlay 自動出現，沒有新分頁。
- 原生 CC 字幕在 overlay 開著時看不見、關掉 overlay 後恢復。
- 本機播放器 `http://127.0.0.1:8765/index.html?v=puh91fohvTA` 行為不變。

## 風險與未驗證項

- 全螢幕元素是否仍是 `#movie_player`（兩個開源專案如此，但未在 2026 版 YouTube 親測）→ spike 第 2 步驗。
- `yt-navigate-finish` 是未公開事件，可能改名 → 有 URL 輪詢保險。
- YouTube 的 `.ytp-chrome-bottom` 控制列與字幕 bottom 12% 會重疊，滑鼠移開後控制列自動隱藏；Gythiro 的做法是偵測 `ytp-autohide` class 把字幕抬高，v1 先不做，看實測。
- ToS：沒有找到 YouTube 對字幕疊層擴充執法的紀錄；此專案只供個人本機使用，不公開散布。

## Spike 結果（2026-10-29，Claude-in-Chrome 在 puh91fohvTA 頁面用 JS 直接注入）

- **Trusted Types**：youtube.com 啟用 `require-trusted-types-for 'script'`，對 ShadowRoot/元素設 `innerHTML` 直接丟 `TypeError: This document requires 'TrustedHTML' assignment`。→ overlay 全部用 `createElement`／`textContent`／`append` 建 DOM，不用 `innerHTML`、`insertAdjacentHTML`；`<style>.textContent` 不是 TT sink，可用。
- **Shadow DOM + 容器查詢成立**：host div `position:absolute; inset:0; container-type:inline-size` 掛進 `#movie_player`，shadow 內 `.en{font-size:clamp(15px,3.44cqw,60px)}` 在 1710 px 寬的播放器算出 58.8 px，與本機播放器一致。
- **原生字幕**：`#ytp-caption-window-container` 設 `opacity:0` 後 computed opacity = 0，DOM 文字仍在。
- **使用者另裝了「沉浸式翻譯」**，它也把 `#immersive-translate-caption-window` 掛在 `#movie_player` 裡（同一招，等於第三個佐證）。兩個疊層會重疊 → README 要寫：看 yt-learn 課程時把沉浸式翻譯在 YouTube 關掉。
- **換片**：點推薦影片後 `yt-navigate-start` → `yt-navigate-finish` → `yt-page-data-updated` 依序發出；`#movie_player` 與 `<video>` **是同一個節點**（注入的 div 留在原地、rAF 迴圈讀到新影片的時間）。所以 teardown 不能靠節點被銷毀，要自己拆；`ytd-watch-flexy[video-id]` 屬性可當影片 id 來源（與 URL 互相印證）。
- **全螢幕**：自動化點擊全螢幕按鈕兩次都沒進全螢幕（合成事件不算使用者手勢），**未驗證**；依 Fullscreen API 語意與沉浸式翻譯在全螢幕可用的事實推定可行。實作後請使用者手動按 F 確認。
- 使用者是 YouTube Premium，廣告實際上不會出現；廣告 gating 只做最小版（`ad-showing`/`ad-interrupting` 時隱藏 overlay 並停用快捷鍵）。

## Codex 審查後的修正（折進實作）

1. content script 匹配 `https://www.youtube.com/*`（不是只 `/watch*`），從首頁點進影片沒有整頁重載；由 route 決定是否 mount。
2. 所有非同步工作帶 `{videoId, gen}`（mount generation）；回來時 gen 不符就丟棄。使用者手動關閉 overlay 是明確的 off 狀態，換片不會自動打開（下一支有課程時顯示一個小提示 pill「yt-learn：這支有課程，按圖示開啟」即可；v1 可簡化為自動 mount，但 off 狀態要尊重）。
3. 每次 mount 重新 query `#movie_player` 與 `video`；綁 `play`/`playing`/`pause`/`ended`/`seeked` 事件；rAF 只在播放中跑，teardown 時 cancel。節點暫時不存在時用 MutationObserver／重試等待。
4. 容器查詢的容器是 host 底下一個 `position:absolute; inset:0; container-type:inline-size` 的 `.frame` 元素，不沿用 `web/style.css` `.frame` 的 16:9 aspect-ratio。
5. `fitSubtitle` 在 resize（ResizeObserver on `#movie_player`）、字幕重新顯示後重算；面板 rowH 快取隨 resize 失效；不在 `display:none` 下量測。
6. `.ytlearn-on`（隱藏原生字幕）只加在 `#movie_player` 上，且只在 lesson 成功渲染後加；teardown／錯誤／廣告時移除。
7. 快捷鍵：capture-phase `keydown`；忽略帶 modifier、`isComposing`、`composedPath()` 含 input/textarea/contenteditable 的事件；只在 overlay 開啟時攔自己的鍵並 `stopImmediatePropagation`。
8. **job 流程**：`runJob()` 在 ingest 後就回傳，不等建課完成。所以 watch 頁流程是：content script 透過 worker `ytlearn:job` 訊息輪詢 `GET /jobs/<videoId>`（2 s，worker 的 `api()` 一次一請求，不佔 `busy`），state 為 `done` 才 `ytlearn:lesson` 取課並 mount；`error` 顯示 message。進度 pill 文字沿用 `web/app.js` 的 STATE_TEXT／STEP_NAMES 對應（擷取字幕 → 產生課程 x% → 完成）；`GET /jobs/<id>` 在 building 時已帶 `progress`。
9. `onIconClicked` 在 `openPage`/`onAdded` 之前分支：watch 頁 → 先問 content script（`chrome.tabs.sendMessage(tab.id, {type:'ytlearn:toggle'})`）；content script 回 `{handled:true}` 代表它接手（有課程就切換、沒課程就回報需要產課）。需要產課時 worker 以 `runJob(videoId, {mode:'inplace', tabId})` 跑，**不傳 onAdded、不開分頁、不把使用者分頁登記進 ownedTabs**；非 watch 頁與本機頁面的流程不變。content script 不存在（沒接收者）時退回原本開分頁的行為。
10. worker 的 `onMessage` 對 `ytlearn:lesson`／`ytlearn:job` 回 `true` 以非同步 `sendResponse`；驗證 videoId；404 → `{missing:true}`，server 不通 → `{error}`。
11. 另外複製 `web/intro.js` → `extension/intro.js`（`introRows`），並加「複本一致」測試；CSS 變數 `--orange/--gold/--mint/--sans/--tc/--serif` 在 shadow 內定義；只搬字幕、面板、前情提要、shade 四組規則（`web/style.css:123-211`），不搬 review 與頁面 chrome。
12. 測試補：overlay 的狀態機（mount/teardown/gen 比對/toggle off/stale reply）抽成純函式（`extension/overlay-state.js`，content script 以 `import()` 載入）用 `node --test` 測；worker 的 message handler 分支以 capture.test.js 的 vm 手法測 `{missing:true}`／`{error}`。真瀏覽器的 fullscreen／resize／長字幕由使用者手動驗，列在 README 驗收清單。
