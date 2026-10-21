# WebView2 运行时修复脚本：卸载后重装
#
# 用法（任选其一）：
#   1. 右键此文件 → 「使用 PowerShell 运行」
#   2. 在任意终端执行：
#        pwsh -NoProfile -ExecutionPolicy Bypass -File .\repair-webview2.ps1
#
# 运行后会弹出 UAC，点「是」即可。脚本会自行以管理员身份重跑。
# 注意：卸载期间依赖 WebView2 的应用（部分桌面软件）会暂时不可用，重装完成后恢复。

$ErrorActionPreference = 'Stop'

$Bootstrapper = Join-Path $env:TEMP 'wv2setup.exe'
$InstallDir = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application'

# ---------- 1. 自举提权 ----------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host '需要管理员权限，正在请求提权……' -ForegroundColor Yellow
    $argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
    Start-Process -FilePath 'pwsh.exe' -Verb RunAs -ArgumentList $argsList
    exit
}

Write-Host '=== WebView2 运行时修复 ===' -ForegroundColor Cyan

# ---------- 2. 环境检查 ----------
if (-not (Test-Path $InstallDir)) {
    Write-Host "找不到安装目录：$InstallDir" -ForegroundColor Red
    exit 1
}

# 找到当前版本的官方卸载器 setup.exe
$setupExe = Get-ChildItem $InstallDir -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'Installer\setup.exe' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1

if (-not $setupExe) {
    Write-Host '找不到卸载器 setup.exe，安装可能已损坏。' -ForegroundColor Red
    exit 1
}
Write-Host "卸载器: $setupExe"

if (-not (Test-Path $Bootstrapper)) {
    Write-Host "找不到安装器：$Bootstrapper" -ForegroundColor Red
    Write-Host '请先下载：https://go.microsoft.com/fwlink/p/?LinkId=2124703 另存到该路径'
    exit 1
}

# ---------- 3. 结束占用进程 ----------
Write-Host '停止所有 WebView2 进程……'
Get-Process -Name 'msedgewebview2' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# ---------- 4. 卸载 ----------
Write-Host '卸载现有运行时……（可能需要 1-2 分钟）'
$uninstallParams = @{
    FilePath     = $setupExe
    ArgumentList = @('--uninstall', '--msedgewebview2', '--system-level', '--force-uninstall')
    PassThru     = $true
    Wait         = $true
}
$uninstall = Start-Process @uninstallParams
Write-Host "  卸载进程退出码: $($uninstall.ExitCode)  (0 表示成功)"

Start-Sleep -Seconds 5
if (Test-Path $InstallDir) {
    $left = @(Get-ChildItem $InstallDir -ErrorAction SilentlyContinue)
    Write-Host "  安装目录仍存在，剩余 $($left.Count) 项" -ForegroundColor Yellow
} else {
    Write-Host '  安装目录已移除' -ForegroundColor Green
}

# ---------- 5. 重装 ----------
Write-Host '重新安装运行时……（需要联网下载约 150MB，请稍候）'
$installParams = @{
    FilePath     = $Bootstrapper
    ArgumentList = @('/silent', '/install')
    PassThru     = $true
    Wait         = $true
}
$install = Start-Process @installParams
Write-Host "  安装进程退出码: $($install.ExitCode)  (0 表示成功)"

Start-Sleep -Seconds 8

# ---------- 6. 验证 ----------
Write-Host ''
if (Test-Path $InstallDir) {
    $versions = @(Get-ChildItem $InstallDir -Directory |
        Where-Object { $_.Name -match '^\d+\.' } |
        Select-Object -ExpandProperty Name)
    if ($versions.Count -gt 0) {
        Write-Host '修复完成，当前版本：' -ForegroundColor Green
        $versions | ForEach-Object { Write-Host "  $_" }
        $target = Join-Path $InstallDir $versions[-1]
        $core = Join-Path $target 'msedgewebview2.exe'
        Write-Host ("  主程序存在: {0}" -f (Test-Path $core))
    } else {
        Write-Host '安装目录为空，修复可能未成功。' -ForegroundColor Red
    }
} else {
    Write-Host '安装目录不存在，修复失败。' -ForegroundColor Red
}

Write-Host ''
Write-Host '完成后回到项目目录执行：npm run tauri dev' -ForegroundColor Cyan
Write-Host ''
Read-Host '按回车键关闭'
