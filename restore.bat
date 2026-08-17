@echo off
chcp 65001 >nul
echo ============================================
echo  Cursor Custom Models - 还原原版
echo ============================================
powershell -ExecutionPolicy Bypass -File "%~dp0restore.ps1"
echo.
pause
