# 启动安装器并截取其窗口（QA 用，只截屏不安装，退出即杀进程）。
# 用法：powershell -ExecutionPolicy Bypass -File src-tauri/installer/src/capture_setup_window.ps1 -ExePath <setup.exe> -OutPng <shot.png>
#       加 -ClickNext 先点击「下一步」再截图（用于许可/路径页），BM_CLICK 不依赖键盘焦点。
# 依据：docs/安装器原型/setup-ui-prototype.html 的安装器界面验收
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$OutPng,
  [int]$WaitMs = 4000,
  [switch]$ClickNext
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SetupNative {
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
# 摆脱系统 DPI 虚拟化，截到物理像素
[SetupNative]::SetProcessDPIAware() | Out-Null

$p = Start-Process -FilePath $ExePath -PassThru
try {
  Start-Sleep -Milliseconds $WaitMs
  $p.Refresh()
  $h = $p.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { throw '未找到安装器主窗口' }

  if ($ClickNext) {
    # 枚举按钮子窗口找「下一步」，BM_CLICK(0x00F5) 直接点击
    $script:nextBtn = [IntPtr]::Zero
    $cb = [SetupNative+EnumChildProc]{ param($child, $l)
      $sb = New-Object System.Text.StringBuilder 256
      [SetupNative]::GetWindowTextW($child, $sb, 256) | Out-Null
      $cn = New-Object System.Text.StringBuilder 32
      [SetupNative]::GetClassNameW($child, $cn, 32) | Out-Null
      if ($cn.ToString() -eq 'Button' -and $sb.ToString() -like '*下一步*') { $script:nextBtn = $child; return $false }
      return $true
    }
    [SetupNative]::EnumChildWindows($h, $cb, [IntPtr]::Zero) | Out-Null
    if ($script:nextBtn -eq [IntPtr]::Zero) { throw '未找到下一步按钮' }
    [SetupNative]::SendMessageW($script:nextBtn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 1500
  }

  [SetupNative]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
  Start-Sleep -Milliseconds 250
  $r = New-Object SetupNative+RECT
  [SetupNative]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -le 0 -or $ht -le 0) { throw '窗口尺寸异常' }
  # PrintWindow 对自绘位图页会丢 alpha（截出黑块），这里置顶后拷贝屏幕并用 24bpp
  $bmp = New-Object System.Drawing.Bitmap $w, $ht, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "已保存 $OutPng (${w}x${ht})"
} finally {
  try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
}
