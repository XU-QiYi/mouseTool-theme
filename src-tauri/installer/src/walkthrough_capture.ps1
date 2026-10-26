# QA：走完整安装交互流并逐页截图（真实安装，结尾还原为已安装状态）。
# 用法：powershell -ExecutionPolicy Bypass -File src-tauri/installer/src/walkthrough_capture.ps1 -OutDir <目录>
# 依据：docs/安装器原型/setup-ui-prototype.html 的四页结构验收
param([Parameter(Mandatory = $true)][string]$OutDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class Cap3 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern IntPtr PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  public struct R { public int L, T, Rt, B; }
}
"@
[Cap3]::SetProcessDPIAware() | Out-Null

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$setup = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))) 'target\release\bundle\nsis\鼠标主题工具_0.1.0_x64-setup.exe'

$p = Start-Process -FilePath $setup -PassThru
function Shot([string]$name) {
  $p.Refresh()
  $h = $p.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { Write-Host ($name + ': 无窗口'); return }
  $r = New-Object Cap3+R; [Cap3]::GetWindowRect($h, [ref]$r) | Out-Null
  $bmp = New-Object System.Drawing.Bitmap ($r.Rt - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc(); [Cap3]::PrintWindow($h, $hdc, 2) | Out-Null; $g.ReleaseHdc($hdc); $g.Dispose()
  $path = Join-Path $OutDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Host ('已存 ' + $path)
}
function ClickBtn([string]$match) {
  $p.Refresh()
  $script:hit = [IntPtr]::Zero
  $cb = [Cap3+EnumProc]{ param($ch, $l)
    $tx = New-Object System.Text.StringBuilder 128; [Cap3]::GetWindowTextW($ch, $tx, 128) | Out-Null
    if ($tx.ToString() -like ('*' + $match + '*')) { $script:hit = $ch; return $false }
    return $true }
  [Cap3]::EnumChildWindows($p.MainWindowHandle, $cb, [IntPtr]::Zero) | Out-Null
  # 用 PostMessage 异步投递 BM_CLICK：SendMessage 会在 NSIS 同步切页/跑页面循环期间一直阻塞
  if ($script:hit -ne [IntPtr]::Zero) { [Cap3]::PostMessageW($script:hit, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; Write-Host ('点击: ' + $match) } else { Write-Host ('未找到按钮: ' + $match) }
}

Start-Sleep -Seconds 4
Shot 'p1-welcome.png'
ClickBtn '下一步'; Start-Sleep -Seconds 2.5
Shot 'p2-reinstall.png'
ClickBtn '下一步'; Start-Sleep -Seconds 2
Shot 'p3-options.png'
ClickBtn '下一步'; Start-Sleep -Milliseconds 700
Shot 'p4-instfiles.png'
Start-Sleep -Seconds 4
Shot 'p5-instfiles-done.png'
ClickBtn '下一步'; Start-Sleep -Seconds 1.5
Shot 'p6-finish.png'
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Write-Host '走查完成'
