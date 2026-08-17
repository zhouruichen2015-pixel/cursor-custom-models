@echo off
chcp 65001 >nul
echo ============================================
echo  Cursor Custom Models - 集成测试 (34项, 无需真实Key)
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
    echo [X] 未检测到 Node.js, 请先安装: https://nodejs.org
    pause
    exit /b 1
)
node "%~dp0test-integration.js"
echo.
pause
