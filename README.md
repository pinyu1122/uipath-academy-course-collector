# UiPath Academy SCORM Course Collector

這個資料夾只保留最後成功的版本：用 Chrome CDP 連到已登入的 UiPath Academy 課程頁，直接從 Adobe SCORM player 擷取 lesson 內容，並嘗試下載 Wistia 影片字幕。

## 目前保留內容

- `run_cdp.bat`：開啟可被程式連線的 Chrome，連線位址是 `http://127.0.0.1:9222`。
- `scrape_current_scorm.bat`：整理目前 Chrome 裡已開啟的 SCORM 課程。
- `scrape_learning_plan_next.bat`：從目前 learning plan 或已開啟的課程 player 開始，重複整理目前 SCORM module，然後按 UiPath Academy 外層 `Next`，一路整理下一個 module。
- `scrape_scorm_cdp.mjs`：主要爬蟲程式，會抓 lesson 內容、Rise 互動區塊、Wistia 字幕、Rise quiz 題目與選項、Scribe 互動教學步驟，並下載課程附件。
- `academy_course_output/`：爬蟲執行後產生的本機輸出資料夾。這個資料夾預設不會上傳到 GitHub，避免公開課程內容、字幕或下載附件。

## 使用方式

### 整理目前開啟的一門 SCORM 課

1. 執行 `run_cdp.bat`。
2. 在它開啟的 Chrome 裡登入 UiPath Academy。
3. 進入 learning plan，再手動點進某一門課程模組，直到畫面出現 lesson player。
4. 執行 `scrape_current_scorm.bat`。
5. 結果會輸出到：

```text
academy_course_output/<課程名稱>/
```

### 從 learning plan 一路按 Next 整理

1. 執行 `run_cdp.bat`。
2. 在它開啟的 Chrome 裡登入 UiPath Academy。
3. 停在 learning plan 頁面，或先手動開啟其中一個 SCORM lesson player。
4. 執行 `scrape_learning_plan_next.bat`。

這個模式會重複：

```text
整理目前 SCORM module → 按外層 Next → 等下一個 SCORM player 載入 → 繼續整理
```

如果只想先測幾個 module，可以在命令列設定：

```bat
set MAX_NEXT_STEPS=5
scrape_learning_plan_next.bat
```

## 輸出結果

每門課會產生：

- `lessons/`：每一個 lesson 一個 Markdown 檔。
- `full_course.md`：整門課合併成一份 Markdown。
- `scorm_scrape_report.json`：擷取報告與偵測到的原始資料。
- `raw_captions/`：如果影片有 Wistia 字幕，會保留原始字幕 JSON 或 VTT。
- `downloads/`：課程內可下載的 PDF、ZIP、DOCX、XLSX、TXT、XAML、NUPKG、UIPX 等附件。檔名會自動去掉畫面上的檔案大小文字，例如 `132.5 KB`；如果下載的是 `.zip`，會自動解壓到 `downloads/extracted/`。
- `interactive_walkthroughs/`：Scribe 互動教學的原始擷取 JSON。
- `## Quiz Questions`：如果課程含 `Check your knowledge`，會在該 lesson Markdown 內列出題目、題型與選項；程式不會自動作答或送出 quiz。
- `## Rise Interactive Blocks`：如果 lesson 內含 Rise accordion/button 等互動區塊，會從課程資料補出各項目的標題、說明與圖片檔名。
- `## Interactive Walkthroughs`：如果 lesson 內嵌 Scribe 互動教學，會逐步整理 `Step x/y` 的文字與圖片連結。
- `## Downloaded Files`：列出已存到 `downloads/` 的附件，下載失敗時會寫明原因。
- `_learning_plan_runs/`：使用 `scrape_learning_plan_next.bat` 時，會記錄每次一路按 Next 的執行紀錄。

本機測試曾成功整理的課程：

```text
academy_course_output/Build your first agent with UiPath Studio Web/
```

曾確認結果：

- Lesson 數量：12
- 合併檔：`full_course.md`
- 字幕：已抓到 7 個 Wistia 中文字幕原始檔，存放於 `raw_captions/`

## 適用範圍

這個版本適用於 UiPath Academy 裡使用 Adobe SCORM player 的課程。它不是從 learning plan 清單一鍵爬完整個學習計畫，而是「你先手動進入某一門課，程式再把這一門課的 lessons 全部整理出來」。

如果要整理同一個 learning plan 裡的其他課程，做法是：

1. 回到 UiPath Academy learning plan。
2. 點進下一門課程模組。
3. 等 lesson player 顯示出來。
4. 再執行一次 `scrape_current_scorm.bat`。

## 注意事項

- Chrome 必須由 `run_cdp.bat` 開啟，或至少已經用 `--remote-debugging-port=9222` 啟動。
- 執行爬蟲前，Chrome 裡要停在真正的課程 lesson player，不是 learning plan 清單頁。
- 影片畫面空白不一定代表不能抓字幕；只要頁面載入了 Wistia media id，程式會直接嘗試抓字幕端點。
- 重跑同一門課時，程式會先清空該課程輸出資料夾中的 `lessons/`、`raw_captions/`、`downloads/`、`interactive_walkthroughs/`、`_debug/`，再重新產生結果，避免新舊資料混在一起。
- `.zip` 檔會使用 Windows PowerShell 的 `Expand-Archive` 自動解壓；`.rar`、`.7z` 這類格式仍會下載保存，但不會自動解壓。
- 如果同時開很多個 UiPath SCORM 課程分頁，建議只保留你要整理的那一個，避免抓到錯的課程。
- `scrape_learning_plan_next.bat` 只會整理 SCORM player 類型的內容；如果 Next 到 survey、assessment 或非 SCORM 頁面，程式會停止，不會自動填答或送出任何測驗。

## 需求

- Windows
- Google Chrome
- Node.js 22 以上，建議 Node.js 24

不需要另外安裝 Python 套件。
