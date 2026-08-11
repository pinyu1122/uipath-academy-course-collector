@echo off
chcp 65001 > nul
echo Scraping the currently open Adobe SCORM course from Chrome CDP...
node "%~dp0scrape_scorm_cdp.mjs"
echo.
pause
