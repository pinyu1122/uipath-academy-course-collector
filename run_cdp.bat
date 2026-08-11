@echo off
chcp 65001 > nul
set COURSE_URL=https://academy.uipath.com/learning-plans/agentic-automation-developer-associate-training
set CDP_PROFILE=%LOCALAPPDATA%\UiPathAcademyCourseCollector\cdp_chrome_profile

set CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME_EXE%" set CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME_EXE%" set CHROME_EXE=chrome

echo Opening Chrome in CDP attach mode on http://127.0.0.1:9222 ...
echo Profile: %CDP_PROFILE%
echo.
start "" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%CDP_PROFILE%" --new-window "%COURSE_URL%"

echo After Chrome opens, sign in to UiPath Academy in that Chrome window.
echo Open a course module until you can see the SCORM lesson player.
echo Then run scrape_current_scorm.bat to collect the currently open course.
echo.
pause
