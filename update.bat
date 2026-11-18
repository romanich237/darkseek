@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

:menu
cls
echo DarkSeek
echo.
echo 1. Проверить обновления
echo 2. Установить обновления
echo 0. Выход
echo.
choice /c 120 /n /m "Выберите действие [1, 2, 0]: "
if errorlevel 3 exit /b 0
if errorlevel 2 goto install
if errorlevel 1 goto check
exit /b 1

:check
node update.js
pause
goto menu

:install
node update.js --apply
pause
goto menu
