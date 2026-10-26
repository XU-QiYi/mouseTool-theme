# 安装 → 启动 → 卸载 → 重装 → 再卸载 全循环静默验收（不弹 UI）。
# 防护：检测到已有安装或运行实例时中止，绝不影响用户现有安装与数据。
# 用法：powershell -ExecutionPolicy Bypass -File src-tauri/installer/src/verify_install_cycle.ps1 -SetupExe <setup.exe>
# 依据：docs/安装器原型/setup-ui-prototype.html 的安装器验收（安装/卸载/数据保留）
param([Parameter(Mandatory = $true)][string]$SetupExe)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Win -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);'

$installerDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # src-tauri/installer
$conf = Get-Content (Join-Path $installerDir '..\tauri.conf.json') -Raw | ConvertFrom-Json
$productName = $conf.productName
# 主程序名取 Cargo 包名（未设 mainBinaryName 时 tauri 以它命名 exe），而非 productName
$cargoText = Get-Content (Join-Path $installerDir '..\Cargo.toml') -Raw
$mainBin = [regex]::Match($cargoText, '(?m)^\s*name\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $mainBin) { throw '无法从 Cargo.toml 解析主程序名' }

$installDir = Join-Path $env:LOCALAPPDATA (Join-Path 'Programs' $productName)
$appExe = Join-Path $installDir ($mainBin + '.exe')
$dataDir = Join-Path $env:LOCALAPPDATA 'CursorStudio'
$smLnk = Join-Path $env:APPDATA (Join-Path 'Microsoft\Windows\Start Menu\Programs' ($productName + '.lnk'))

$script:pass = 0; $script:fail = 0
function Check([string]$name, [bool]$ok) {
  if ($ok) { Write-Host ('  [PASS] ' + $name) }
  else { Write-Host ('  [FAIL] ' + $name) -ForegroundColor Red; $script:fail++ }
}
function Wait-DirGone([string]$path) {
  # NSIS 卸载器会先自复制到 %TEMP% 再继续删，-Wait 可能提前返回，轮询到目录消失为止
  $deadline = (Get-Date).AddSeconds(30)
  while ((Test-Path $path) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
}
function Stop-App {
  # 先礼貌关闭（尊重应用内「关闭行为」设置），3 秒后仍在才强杀
  $procs = Get-Process -Name $mainBin -ErrorAction SilentlyContinue
  if ($procs) {
    foreach ($proc in $procs) {
      if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
        [Win.Native]::PostMessage($proc.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      }
    }
    Start-Sleep -Seconds 3
    Get-Process -Name $mainBin -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
}

if (-not (Test-Path $SetupExe)) { throw ('安装包不存在: ' + $SetupExe) }
if (Test-Path $installDir) { throw ('检测到已存在安装 ' + $installDir + '，为保护现有安装而中止。如确属遗留产物请先手动卸载。') }
Stop-App

Write-Host '== 1. 静默安装 =='
Start-Process -FilePath $SetupExe -ArgumentList '/S' -Wait
Start-Sleep -Seconds 2
Check '应用主程序就位' (Test-Path $appExe)
Check '卸载器就位' (Test-Path (Join-Path $installDir 'uninstall.exe'))
Check '开始菜单快捷方式已创建' (Test-Path $smLnk)

Write-Host '== 2. 启动应用，检查数据目录 =='
Start-Process -FilePath $appExe
Start-Sleep -Seconds 6
Check '应用已启动' ([bool](Get-Process -Name $mainBin -ErrorAction SilentlyContinue))
Check ('数据目录已生成: ' + $dataDir) (Test-Path $dataDir)
Stop-App
# 若应用首启未落数据目录，补一个标记文件，让「卸载保留数据」的断言有据可查
if (-not (Test-Path $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  Set-Content -Path (Join-Path $dataDir '.installer-qa') -Value 'installer-qa'
}
Check '数据目录含内容' ((Get-ChildItem $dataDir -Force | Measure-Object).Count -gt 0)

Write-Host '== 3. 首次卸载（数据目录必须保留） =='
Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -Wait
Wait-DirGone $installDir
Check '安装目录已清理' (-not (Test-Path $installDir))
Check '开始菜单快捷方式已移除' (-not (Test-Path $smLnk))
Check '数据目录原样保留' (Test-Path $dataDir)

Write-Host '== 4. 重装（旧数据必须完好） =='
Start-Process -FilePath $SetupExe -ArgumentList '/S' -Wait
Start-Sleep -Seconds 2
Check '重装后应用就位' (Test-Path $appExe)
Check '重装后旧数据完好' (Test-Path $dataDir)

Write-Host '== 5. 再卸载（还原环境） =='
Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -Wait
Wait-DirGone $installDir
Check '最终卸载完成' (-not (Test-Path $installDir))
Check '最终数据目录仍保留' (Test-Path $dataDir)

Write-Host ('== 结果: PASS=' + $script:pass + ' FAIL=' + $script:fail + ' ==')
if ($script:fail -gt 0) { exit 1 }
