@echo off
chcp 65001 >nul
echo ============================================
echo  Cursor Custom Models - 状态检测
echo ============================================
powershell -ExecutionPolicy Bypass -File "%~dp0patch.ps1" -Check
echo.
pause
