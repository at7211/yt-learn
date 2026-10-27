yt-learn 擷取擴充功能（Task 0 spike）。
載入：chrome://extensions → 開啟開發人員模式 → 載入未封裝項目 → 選此 extension/ 資料夾。
觸發一：點工具列圖示（用測試影片 GqD0rhajhr0）。
觸發二：在 service worker console 執行 chrome.runtime.sendMessage({type:'probe', videoId:'...'})。
結果：在擴充功能頁點「service worker」開 console，看 [yt-learn] 日誌與最後的 probe result（含 nav/capture/post/total 毫秒）。
