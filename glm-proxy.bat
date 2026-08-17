@echo off
chcp 65001 >nul
echo ============================================
echo  GLM 本地 CORS 代理 (保持此窗口开启)
echo  代理: http://127.0.0.1:8117  ->  https://open.bigmodel.cn
echo  config.json 的 baseUrl 填: http://127.0.0.1:8117/api/paas/v4
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
    echo [X] 未检测到 Node.js, 请先安装: https://nodejs.org
    pause
    exit /b 1
)
node "%~dp0cors-proxy.js" https://open.bigmodel.cn 8117
pause
