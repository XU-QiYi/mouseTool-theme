<#
.SYNOPSIS
    C盘清理工具 - 使用 uv 管理 Python 环境
.DESCRIPTION
    清理常见的 C 盘空间占用，包括临时文件、缓存、日志等
.EXAMPLE
    .\clean_c_drive.ps1              # 显示帮助
    .\clean_c_drive.ps1 -DryRun      # 模拟运行，查看会清理什么
    .\clean_c_drive.ps1 -All         # 执行所有清理任务
    .\clean_c_drive.ps1 -Temp        # 只清理临时文件
    .\clean_c_drive.ps1 -Browsers    # 只清理浏览器缓存
#>

param(
    [switch]$DryRun,
    [switch]$All,
    [switch]$Temp,
    [switch]$UpdateCache,
    [switch]$Thumbnails,
    [switch]$Browsers,
    [switch]$RecycleBin,
    [switch]$Logs
)

$ErrorActionPreference = "Stop"

# 获取脚本所在目录
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonScript = Join-Path $ScriptDir "clean_c_drive.py"

# 检查 uv 是否可用
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Error "未找到 uv 命令。请先安装 uv: https://docs.astral.sh/uv/getting-started/installation/"
    exit 1
}

# 构建参数
$args = @()

if ($DryRun) { $args += "--dry-run" }
if ($All) { $args += "--all" }
if ($Temp) { $args += "--temp" }
if ($UpdateCache) { $args += "--update-cache" }
if ($Thumbnails) { $args += "--thumbnails" }
if ($Browsers) { $args += "--browsers" }
if ($RecycleBin) { $args += "--recycle-bin" }
if ($Logs) { $args += "--logs" }

# 如果没有指定任何选项，显示帮助
if (-not ($All -or $Temp -or $UpdateCache -or $Thumbnails -or $Browsers -or $RecycleBin -or $Logs)) {
    Write-Host "C盘清理工具" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "用法:" -ForegroundColor Yellow
    Write-Host "  .\clean_c_drive.ps1 -DryRun      # 模拟运行，查看会清理什么"
    Write-Host "  .\clean_c_drive.ps1 -All         # 执行所有清理任务"
    Write-Host "  .\clean_c_drive.ps1 -Temp        # 只清理临时文件"
    Write-Host "  .\clean_c_drive.ps1 -Browsers    # 只清理浏览器缓存"
    Write-Host ""
    Write-Host "选项:" -ForegroundColor Yellow
    Write-Host "  -DryRun         模拟运行，不实际删除文件"
    Write-Host "  -All            执行所有清理任务"
    Write-Host "  -Temp           清理 Windows 临时文件"
    Write-Host "  -UpdateCache    清理 Windows Update 缓存"
    Write-Host "  -Thumbnails     清理缩略图缓存"
    Write-Host "  -Browsers       清理浏览器缓存"
    Write-Host "  -RecycleBin     清空回收站"
    Write-Host "  -Logs           清理日志文件"
    Write-Host ""
    Write-Host "提示: 建议先用 -DryRun 查看会清理什么，再决定是否执行" -ForegroundColor Green
    exit 0
}

# 运行 Python 脚本
try {
    & uv run $PythonScript @args
} catch {
    Write-Error "执行清理脚本时出错: $_"
    exit 1
}
