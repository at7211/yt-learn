yt-learn 擷取擴充功能（v1.1.0，未封裝）。
載入：chrome://extensions → 開啟開發人員模式 → 載入未封裝項目 → 選此 extension/ 資料夾。改過檔案後按該擴充功能的「重新載入」，並重新整理 http://127.0.0.1:8765 的分頁。
入口一（圖示）：在 https://www.youtube.com/watch?v=<id> 分頁按工具列圖示 → 在目前分頁擷取字幕 → 開新分頁 index.html?v=<id> 顯示進度。Shorts／其他網址形式改用靜音背景分頁擷取。非影片頁 → 開 index.html。
入口二（本機首頁）：bridge.js 轉送頁面的 window.postMessage({type:'ytlearn:ping'|'ytlearn:capture', videoId})；回 ytlearn:ack 與 ytlearn:status。
除錯：在擴充功能頁點「service worker」開 console，看 [yt-learn] 日誌。
檔案：background.js（worker）、capture.js（MAIN world 擷取，與 bookmarklet.js 同源）、bridge.js（首頁 content script）、ytid.js（網址解析，與 pipeline/jobs.py 同表）。
