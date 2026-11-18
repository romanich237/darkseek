@echo off
chcp 65001 >nul
cd /d "%~dp0"
node update.js --apply
set "result=%errorlevel%"
pause
exit /b %result%
