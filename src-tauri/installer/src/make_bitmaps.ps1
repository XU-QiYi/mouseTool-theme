# 生成安装器品牌位图：4 张步骤态侧栏（164x314，24 位 BMP，供自定义 NSIS 模板逐页切换）。
# 设计源：docs/安装器原型/setup-ui-prototype.html（最终版原型）。
# 流程：先按 2x 尺寸绘制设计稿 PNG（源稿入库），再高质量缩到 1x 导出 BMP。
# 用法：powershell -ExecutionPolicy Bypass -File src-tauri/installer/src/make_bitmaps.ps1
# 步骤态语义（对应原型侧栏 steps 的 active/done）：
#   sidebar-1 欢迎: 1 高亮          sidebar-2 选项: 1 完成、2 高亮
#   sidebar-3 安装: 1-2 完成、3 高亮  sidebar-4 完成: 1-3 完成、4 高亮
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path           # src-tauri/installer/src
$installerDir = Split-Path -Parent $here                          # src-tauri/installer
$srcTauriDir = Split-Path -Parent $installerDir                   # src-tauri

# 版本号取自 tauri.conf.json，保证位图与发布版本一致
$conf = Get-Content (Join-Path $srcTauriDir 'tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version

# 设计 token（新原型 :root）
$brandDark  = [System.Drawing.Color]::FromArgb(255, 0x1f, 0x21, 0x28)
$teal       = [System.Drawing.Color]::FromArgb(255, 0x4c, 0xc9, 0xc0)
$blue       = [System.Drawing.Color]::FromArgb(255, 0x4a, 0x6f, 0xe3)
$sideText   = [System.Drawing.Color]::FromArgb(255, 0xe8, 0xea, 0xf0)
$verGray    = [System.Drawing.Color]::FromArgb(255, 0x9a, 0xa0, 0xae)
$stepGray   = [System.Drawing.Color]::FromArgb(255, 0x8d, 0x93, 0xa3)
$stepDone   = [System.Drawing.Color]::FromArgb(255, 0xc9, 0xcd, 0xdb)
$dotBorder  = [System.Drawing.Color]::FromArgb(255, 0x4a, 0x4f, 0x5d)
$activePill = [System.Drawing.Color]::FromArgb(20, 255, 255, 255)   # oklch(1 0 0 / .08)

function New-RoundedRectPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, ([single](2 * $r)), ([single](2 * $r)), ([single]180), ([single]90))
  $p.AddArc(([single]($x + $w - 2 * $r)), $y, ([single](2 * $r)), ([single](2 * $r)), ([single]270), ([single]90))
  $p.AddArc(([single]($x + $w - 2 * $r)), ([single]($y + $h - 2 * $r)), ([single](2 * $r)), ([single](2 * $r)), ([single]0), ([single]90))
  $p.AddArc($x, ([single]($y + $h - 2 * $r)), ([single](2 * $r)), ([single](2 * $r)), ([single]90), ([single]90))
  $p.CloseFigure()
  return $p
}

function Draw-AccentBlob([System.Drawing.Graphics]$g, [single]$cx, [single]$cy, [single]$size, [single]$rotDeg) {
  # 原型 .side::before：rotate(18deg) 圆角色块，linear-gradient(135deg, teal, blue)，opacity .5
  $path = New-RoundedRectPath ([single](-$size / 2)) ([single](-$size / 2)) $size $size ([single]($size * 0.18))
  $m = New-Object System.Drawing.Drawing2D.Matrix
  $m.RotateAt($rotDeg, (New-Object System.Drawing.PointF ([single]0), ([single]0)))
  $m.Translate($cx, $cy, [System.Drawing.Drawing2D.MatrixOrder]::Append)
  $path.Transform($m)
  $bounds = $path.GetBounds()
  $tealA = [System.Drawing.Color]::FromArgb(128, $teal.R, $teal.G, $teal.B)
  $blueA = [System.Drawing.Color]::FromArgb(128, $blue.R, $blue.G, $blue.B)
  $lg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bounds, $tealA, $blueA, ([single]45.0)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.FillPath($lg, $path)
  $lg.Dispose(); $path.Dispose(); $m.Dispose()
}

