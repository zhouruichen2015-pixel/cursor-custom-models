# ============================================================
# Cursor Custom Models 补丁脚本 v2.1.0 (多文件: desktop + glass + 扩展主机 + product.json 校验和)
# 用法:
#   .\patch.ps1                          # 自动发现并补丁全部三个目标文件
#   .\patch.ps1 -File "path\to\xxx.js"   # 仅补丁指定文件
#   .\patch.ps1 -Check                   # 仅检测状态
# 幂等: 重复执行自动先从 .cm-bak 还原再重打
# ============================================================
param(
    [string]$File = "",
    [switch]$Check
)

$ErrorActionPreference = "Stop"

# ---------- 目标文件集合 ----------
$OutDir = "$env:LOCALAPPDATA\Programs\cursor\resources\app\out"
$Targets = @()
if ($File) {
    $Targets = @($File)
} else {
    $cands = @(
        (Join-Path $OutDir "vs\workbench\workbench.desktop.main.js"),
        (Join-Path $OutDir "vs\workbench\workbench.glass.main.js"),
        (Join-Path $OutDir "vs\workbench\api\node\extensionHostProcess.js")
    )
    foreach ($p in $cands) { if (Test-Path $p) { $Targets += $p } }
    if ($Targets.Count -eq 0) {
        Write-Host "[X] 未找到任何目标文件, 请用 -File 指定路径" -ForegroundColor Red
        exit 1
    }
}

$ScriptDir  = $PSScriptRoot
$ConfigFile = Join-Path $ScriptDir "config.json"
$RuntimeFile = Join-Path $ScriptDir "cm-runtime.js"

