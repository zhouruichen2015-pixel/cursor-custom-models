@echo off
chcp 65001 >nul
echo ============================================
echo  Cursor Custom Models - 安装补丁
echo ============================================
powershell -ExecutionPolicy Bypass -File "%~dp0patch.ps1"
echo.
pause
