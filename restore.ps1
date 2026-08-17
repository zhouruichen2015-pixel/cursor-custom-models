# ============================================================
# Cursor Custom Models 还原脚本 v2.2.0 (多文件: desktop + glass + 扩展主机 + product.json)
# 用法: .\restore.ps1 [-File "path"] [-Force]
# 安全: 当前文件无补丁标记(可能被更新覆盖)时拒绝还原, 防止旧备份覆盖新版;
#       还原前校验备份完整性(空/损坏备份不会覆盖主文件)
# ============================================================
param(
    [string]$File = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$WorkbenchDir = "$env:LOCALAPPDATA\Programs\cursor\resources\app\out\vs\workbench"
$Targets = @()
if ($File) {
    $Targets = @($File)
} else {
    foreach ($name in @("workbench.desktop.main.js", "workbench.glass.main.js")) {
        $p = Join-Path $WorkbenchDir $name
        if (Test-Path $p) { $Targets += $p }
    }
    $extHost = Join-Path $WorkbenchDir "api\node\extensionHostProcess.js"
    if (Test-Path $extHost) { $Targets += $extHost }
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Marker = "__CURSOR_CM__"
$AnyAction = $false

# 备份完整性校验: 空/损坏备份不得覆盖主文件(与 patch.ps1 同规则)
function Test-BakIntact {
    param($Path)
    try {
        if ((Get-Item $Path).Length -lt 1MB) { return $false }
        $probe = [IO.File]::ReadAllText($Path, $Utf8NoBom)
        return ($probe.Contains("async transport(") -or $probe.Contains("registerConnectTransportProvider"))
    } catch { return $false }
}

foreach ($t in $Targets) {
    $leaf = Split-Path $t -Leaf
    $BakFile = "$t.cm-bak"
    Write-Host "===== $leaf ====="

    if (-not (Test-Path $t)) {
        Write-Host "[X] 未找到目标文件: $t" -ForegroundColor Red
        continue
    }
    $t = (Resolve-Path $t).Path
    if (-not (Test-Path $BakFile)) {
        Write-Host "[i] 无备份(可能未打补丁), 跳过" -ForegroundColor DarkGray
        continue
    }

    $Current = [IO.File]::ReadAllText($t, $Utf8NoBom)
    if (-not $Current.Contains($Marker) -and -not $Force) {
        Write-Host "[!] 当前文件不含补丁标记 — 可能已被 Cursor 更新为新版本" -ForegroundColor Yellow
        Write-Host "    还原会用旧备份覆盖新版本导致损坏. 确认回退请用 -Force, 或直接删除备份:" -ForegroundColor Yellow
        Write-Host "    $BakFile"
        continue
    }

    if (-not (Test-BakIntact $BakFile)) {
        Write-Host "[X] 备份不完整(<1MB 或缺特征串), 拒绝还原以防损坏安装: $BakFile" -ForegroundColor Red
        continue
    }

    Copy-Item $BakFile $t -Force
    $Restored = [IO.File]::ReadAllText($t, $Utf8NoBom)
    if ($Restored.Length -lt 1MB -or $Restored.Contains($Marker)) {
        Write-Host "[X] 还原后校验失败(文件过小或仍含标记), 请检查: $t" -ForegroundColor Red
        continue
    }
    Write-Host "[+] 已还原原始文件" -ForegroundColor Green
    Write-Host "[i] 备份保留: $BakFile"
    $AnyAction = $true
}

# ---------- 还原 product.json (校验和) ----------
$ProductJson = "$env:LOCALAPPDATA\Programs\cursor\resources\app\product.json"
$PjBak = "$ProductJson.cm-bak"
if ((Test-Path $PjBak) -and (Test-Path $ProductJson)) {
    $pjOk = $false
    try {
        $pjProbe = [IO.File]::ReadAllText($PjBak, $Utf8NoBom)
        $null = $pjProbe | ConvertFrom-Json
        $pjOk = $pjProbe.Contains("checksums")
    } catch { $pjOk = $false }
    if ($pjOk) {
        Copy-Item $PjBak $ProductJson -Force
        Write-Host "[+] 已还原 product.json (校验和恢复原版)" -ForegroundColor Green
        $AnyAction = $true
    } else {
        Write-Host "[X] product.json 备份非法(非 JSON 或缺 checksums), 跳过还原: $PjBak" -ForegroundColor Red
    }
}

Write-Host ""
if ($AnyAction) { Write-Host "请完全退出 Cursor 后重新启动。" }
else { Write-Host "未执行任何还原(详见上方各文件状态)。" }
