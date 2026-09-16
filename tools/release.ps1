<#
    release.ps1 —— 一条命令走完发布
    ------------------------------------------------------------------
    编译 → 两套自检 → 打包 vsix → 取 PAT → 发布 → 核对市场版本并比对产物

    取 PAT 的优先级（前面的能用就不问后面的）：
      1. -Pat <token>        命令行显式传入
      2. $env:VSCE_PAT       已有环境变量
      3. Bitwarden CLI       设了 $env:BW_SESSION（已解锁）时，用 bw get password 取
      4. 掩码输入            Read-Host -MaskInput（不会进 PowerShell 历史）

    用法（在工程根目录）：
      pwsh -File tools\release.ps1 -DryRun          # 全流程演练：编译+自检+打包+校验 token，但不发布
      pwsh -File tools\release.ps1                  # 发布当前版本
      pwsh -File tools\release.ps1 -Bump patch      # 先 npm version 升版本并推送，再发布
      pwsh -File tools\release.ps1 -Item 'VS Code Marketplace PAT — YuHaoran251'

    Bitwarden 的用法（推荐）：
      bw login                      # 一次性
      $env:BW_SESSION = bw unlock --raw
      pwsh -File tools\release.ps1  # token 全程不落地、不进历史
#>
[CmdletBinding()]
param(
    # 只演练不发布（仍会编译、自检、打包；有 token 就顺便 verify-pat）
    [switch]$DryRun,

    # 先升版本再发布：patch | minor | major
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump,

    # 显式传入 PAT（不推荐：会进命令行历史）
    [string]$Pat,

    # Bitwarden 里的条目名
    [string]$Item = 'VS Code Marketplace PAT — YuHaoran251',

    # 发布后等市场收录的秒数上限
    [int]$VerifyTimeoutSec = 300
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

# ── 0. 基本信息 ────────────────────────────────────────────────────────
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$vsixName = "$($pkg.name)-$($pkg.version).vsix"
Write-Host "发布目标：$($pkg.publisher).$($pkg.name) v$($pkg.version)"

# ── 1. 可选：升版本（含提交与推送，失败即中止，避免"市场有、仓库没有"）──
if ($Bump) {
    Step "升版本（$Bump）"
    npm version $Bump
    if ($LASTEXITCODE -ne 0) { Die "npm version 失败" }
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $vsixName = "$($pkg.name)-$($pkg.version).vsix"
    git push origin HEAD --follow-tags
    if ($LASTEXITCODE -ne 0) { Die "推送失败；已中止，未发布（避免版本只存在于市场）" }
    Ok "版本已升到 $($pkg.version)，提交与 tag 已推送"
}

# ── 2. 编译 + 自检 ─────────────────────────────────────────────────────
Step '编译 + 自检'
npm run check
if ($LASTEXITCODE -ne 0) { Die "npm run check 未通过，已中止（不要发布坏掉的构建）" }
Ok '编译与自检通过'

# ── 3. 打包 ────────────────────────────────────────────────────────────
Step "打包 $vsixName"
Remove-Item $vsixName -Force -ErrorAction SilentlyContinue
npx --yes @vscode/vsce package --no-dependencies --out $vsixName
if ($LASTEXITCODE -ne 0) { Die 'vsce package 失败' }
$vsix = Join-Path $root $vsixName
$hash = (Get-FileHash $vsix).Hash
Ok "$vsixName  ($((Get-Item $vsix).Length) 字节)"
Write-Host "    SHA256 $hash"

# ── 4. 取 PAT ──────────────────────────────────────────────────────────
Step '取 PAT'
$patValue = $null
$patFrom = $null

if ($Pat) { $patValue = $Pat.Trim(); $patFrom = '-Pat 参数' }
elseif ($env:VSCE_PAT) { $patValue = $env:VSCE_PAT.Trim(); $patFrom = '$env:VSCE_PAT' }
elseif ($env:BW_SESSION) {
    $bw = (Get-Command bw -ErrorAction SilentlyContinue).Source
    if (-not $bw) {
        $bw = @(
            "$env:LOCALAPPDATA\Microsoft\WinGet\Links\bw.exe",
            "$env:LOCALAPPDATA\Programs\Bitwarden CLI\bw.exe"
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $bw) {
            $bw = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'Bitwarden.CLI*' -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'bw.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
        }
    }
    if ($bw) {
        try {
            $patValue = (& $bw get password $Item --session $env:BW_SESSION 2>$null | Select-Object -First 1)
            if ($patValue) { $patValue = $patValue.Trim(); $patFrom = "Bitwarden（条目：$Item）" }
        } catch { Warn "Bitwarden 取密码失败：$($_.Exception.Message)" }
        if (-not $patValue) { Warn "Bitwarden 里没取到「$Item」——检查条目名，或先 bw sync" }
    } else { Warn '没找到 bw.exe' }
}
elseif (-not $DryRun) {
    $secure = Read-Host -MaskInput -Prompt 'Marketplace PAT（输入不回显、不进历史）'
    if (-not $secure) { Die '没有输入 PAT' }
    $patValue = $secure.Trim(); $patFrom = '掩码输入'
}

if ($patValue) {
    Ok "已取得 PAT（来源：$patFrom，长度 $($patValue.Length)）"
    $env:VSCE_PAT = $patValue
    Step '校验 PAT'
    npx --yes @vscode/vsce verify-pat $pkg.publisher
    if ($LASTEXITCODE -ne 0) { Die 'PAT 校验失败（401/403 多半是权限或过期；需要 All accessible organizations + Marketplace→Manage）' }
    Ok 'PAT 有效'
} else {
    Warn '未取得 PAT（演练模式不提示输入）'
}

if ($DryRun) {
    Step '演练结束'
    Write-Host "  未发布。正式发布请去掉 -DryRun：`n    npx --yes @vscode/vsce publish -i .\$vsixName"
    Remove-Item Env:VSCE_PAT -ErrorAction SilentlyContinue
    exit 0
}

if (-not $patValue) { Die '正式发布必须有 PAT' }

# ── 5. 发布 ────────────────────────────────────────────────────────────
Step "发布 $($pkg.publisher).$($pkg.name) v$($pkg.version)"
npx --yes @vscode/vsce publish -i $vsixName
$publishCode = $LASTEXITCODE
Remove-Item Env:VSCE_PAT -ErrorAction SilentlyContinue
if ($publishCode -ne 0) { Die 'vsce publish 失败' }
Ok '已上传'

# ── 6. 核对：市场版本 + 产物逐字节比对 ─────────────────────────────────
Step '核对市场'
$deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
$listed = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 20
    $body = @{
        filters = @(@{ criteria = @(@{ filterType = 7; value = "$($pkg.publisher).$($pkg.name)" }) })
        flags   = 1
    } | ConvertTo-Json -Depth 8
    try {
        $q = Invoke-RestMethod -Method Post -TimeoutSec 30 `
            -Uri 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery' `
            -Headers @{ Accept = 'application/json;api-version=7.2-preview.1' } `
            -ContentType 'application/json' -Body $body
        $latest = ($q.results[0].extensions[0].versions | Select-Object -First 1).version
        Write-Host "  市场最新版本：$latest"
        if ($latest -eq $pkg.version) { $listed = $true; break }
    } catch { Write-Host "  查询失败（传播中）：$($_.Exception.Message)" }
}
if ($listed) { Ok "市场列表已显示 v$($pkg.version)" } else { Warn "等了 $VerifyTimeoutSec 秒仍未显示 v$($pkg.version)（包一般已可用，列表元数据会再延迟几分钟）" }

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $tmp = Join-Path $env:TEMP "verify-$($pkg.name)-$($pkg.version).vsix"
    Invoke-WebRequest -TimeoutSec 90 -OutFile $tmp `
        -Uri "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/$($pkg.publisher)/vsextensions/$($pkg.name)/$($pkg.version)/vspackage"
    $zip = [System.IO.Compression.ZipFile]::OpenRead($tmp)
    $localEntry = @($zip.Entries | Where-Object { $_.FullName -like 'extension/out/*.js' })
    $mismatch = 0
    foreach ($e in $localEntry) {
        $sr = New-Object System.IO.StreamReader($e.Open()); $remote = $sr.ReadToEnd(); $sr.Close()
        $localPath = Join-Path $root ($e.FullName -replace '^extension/', '')
        if ((Test-Path $localPath) -and ([System.IO.File]::ReadAllText($localPath) -ne $remote)) { $mismatch++ }
    }
    $zip.Dispose(); Remove-Item $tmp -Force
    if ($mismatch -eq 0) { Ok '市场包内的 out/*.js 与本地编译产物逐字节一致' }
    else { Warn "$mismatch 个文件与本地不一致（可能包里有旧构建，检查 .vscodeignore / 编译）" }
} catch { Warn "下载市场包比对失败：$($_.Exception.Message)" }

Step '完成'
Write-Host "  https://marketplace.visualstudio.com/items?itemName=$($pkg.publisher).$($pkg.name)"
Write-Host "  本地产物：$vsixName"
