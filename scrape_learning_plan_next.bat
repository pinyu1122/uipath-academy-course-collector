@echo off
chcp 65001 > nul
echo Scraping the current UiPath Academy learning plan by repeatedly pressing the outer Next button...
echo.
echo Before running this:
echo 1. Open Chrome with run_cdp.bat.
echo 2. Sign in to UiPath Academy.
echo 3. Open the learning plan or an already-open SCORM lesson player.
echo.
echo Optional: set MAX_NEXT_STEPS=20 to limit how many modules this run will process.
echo.
node "%~dp0scrape_learning_plan_next_cdp.mjs"
echo.
pause
