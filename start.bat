@echo off
chcp 65001 >nul
cd /d "%~dp0"
node server.js
set "result=%errorlevel%"
pause
exit /b %result%