# ---------- 读取配置 ----------
if (-not (Test-Path $ConfigFile)) {
    Write-Host "[X] 缺少 config.json (应与脚本同目录)" -ForegroundColor Red
    exit 1
}
$ConfigJson = Get-Content $ConfigFile -Raw -Encoding UTF8
try { $null = $ConfigJson | ConvertFrom-Json } catch {
    Write-Host "[X] config.json 不是合法 JSON: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ---------- 读取运行时模板 ----------
if (-not (Test-Path $RuntimeFile)) {
    Write-Host "[X] 缺少 cm-runtime.js (应与脚本同目录)" -ForegroundColor Red
    exit 1
}
$Runtime = [IO.File]::ReadAllText($RuntimeFile)
if ($Runtime -notmatch "__CM_CONFIG_PLACEHOLDER__") {
    Write-Host "[X] cm-runtime.js 中缺少 __CM_CONFIG_PLACEHOLDER__ 占位符" -ForegroundColor Red
    exit 1
}
$RuntimeJs = $Runtime.Replace("__CM_CONFIG_PLACEHOLDER__", $ConfigJson.Trim())
if ($RuntimeJs -eq $Runtime) {
    Write-Host "[X] 配置注入失败" -ForegroundColor Red
    exit 1
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Marker = "__CURSOR_CM__"
$node = Get-Command node -ErrorAction SilentlyContinue

# ---------- 备份完整性校验 ----------
function Test-BakIntact {
    param($Path)
    try {
        if ((Get-Item $Path).Length -lt 1MB) { return $false }
        $probe = [IO.File]::ReadAllText($Path, $Utf8NoBom)
        return ($probe.Contains("async transport(") -or $probe.Contains("registerConnectTransportProvider"))
    } catch { return $false }
}

# ---------- 通用正则锚点(兼容 desktop/glass 及未来变量名) ----------
$Pattern = 'async transport\(\)\{try\{return await ([A-Za-z_$][\w$]*)\(this\._provider,AbortSignal\.timeout\(([A-Za-z_$][\w$]*)\)\)\}catch\{throw new Error\("No Connect transport provider registered\."\)\}\}'
# desktop.main 的精确串(优先, 避免意外多重替换)
$AnchorDesktop = 'async transport(){try{return await gb(this._provider,AbortSignal.timeout(D3u))}catch{throw new Error("No Connect transport provider registered.")}}'

function Invoke-NodeCheck {
    param($Path)
    if (-not $node) { return "skip" }
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $null = & node --check $Path 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    return $code
}

$Summary = @()

# ---------- 状态检测模式 ----------
if ($Check) {
    Write-Host "===== 状态检测 =====" -ForegroundColor Cyan
    Write-Host ("配置启用 : " + ($ConfigJson | ConvertFrom-Json).enabled)
    Write-Host ("上游地址 : " + ($ConfigJson | ConvertFrom-Json).baseUrl)
    Write-Host ("默认模型 : " + ($ConfigJson | ConvertFrom-Json).defaultModel)
    foreach ($t in $Targets) {
        $content = [IO.File]::ReadAllText($t, $Utf8NoBom)
        $bak = "$t.cm-bak"
        Write-Host ("{0}" -f (Split-Path $t -Leaf))
        Write-Host ("  补丁状态 : " + $(if ($content.Contains($Marker)) { "已打补丁" } else { "未打补丁" }))
        Write-Host ("  备份存在 : " + (Test-Path $bak))
    }
    exit 0
}

# ---------- 逐文件打补丁 ----------
foreach ($t in $Targets) {
    $leaf = Split-Path $t -Leaf
    $BakFile = "$t.cm-bak"
    Write-Host "===== $leaf ====="

    if (-not (Test-Path $t)) { Write-Host "[X] 文件不存在: $t" -ForegroundColor Red; $Summary += "$leaf FAIL"; continue }
    $t = (Resolve-Path $t).Path
    $Content = [IO.File]::ReadAllText($t, $Utf8NoBom)
    $AlreadyPatched = $Content.Contains($Marker)

    # 幂等还原
    if ($AlreadyPatched) {
        if (Test-Path $BakFile) {
            if (-not (Test-BakIntact $BakFile)) {
                Write-Host "[X] 备份异常, 跳过该文件: $BakFile" -ForegroundColor Red
                $Summary += "$leaf FAIL(备份异常)"
                continue
            }
            Copy-Item $BakFile $t -Force
            $Content = [IO.File]::ReadAllText($t, $Utf8NoBom)
            if ($Content.Length -lt 1MB) {
                Write-Host "[X] 还原后文件异常, 跳过" -ForegroundColor Red
                $Summary += "$leaf FAIL(还原异常)"
                continue
            }
            Write-Host "[i] 已从备份还原(幂等)" -ForegroundColor Yellow
        } else {
            Write-Host "[X] 已含补丁标记但无备份, 跳过. 请重装 Cursor" -ForegroundColor Red
            $Summary += "$leaf FAIL(无备份)"
            continue
        }
    }

    # 锚点替换(多模式: ext provider 注册点 / 渲染进程 transport() / desktop 精确)
    function Replace-AllMatches([string]$src, [string]$pattern, [scriptblock]$buildRep) {
        $ms = [regex]::Matches($src, $pattern)
        if ($ms.Count -eq 0) { return $null }
        $sb = New-Object System.Text.StringBuilder
        $pos = 0
        $details = @()
        foreach ($m in $ms) {
            [void]$sb.Append($src.Substring($pos, $m.Index - $pos))
            [void]$sb.Append((& $buildRep $m))
            $pos = $m.Index + $m.Length
            $details += ($m.Groups | Select-Object -Skip 1 | ForEach-Object { $_.Value }) -join '/'
        }
        [void]$sb.Append($src.Substring($pos))
        return @{ Text = $sb.ToString(); Count = $ms.Count; Detail = ($details -join ', ') }
    }

    $Patched = $false
    $PatchDetail = ""

    # 模式A: 扩展主机 provider 注册点 (HTTP 真正终止处)
    # 无竞态设计: 注册时立即包一层惰性 Proxy, 每次调用时才解析 globalThis.__CURSOR_CM__
    # (扩展主机可能在文件末尾运行时就绪之前注册 provider, 若注册时条件包装会退化为不包装)
    $repA = @'
registerConnectTransportProvider(__ARG__){this.__FIELD__=(function(t){if(!t||typeof Proxy==="undefined")return t;return new Proxy(t,{get:function(target,prop){if(prop==="unary"||prop==="stream"){return function(){var cm=globalThis.__CURSOR_CM__;if(cm&&cm.wrap){try{return cm.wrap(target)[prop].apply(target,arguments)}catch(e){}}var v=target[prop];return v.apply(target,arguments)};}var v=target[prop];return typeof v==="function"?v.bind(target):v;}});})(__ARG__),this._proxy.$registerAiConnectTransportProvider()}
'@
    $rA = Replace-AllMatches $Content 'registerConnectTransportProvider\(([A-Za-z_$][\w$]*)\)\{this\.([A-Za-z_$][\w$]*)=\1,this\._proxy\.\$registerAiConnectTransportProvider\(\)\}' {
        param($m)
        $arg = $m.Groups[1].Value; $field = $m.Groups[2].Value
        $repA.Replace('__ARG__', $arg).Replace('__FIELD__', $field)
    }
    if ($rA) { $Content = $rA.Text; $Patched = $true; $PatchDetail += "ext-provider x$($rA.Count) ($($rA.Detail)); " }

    # 模式B: 渲染进程 transport() 咽喉点(全局所有副本)
    $rB = Replace-AllMatches $Content $Pattern {
        param($m)
        $fn = $m.Groups[1].Value; $tm = $m.Groups[2].Value
        "async transport(){try{const __cmT=await $fn(this._provider,AbortSignal.timeout($tm));try{return(globalThis.__CURSOR_CM__&&globalThis.__CURSOR_CM__.wrap)?globalThis.__CURSOR_CM__.wrap(__cmT):__cmT}catch(__cmE){return __cmT}}catch{throw new Error(`"No Connect transport provider registered.`")}}"
    }
    if ($rB) { $Content = $rB.Text; $Patched = $true; $PatchDetail += "transport x$($rB.Count) ($($rB.Detail)); " }

    # 模式C: desktop 精确串兜底(若 B 未命中但精确串存在)
    if (-not $rB -and $Content.Contains($AnchorDesktop)) {
        $rep = 'async transport(){try{const __cmT=await gb(this._provider,AbortSignal.timeout(D3u));try{return(globalThis.__CURSOR_CM__&&globalThis.__CURSOR_CM__.wrap)?globalThis.__CURSOR_CM__.wrap(__cmT):__cmT}catch(__cmE){return __cmT}}catch{throw new Error("No Connect transport provider registered.")}}'
        $Content = $Content.Replace($AnchorDesktop, $rep)
        $Patched = $true
        $PatchDetail += "desktop-exact x1; "
    }

    if ($Patched) { Write-Host "[+] 锚点替换成功: $PatchDetail" -ForegroundColor Green }
    if (-not $Patched) {
        Write-Host "[X] 未找到锚点, 该文件未改动" -ForegroundColor Red
        $Summary += "$leaf FAIL(无锚点)"
        continue
    }

    # 追加运行时
    $Content = $Content + "`n" + $RuntimeJs + "`n"

    # 备份原始(此刻磁盘上仍是原始内容)
    $OrigContent = [IO.File]::ReadAllText($t, $Utf8NoBom)
    if (-not $OrigContent.Contains($Marker)) {
        [IO.File]::WriteAllText($BakFile, $OrigContent, $Utf8NoBom)
        Write-Host "[+] 已创建备份" -ForegroundColor Green
    }

    [IO.File]::WriteAllText($t, $Content, $Utf8NoBom)
    Write-Host "[+] 补丁已写入" -ForegroundColor Green

    # 语法校验 + 失败自动回滚
    $code = Invoke-NodeCheck $t
    if ($code -eq "skip") {
        Write-Host "[i] 无 node, 跳过校验" -ForegroundColor DarkGray
        $Summary += "$leaf OK(未校验)"
    } elseif ($code -eq 0) {
        Write-Host "[+] 语法校验通过" -ForegroundColor Green
        $Summary += "$leaf OK"
    } else {
        Write-Host "[!] 语法校验失败(exit=$code)! 自动回滚..." -ForegroundColor Red
        if (Test-Path $BakFile) {
            Copy-Item $BakFile $t -Force
            Write-Host "[+] 已回滚" -ForegroundColor Yellow
            $Summary += "$leaf FAIL(已回滚)"
        } else {
            # 备份缺失(极端: 上一步创建备份失败): 文件保留补丁态, 不做破坏性操作
            Write-Host "[X] 备份缺失无法回滚, 文件保留当前状态, 请重装 Cursor 或手动修复: $t" -ForegroundColor Red
            $Summary += "$leaf FAIL(无备份可回滚)"
        }
    }
}

Write-Host ""
Write-Host "===== 完成 =====" -ForegroundColor Cyan
$Summary | ForEach-Object { Write-Host "  $_" }

# ---------- 更新 product.json 校验和 (IntegrityService 反篡改提示) ----------
# Cursor 的 IntegrityService 用 product.json.checksums (SHA-256 base64 去填充) 校验文件,
# 不匹配时显示 "installation appears to be corrupt"。打补丁后同步更新校验和使其通过。
$ProductJson = Join-Path (Split-Path $OutDir -Parent) "product.json"
if (Test-Path $ProductJson) {
    $PjBak = "$ProductJson.cm-bak"
    if (-not (Test-Path $PjBak)) { Copy-Item $ProductJson $PjBak -Force }
    $pjText = [IO.File]::ReadAllText($ProductJson)
    $shaProv = [System.Security.Cryptography.SHA256]::Create()
    $pjChanged = $false
    foreach ($t in $Targets) {
        try {
            $rel = $t.Substring($OutDir.Length + 1).Replace("\", "/")
            $pat = '"{0}":\s*"[^"]*"' -f [regex]::Escape($rel)
            if ($pjText -match $pat) {
                $h = [Convert]::ToBase64String($shaProv.ComputeHash([IO.File]::ReadAllBytes($t))).TrimEnd("=")
                $newEntry = '"{0}": "{1}"' -f $rel, $h
                $pjText = [regex]::Replace($pjText, $pat, { param($m) $newEntry })
                $pjChanged = $true
                Write-Host "[+] 校验和已更新: $rel" -ForegroundColor Green
            }
        } catch { Write-Host "[!] 校验和更新失败 ${t}: $($_.Exception.Message)" -ForegroundColor DarkYellow }
    }
    if ($pjChanged) { [IO.File]::WriteAllText($ProductJson, $pjText, $Utf8NoBom) }
} else {
    Write-Host "[i] 未找到 product.json, 跳过校验和更新" -ForegroundColor DarkGray
}

Write-Host "请完全退出 Cursor (含托盘进程) 后重新启动生效。"
