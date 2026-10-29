# yt-learn

把一支 YouTube 影片變成一堂英文課：中英雙字幕、右側「本集精選單字」面板、開場「前情提要」卡、片尾總複習格。全部在本機跑，給自己學英文用。

版面是向 [MJ English](https://www.youtube.com/@mjenglish) 頻道的剪輯方式致敬：講者靠左、右側暗區列出本集單字、當前單字在字幕裡標橘、句句都有中譯。這個專案不剪影片，而是把同樣的版面疊在 YouTube 播放器上，任何有字幕的影片都能這樣看。有兩種看法：在 youtube.com 影片頁按擴充功能圖示，課程直接疊在 YouTube 自己的播放器上；或開本機的播放器頁面。

![播放器：滿版影片、右側單字面板、底部雙字幕](docs/screenshots/stage-vocab.jpg)

## 它會做什麼

1. **擷取字幕**：在 YouTube 分頁按一下擴充功能圖示（或在首頁貼網址），擴充會抓 YouTube 自帶的逐字時間戳字幕。
2. **產生課程**：本機 pipeline 切句、翻成繁體中文、挑出值得記的單字片語、寫一張背景卡。語言模型透過你已登入的 CLI 呼叫（預設 Claude，也可用 Codex），不需要 API key。
3. **播放學習**：字幕逐句顯示並標出當前單字；單字面板隨影片推進平滑捲動；開播十秒內左上角浮出前情提要。在 YouTube 頁面上是擴充功能把這些疊在播放器裡（全螢幕、劇院模式都在）；本機播放器多一個片尾總複習格與逐字稿。

| 首頁：貼網址、看進度、挑一堂課 | 產課中的進度卡 |
| --- | --- |
| ![首頁](docs/screenshots/home.jpg) | ![進度卡](docs/screenshots/job-card.jpg) |

| 前情提要卡（開播後十秒淡出） | 播放頁全貌 |
| --- | --- |
| ![前情提要](docs/screenshots/stage-intro.jpg) | ![播放頁](docs/screenshots/player.jpg) |

## 需要什麼

- macOS 或 Linux，Python 3.11 以上（只用標準庫）。
- Chrome，並以「載入未封裝項目」安裝 `extension/`（見 `extension/README.md`）。沒有擴充時可用 `bookmarklet.js` 加首頁的手動匯入。
- 一個已登入的 LLM CLI：`claude`（預設）或 `codex`。
- 影片本身要有字幕軌（自動字幕或上傳字幕都可以）。
- Node 22 與 `uv` 只有跑測試才需要。

## 開始用

```bash
cd yt-learn
python3 server.py            # http://127.0.0.1:8765
```

然後二選一：

- 在 YouTube 影片頁按擴充功能圖示，課程直接疊在 YouTube 播放器上（雙語字幕、橘色單字、右側單字面板、前情提要卡），再按一次關掉。還沒有課程的影片，播放器左下角會顯示「擷取字幕 → 產生課程 x% → 完成」，完成後自動疊上。疊層快捷鍵：Z 中文・E 英文・V 單字面板・R 重播本句・[ ] 上一句／下一句。使用時請把「沉浸式翻譯」在 YouTube 關掉；在 chrome://extensions 重新載入擴充功能後，記得重新整理 YouTube 分頁，並按 F 確認全螢幕時字幕與面板仍在。
- 或打開 <http://127.0.0.1:8765>，貼上影片網址，按「開始」。

進度卡會顯示「擷取字幕 → 產生課程 → 完成」；產課階段有切句進度。一支十分鐘的影片用 Claude 大約兩到三分鐘；Codex 約慢兩倍半，切句較長、挑的單字較少但偏片語。

也可以直接用指令產課（字幕檔已在 `data/raw/<videoId>.json` 時）：

```bash
python3 -m pipeline.build <videoId>                    # 預設 Claude
python3 -m pipeline.build <videoId> --provider codex   # 用 Codex CLI
YTLEARN_PROVIDER=codex python3 server.py               # 讓 server 啟動的產課都用 Codex
```

## 費用

產課用的是 Claude Sonnet 5.5（`pipeline/build.py` 的 `DEFAULT_MODEL`），透過已登入的 `claude` CLI 呼叫，吃的是 Claude 訂閱的用量額度，不是 API 帳單。下面是以 API 牌價（輸入 $2、輸出 $10 每百萬 token）換算的估計，token 數用真實 prompt 與快取回覆估算：

| 影片長度 | 呼叫次數 | 輸入 | 輸出 | 約略費用 |
| --- | --- | --- | --- | --- |
| 6 分 | 12 | 12k | 15k | $0.19 |
| 22 分 | 30 | 31k | 18k | $0.25 |
| 40 分 | 56 | 63k | 34k | $0.45 |

經驗法則：一分鐘影片約 1 到 2 美分，一支 20 分鐘的演講兩三毛美金。重跑同一支影片幾乎免費，回覆都快取在 `data/cache/`，只有 prompt 版本變了才會重新呼叫。

還沒做的省錢空間：每個切句 chunk 都是獨立的 `claude -p` 程序，系統提示每次重送、吃不到 prompt cache，約佔輸入一半；輸出裡一半是把英文原句抄回來，schema 改成只回切點與中譯可砍近半。

## 快捷鍵

- YouTube 疊層：Z 中文・E 英文・V 單字面板・R 重播本句・[ ] 上一句／下一句。YouTube 自己的 Space、← →、F、C、K、J、L、M 不受影響。
- 本機播放器：Space 播放／暫停・← → 上一句／下一句・R 重播本句・Z 中文・E 英文・V 單字面板・F 全螢幕。中文輸入法開著也能用。

## 專案結構

```
extension/   Chrome MV3 擴充：在 YouTube 分頁擷取 json3 字幕送到本機 server，並把課程疊在播放器上
server.py    標準庫 HTTP server：靜態網頁、/ingest、/add、/jobs、產課佇列
pipeline/    words（字詞正規化）→ chunk → segment（切句翻譯）→ vocab（挑字）→ intro（前情提要）→ build
web/         播放器：index.html、app.js、style.css、timing.js（純函式）
data/        raw/（字幕）、lessons/（課程 JSON）、cache/（LLM 回覆）、jobs/（build log）
tests/       pytest（pipeline、server）與 node --test（web 純函式、擴充功能的純函式與 worker 訊息）
docs/        設計與計畫（superpowers/plans）、參考版面觀察、截圖
```

```bash
~/.local/bin/uv run --with pytest pytest -q     # pipeline + server
node --test tests/web/                           # 播放器與擴充功能的純函式
```

## 已知限制

- 自動字幕的品質決定切句與單字的品質；沒有字幕軌的影片做不了。
- 兩個 LLM 都只透過本機 CLI 呼叫，速度取決於你的帳號與模型；回覆會快取在 `data/cache/`，重跑同一支影片很快。
- 兩種疊層都蓋在 YouTube 播放器上（擴充功能蓋在 youtube.com 的播放器，本機播放器蓋在嵌入播放器），只適合個人本機使用，不要公開部署。
- YouTube 疊層與「沉浸式翻譯」這類也在播放器上畫字幕的擴充會重疊，看課時先把它們在 YouTube 關掉。
- 前情提要卡的字數有上限，模型兩次都寫太長時那一堂就沒有卡，其他功能照常。

## 素材出處

截圖與介紹片裡的影片畫面來自 dotconferences 上傳的〈Agents for production engineering - Alex Palcuie - Anthropic〉（<https://www.youtube.com/watch?v=puh91fohvTA>），YouTube 標示為「創用 CC 姓名標示」授權（CC BY）。播放器本身只嵌入 YouTube 播放器，不複製任何影片內容。

## 開發紀錄

每個功能都先寫設計與計畫、交給 Codex 審查，再分任務實作與審查；計畫與量測結果在 `docs/superpowers/plans/`，參考影片的版面觀察在 `docs/superpowers/notes/`。
