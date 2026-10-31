yt-learn 擷取擴充功能（v1.5.0，未封裝）。
支援站點：YouTube 影片頁（https://www.youtube.com/watch?v=<id>）與 Udemy 講座頁（https://www.udemy.com/course/<slug>/learn/lecture/<id>，課程 id 為 udemy.<lectureId>）。兩站共用同一個疊層引擎（overlay.js），站點差異都在 site.js 的轉接層（課程 id、播放器 {root, video}、廣告、隱藏原生字幕、換頁事件）。
載入：chrome://extensions → 開啟開發人員模式 → 載入未封裝項目 → 選此 extension/ 資料夾。改過檔案後按該擴充功能的「重新載入」，並重新整理 http://127.0.0.1:8765 的分頁。
入口一（圖示，疊層模式）：在 https://www.youtube.com/watch?v=<id> 分頁按工具列圖示 → 課程直接疊在 YouTube 播放器上（英文字幕＋當前單字橘色、繁中字幕、右側單字面板、開場 10 秒前情提要卡），再按一次關掉。這支還沒有課程時，播放器左下角出現小 pill「yt-learn：擷取字幕… → 產生課程 x% → 完成」，在目前分頁擷取字幕、等產課完成後自動疊上，不開新分頁。手動關掉後換片不會自動打開；開著時換到有課程的影片會自動疊上。
疊層快捷鍵（只在疊層開著時攔，輸入框內不攔；YouTube 自己的 Space、← →、F、C、K、J、L、M 不受影響）：Z 中文・E 英文・V 單字面板・R 重播本句・[ ] 上一句／下一句。
查字典：點字幕裡的任何一個字，影片暫停並在旁邊的小視窗開劍橋英漢字典（overlay.js 送 ytlearn:dict，worker 用 chrome.windows.create 開 520×760 popup，視窗 id 記在 storage.session 的 dictWindowId，之後的查詢沿用同一個視窗；只接受 https://dictionary.cambridge.org/ 的網址）。
疊層注意：看 yt-learn 課程時請把「沉浸式翻譯」在 YouTube 關掉（兩個疊層會疊在一起）。重新載入擴充功能後，已開著的 YouTube 分頁按圖示時 worker 會自動補注入 overlay.js，不必重新整理；只有注入也失敗時才退回舊行為（在目前分頁擷取 → 開新分頁 index.html?v=<id> 顯示進度）。Shorts／其他網址形式改用靜音背景分頁擷取。非影片頁 → 開 index.html。
Udemy 注意：只支援已購買課程的講座頁（不含預覽彈窗、Udemy Business 子網域），需要英文字幕。在講座頁按圖示 → 在目前分頁注入 vtt.js＋udemy-capture.js（isolated world），只重現頁面自己會做的兩個請求（講座 API、字幕 VTT），不批次、不背景；Udemy 非講座頁按圖示 → 開首頁。換課（SPA）由每秒輪詢偵測：課程 id 或播放器 {root, video} 任一改變都會拆掉重掛（Udemy 換課會整個換掉 <video>），自動換課只重新載入課程、不會自己開始擷取。worker 在點擊時凍結 {id, url}：/add 回來的 id 或擷取到的 videoId 不符就中止（「換課了，請回到原講座再試」）。疊層開著時隱藏 Udemy 自己的字幕（[class*="caption-container"]）。全螢幕下疊層是否仍在需人工確認。
疊層手動驗收（自動化測不到）：在 chrome://extensions 重新載入未封裝的擴充功能、重新整理 YouTube 分頁後，按 F 進全螢幕確認字幕與面板仍在、尺寸跟著放大；劇院模式（T）與視窗縮放也看一次；長句英文會縮成兩行內。
圖示右鍵選單：「打開 yt-learn 首頁」開 index.html，「設定」開 index.html#settings（首頁的設定區會自動展開）；選單在 onInstalled 建立，重新載入擴充功能後才出現。
入口二（本機首頁）：bridge.js 轉送頁面的 window.postMessage({type:'ytlearn:ping'|'ytlearn:capture', videoId})；回 ytlearn:ack 與 ytlearn:status。
除錯：在擴充功能頁點「service worker」開 console，看 [yt-learn] 日誌。
檔案：background.js（worker）、capture.js（MAIN world 擷取，與 bookmarklet.js 同源）、bridge.js（首頁 content script）、overlay.js（youtube.com／udemy.com 的疊層引擎 content script，全部用 createElement 建 DOM，因為 YouTube 強制 Trusted Types）、site.js（站點轉接層）、overlay-state.js（疊層的純函式狀態）、vtt.js／udemy-capture.js（Udemy 字幕解析與擷取）、overlay.css（疊層樣式，抄自 web/style.css 的舞台段落）、timing.js／intro.js／dict.js（web/ 的逐字節複本，改一邊請同步另一邊）、ytid.js（網址解析，與 pipeline/jobs.py 同表）。