function Draw-AppIcon([System.Drawing.Graphics]$g, [string]$iconPath, [single]$x, [single]$y, [single]$size) {
  # 原型 .logo：完整应用图标 + 圆角（44px 时半径 11，即 25%）
  $icon = [System.Drawing.Image]::FromFile($iconPath)
  $clip = New-RoundedRectPath $x $y $size $size ([single]($size * 0.25))
  $g.SetClip($clip)
  $g.DrawImage($icon, (New-Object System.Drawing.RectangleF $x, $y, $size, $size))
  $g.ResetClip()
  $clip.Dispose(); $icon.Dispose()
}

function Draw-Text([System.Drawing.Graphics]$g, [string]$text, [System.Drawing.Font]$font,
  [System.Drawing.Brush]$brush, [single]$x, [single]$y, [single]$w, [single]$h) {
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Near
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Near
  $g.DrawString($text, $font, $brush, (New-Object System.Drawing.RectangleF $x, $y, $w, $h), $sf)
  $sf.Dispose()
}

function New-Font([string]$family, [single]$px, [System.Drawing.FontStyle]$style) {
  return New-Object System.Drawing.Font $family, $px, $style, ([System.Drawing.GraphicsUnit]::Pixel)
}

function Save-Set([System.Drawing.Bitmap]$design2x, [string]$name, [int]$w, [int]$h) {
  # 2x 设计稿 PNG（源稿入库）
  $design2x.Save((Join-Path $script:here ($name + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  # 1x 缩放（双三次高质量）
  $small = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($small)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($design2x, (New-Object System.Drawing.Rectangle 0, 0, $w, $h))
  $g.Dispose()
  # 1x 预览 PNG（与 BMP 同内容，便于快速核对，不入安装产物）
  $small.Save((Join-Path $script:here ($name + '.1x.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  # MUI2 要求 24 位 BMP：GDI+ 位图默认 32 位，必须显式克隆为 24bpp 再保存
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $bmp24 = $small.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $bmp24.Save((Join-Path $script:installerDir ($name + '.bmp')), [System.Drawing.Imaging.ImageFormat]::Bmp)
  Write-Host ("OK {0}.bmp  {1}x{2}  {3}" -f $name, $bmp24.Width, $bmp24.Height, $bmp24.PixelFormat)
  $bmp24.Dispose(); $small.Dispose()
}

$iconPath = Join-Path $srcTauriDir 'icons\128x128.png'
if (-not (Test-Path $iconPath)) { throw ('找不到应用图标: ' + $iconPath) }

$stepNames = @('欢迎', '安装选项', '正在安装', '完成')

foreach ($variant in 1..4) {
  # ---------- 侧栏 164x314（2x: 328x628），第 $variant 步为 active ----------
  $sb = New-Object System.Drawing.Bitmap 328, 628
  $g = [System.Drawing.Graphics]::FromImage($sb)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $bg = New-Object System.Drawing.SolidBrush $brandDark
  $g.FillRectangle($bg, 0, 0, 328, 628)
  Draw-AccentBlob $g ([single]295) ([single]555) ([single]340) ([single]18)   # 右下角露头的渐变色块
  Draw-AppIcon $g $iconPath ([single]32) ([single]40) ([single]64)

  $fTitle = New-Font 'Segoe UI Semibold' ([single]30) ([System.Drawing.FontStyle]::Regular)
  $brSide = New-Object System.Drawing.SolidBrush $sideText
  Draw-Text $g 'Mouse Theme' $fTitle $brSide ([single]32) ([single]128) ([single]264) ([single]42)
  $fVer = New-Font 'Microsoft YaHei' ([single]24) ([System.Drawing.FontStyle]::Regular)
  $brVer = New-Object System.Drawing.SolidBrush $verGray
  Draw-Text $g ('版本 ' + $version) $fVer $brVer ([single]33) ([single]172) ([single]264) ([single]32)

  $fStep = New-Font 'Microsoft YaHei' ([single]26) ([System.Drawing.FontStyle]::Regular)
  $fDot = New-Font 'Segoe UI' ([single]22) ([System.Drawing.FontStyle]::Regular)
  $penDot = New-Object System.Drawing.Pen $dotBorder, ([single]2.0)
  $penCheck = New-Object System.Drawing.Pen $brandDark, ([single]3.2)
  $sfC = New-Object System.Drawing.StringFormat
  $sfC.Alignment = [System.Drawing.StringAlignment]::Center
  $sfC.LineAlignment = [System.Drawing.StringAlignment]::Center
  $stepY = 226
  for ($i = 0; $i -lt 4; $i++) {
    $stepIndex = $i + 1
    $dotRect = New-Object System.Drawing.RectangleF ([single]36), ([single]$stepY), ([single]36), ([single]36)
    $pillRect = New-Object System.Drawing.RectangleF ([single]28), ([single]($stepY - 14)), ([single]272), ([single]64)
    if ($stepIndex -eq $variant) {
      # active：白字 + 白 8% 胶囊底 + 青蓝描边圆点
      $brPill = New-Object System.Drawing.SolidBrush $activePill
      $pill = New-RoundedRectPath ([single]($pillRect.X)) ([single]($pillRect.Y)) ([single]($pillRect.Width)) ([single]($pillRect.Height)) ([single]16)
      $g.FillPath($brPill, $pill)
      $brPill.Dispose(); $pill.Dispose()
      $brWhite = New-Object System.Drawing.SolidBrush $sideText
      $penTeal = New-Object System.Drawing.Pen $teal, ([single]2.0)
      $g.DrawEllipse($penTeal, $dotRect)
      $g.DrawString([string]$stepIndex, $fDot, $brWhite, $dotRect, $sfC)
      $brText = New-Object System.Drawing.SolidBrush $sideText
      Draw-Text $g $stepNames[$i] $fStep $brText ([single]90) ([single]($stepY + 3)) ([single]200) ([single]34)
      $brWhite.Dispose(); $penTeal.Dispose(); $brText.Dispose()
    } elseif ($stepIndex -lt $variant) {
      # done：青蓝实心圆点 + 深色对勾 + 浅灰字
      $brTeal = New-Object System.Drawing.SolidBrush $teal
      $g.FillEllipse($brTeal, $dotRect)
      $brTeal.Dispose()
      $cx1 = [single]($dotRect.X + 10); $cy1 = [single]($dotRect.Y + 19)
      $cx2 = [single]($dotRect.X + 16); $cy2 = [single]($dotRect.Y + 25)
      $cx3 = [single]($dotRect.X + 26); $cy3 = [single]($dotRect.Y + 11)
      $g.DrawLine($penCheck, $cx1, $cy1, $cx2, $cy2)
      $g.DrawLine($penCheck, $cx2, $cy2, $cx3, $cy3)
      $brDone = New-Object System.Drawing.SolidBrush $stepDone
      Draw-Text $g $stepNames[$i] $fStep $brDone ([single]90) ([single]($stepY + 3)) ([single]200) ([single]34)
      $brDone.Dispose()
    } else {
      # 未到：中性灰
      $g.DrawEllipse($penDot, $dotRect)
      $brStep = New-Object System.Drawing.SolidBrush $stepGray
      $g.DrawString([string]$stepIndex, $fDot, $brStep, $dotRect, $sfC)
      Draw-Text $g $stepNames[$i] $fStep $brStep ([single]90) ([single]($stepY + 3)) ([single]200) ([single]34)
      $brStep.Dispose()
    }
    $stepY += 64
  }
  $g.Dispose()
  Save-Set $sb ('sidebar-' + $variant) 164 314
  $sb.Dispose(); $bg.Dispose(); $brSide.Dispose(); $brVer.Dispose()
  $fTitle.Dispose(); $fVer.Dispose(); $fStep.Dispose(); $fDot.Dispose()
  $penDot.Dispose(); $penCheck.Dispose(); $sfC.Dispose()
}

Write-Host '完成。设计源稿在 installer/src/sidebar-*.png，成品在 installer/sidebar-*.bmp'
