# 生成安装器整套 UI 位图（设计源：docs/安装器原型/setup-ui-prototype.html）。
# 用法：powershell -ExecutionPolicy Bypass -File src-tauri/installer/src/make_ui_assets.ps1
# 产物：src-tauri/installer/ui/*.bmp（1x + 2x，按钮/进度填充额外提供 125/150/175/200%）
# 预览：src-tauri/installer/src/ui-preview/*.png（不参与打包）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installerDir = Split-Path -Parent $here
$srcTauriDir = Split-Path -Parent $installerDir
$outDir = Join-Path $installerDir 'ui'
$previewDir = Join-Path $here 'ui-preview'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $previewDir | Out-Null

$conf = Get-Content (Join-Path $srcTauriDir 'tauri.conf.json') -Raw | ConvertFrom-Json
$version = $conf.version
$iconPath = Join-Path $srcTauriDir 'icons\128x128.png'
if (-not (Test-Path $iconPath)) { throw ('找不到应用图标: ' + $iconPath) }

function C([int]$r, [int]$g, [int]$b) { return [System.Drawing.Color]::FromArgb(255, $r, $g, $b) }
$brandDark = C 0x1f 0x21 0x28
$teal      = C 0x4c 0xc9 0xc0
$blue      = C 0x4a 0x6f 0xe3
$white     = C 0xff 0xff 0xff
$fg        = C 0x25 0x25 0x25
$muted     = C 0x73 0x73 0x73
$border    = C 0xeb 0xeb 0xeb
$mutedBg   = C 0xf5 0xf5 0xf5
$footerBg  = C 0xfa 0xfa 0xfa
$success   = C 0x3a 0x9e 0x6b
$sideText  = C 0xe8 0xea 0xf0
$verGray   = C 0x9a 0xa0 0xae
$stepGray  = C 0x8d 0x93 0xa3
$stepDone  = C 0xc9 0xcd 0xdb
$dotBorder = C 0x4a 0x4f 0x5d
$activePill = C 0x32 0x34 0x3a

function New-RoundPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single](2 * $r)
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc([single]($x + $w - $d), $y, $d, $d, 270, 90)
  $p.AddArc([single]($x + $w - $d), [single]($y + $h - $d), $d, $d, 0, 90)
  $p.AddArc($x, [single]($y + $h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Font([string]$family, [single]$px, [System.Drawing.FontStyle]$style) {
  return New-Object System.Drawing.Font $family, $px, $style, ([System.Drawing.GraphicsUnit]::Pixel)
}

function Draw-TextCenter([System.Drawing.Graphics]$g, [string]$text, [System.Drawing.Font]$font, [System.Drawing.Brush]$brush, [single]$x, [single]$y, [single]$w, [single]$h) {
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $g.DrawString($text, $font, $brush, (New-Object System.Drawing.RectangleF $x, $y, $w, $h), $sf)
  $sf.Dispose()
}

function New-Canvas([int]$w, [int]$h, [System.Drawing.Color]$bg) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear($bg)
  return @($bmp, $g)
}

function Save-Bmp24([System.Drawing.Bitmap]$bmp, [string]$path) {
  $rect = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
  $bmp24 = $bmp.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $bmp24.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp24.Dispose()
}

function Save-Pair([System.Drawing.Bitmap]$bmp2x, [string]$name, [int]$w, [int]$h) {
  Save-Bmp24 $bmp2x (Join-Path $outDir ($name + '@2x.bmp'))
  $bmp2x.Save((Join-Path $previewDir ($name + '@2x.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $small = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($small)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($bmp2x, (New-Object System.Drawing.Rectangle 0, 0, $w, $h))
  $g.Dispose()
  Save-Bmp24 $small (Join-Path $outDir ($name + '.bmp'))
  $small.Save((Join-Path $previewDir ($name + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()
}

function Draw-RoundedCard([System.Drawing.Graphics]$g, [single]$x, [single]$y, [single]$w, [single]$h, [single]$r, [single]$borderW, [System.Drawing.Color]$fill, [System.Drawing.Color]$borderColor) {
  $path = New-RoundPath $x $y $w $h $r
  $brush = New-Object System.Drawing.SolidBrush $fill
  $g.FillPath($brush, $path)
  $brush.Dispose()
  if ($borderW -gt 0) {
    $pen = New-Object System.Drawing.Pen $borderColor, $borderW
    $g.DrawPath($pen, $path)
    $pen.Dispose()
  }
  $path.Dispose()
}

# ---------------- 侧栏背景（深色 + 右下角品牌色块，软边） ----------------
$sw = 200; $sh = 448; $s2 = 2
$r = New-Canvas ($sw * $s2) ($sh * $s2) $brandDark
$sbBmp = $r[0]; $sbG = $r[1]
$tealBlend = C 0x4c 0xc9 0xc0
$blueBlend = C 0x4a 0x6f 0xe3
$layer = New-Object System.Drawing.Bitmap ($sw * $s2), ($sh * $s2), ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$lg = [System.Drawing.Graphics]::FromImage($layer)
$lg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$lg.Clear([System.Drawing.Color]::Transparent)
$blob = New-RoundPath ([single]-110) ([single]-110) 220 220 40
$m = New-Object System.Drawing.Drawing2D.Matrix
$m.RotateAt(18, (New-Object System.Drawing.PointF 0, 0))
$m.Translate(200 * $s2, 470 * $s2, [System.Drawing.Drawing2D.MatrixOrder]::Append)
$blob.Transform($m)
$bounds = $blob.GetBounds()
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bounds,
  ([System.Drawing.Color]::FromArgb(7, $tealBlend.R, $tealBlend.G, $tealBlend.B)),
  ([System.Drawing.Color]::FromArgb(7, $blueBlend.R, $blueBlend.G, $blueBlend.B)), ([single]45.0)
# 25 次轻微平移叠加：内部约 50% 不透明（对应原型 opacity .5），边缘约 2px 软过渡（替代 blur(2px)）
foreach ($dx in @(-4, -2, 0, 2, 4)) {
  foreach ($dy in @(-4, -2, 0, 2, 4)) {
    $fillPath = $blob.Clone()
    $tm = New-Object System.Drawing.Drawing2D.Matrix
    $tm.Translate($dx, $dy)
    $fillPath.Transform($tm)
    $lg.FillPath($brush, $fillPath)
    $tm.Dispose(); $fillPath.Dispose()
  }
}
$sbG.DrawImage($layer, 0, 0)
$brush.Dispose(); $blob.Dispose(); $m.Dispose(); $lg.Dispose(); $layer.Dispose(); $sbG.Dispose()
Save-Pair $sbBmp 'sidebar' $sw $sh
$sbBmp.Dispose()

# ---------------- 应用图标（44x44，深色底、圆角） ----------------
$r = New-Canvas 88 88 $brandDark
$logoBmp = $r[0]; $logoG = $r[1]
$logoClip = New-RoundPath 0 0 88 88 22
$logoG.SetClip($logoClip)
$icon = [System.Drawing.Image]::FromFile($iconPath)
$logoG.DrawImage($icon, (New-Object System.Drawing.Rectangle 0, 0, 88, 88))
$logoG.ResetClip()
$icon.Dispose(); $logoClip.Dispose(); $logoG.Dispose()
Save-Pair $logoBmp 'logo' 44 44
$logoBmp.Dispose()

# ---------------- 功能图标块（32x32） ----------------
$tiles = @(
  @{ name = 'tile1'; glyph = [string][char]0x2726 },
  @{ name = 'tile2'; glyph = [string][char]0x21BB },
  @{ name = 'tile3'; glyph = [string][char]0x2609 }
)
foreach ($t in $tiles) {
  $r = New-Canvas 64 64 $white
  $bmp = $r[0]; $g = $r[1]
  Draw-RoundedCard $g 0 0 64 64 16 2 $mutedBg $border
  if ($t.name -eq 'tile2') {
    $pen = New-Object System.Drawing.Pen $fg, 3
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($pen, 21, 21, 22, 22, 40, 290)
    $pen.Dispose()
    $brush = New-Object System.Drawing.SolidBrush $fg
    $pts = [System.Drawing.PointF[]]@(
      (New-Object System.Drawing.PointF 41.5, 26.5),
      (New-Object System.Drawing.PointF 32.5, 24.0),
      (New-Object System.Drawing.PointF 38.0, 34.0)
    )
    $g.FillPolygon($brush, $pts)
    $brush.Dispose()
  } else {
    $font = New-Font 'Segoe UI Symbol' 30 ([System.Drawing.FontStyle]::Regular)
    $brush = New-Object System.Drawing.SolidBrush $fg
    Draw-TextCenter $g $t.glyph $font $brush 0 0 64 64
    $brush.Dispose(); $font.Dispose()
  }
  $g.Dispose()
  Save-Pair $bmp $t.name 32 32
  $bmp.Dispose()
}

# ---------------- 步骤高亮胶囊 + 步骤圆点 ----------------
$r = New-Canvas 320 68 $brandDark
$pillBmp = $r[0]; $pillG = $r[1]
Draw-RoundedCard $pillG 0 0 320 68 16 0 $activePill $activePill
$pillG.Dispose()
Save-Pair $pillBmp 'pill' 160 34
$pillBmp.Dispose()

function Save-Dot([string]$name, [int]$number, [string]$state) {
  $r = New-Canvas 40 40 $brandDark
  $bmp = $r[0]; $g = $r[1]
  if ($state -eq 'active') {
    $g.Clear($activePill)
    $pen = New-Object System.Drawing.Pen $teal, 2
    $g.DrawEllipse($pen, 1, 1, 38, 38)
    $pen.Dispose()
    $font = New-Font 'Segoe UI' 22 ([System.Drawing.FontStyle]::Regular)
    $brush = New-Object System.Drawing.SolidBrush $sideText
    Draw-TextCenter $g ([string]$number) $font $brush 0 0 40 40
    $brush.Dispose(); $font.Dispose()
  } elseif ($state -eq 'todo') {
    $pen = New-Object System.Drawing.Pen $dotBorder, 2
    $g.DrawEllipse($pen, 1, 1, 38, 38)
    $pen.Dispose()
    $font = New-Font 'Segoe UI' 22 ([System.Drawing.FontStyle]::Regular)
    $brush = New-Object System.Drawing.SolidBrush $stepGray
    Draw-TextCenter $g ([string]$number) $font $brush 0 0 40 40
    $brush.Dispose(); $font.Dispose()
  } else {
    $brush = New-Object System.Drawing.SolidBrush $teal
    $g.FillEllipse($brush, 1, 1, 38, 38)
    $brush.Dispose()
    $pen = New-Object System.Drawing.Pen $brandDark, 4
    $g.DrawLine($pen, 20, 21, 26, 27)
    $g.DrawLine($pen, 26, 27, 34, 15)
    $pen.Dispose()
  }
  $g.Dispose()
  Save-Pair $bmp $name 20 20
  $bmp.Dispose()
}
1..4 | ForEach-Object { Save-Dot ('dot-active-' + $_) $_ 'active' }
1..4 | ForEach-Object { Save-Dot ('dot-todo-' + $_) $_ 'todo' }
Save-Dot 'dot-done' 0 'done'

# ---------------- 卡片 / 提示框 / 输入框 / 进度轨道 ----------------
function Save-ChromeCard([string]$name, [int]$w, [int]$h, [int]$rDesign, [System.Drawing.Color]$fill, [System.Drawing.Color]$borderColor, [int]$borderDesign, [System.Drawing.Color]$outside) {
  $r = New-Canvas ($w * 2) ($h * 2) $outside
  $bmp = $r[0]; $g = $r[1]
  Draw-RoundedCard $g 0 0 ($w * 2) ($h * 2) ($rDesign * 2) ($borderDesign * 2) $fill $borderColor
  $g.Dispose()
  Save-Pair $bmp $name $w $h
  $bmp.Dispose()
}
Save-ChromeCard 'card' 408 61 10 $white $border 1 $white
Save-ChromeCard 'card-tall' 408 72 10 $white $border 1 $white
Save-ChromeCard 'tip' 408 46 10 $mutedBg $mutedBg 0 $white
Save-ChromeCard 'input' 330 36 8 $white $border 1 $white
$focusRing = C 0x4a 0x6f 0xe3
Save-ChromeCard 'input-focus' 330 36 8 $white $focusRing 2 $white
Save-ChromeCard 'track' 408 8 4 $mutedBg $border 1 $white

function Save-FocusRing([string]$name, [string]$kind) {
  # 32x32：中间给 20x20 圆点留 6px，蓝环距圆点 2px（对应原型 outline-offset: 2px）
  $r = New-Canvas 64 64 $white
  $bmp = $r[0]; $g = $r[1]
  if ($kind -eq 'check') {
    Draw-RoundedCard $g 6 6 52 52 14 4 $white $focusRing
  } else {
    $brush = New-Object System.Drawing.SolidBrush $white
    $g.FillEllipse($brush, 0, 0, 64, 64)
    $brush.Dispose()
    $pen = New-Object System.Drawing.Pen $focusRing, 4
    $g.DrawEllipse($pen, 6, 6, 52, 52)
    $pen.Dispose()
  }
  $g.Dispose()
  Save-Pair $bmp $name 32 32
  $bmp.Dispose()
}
Save-FocusRing 'focus-ring-check' 'check'
Save-FocusRing 'focus-ring-radio' 'radio'

# ---------------- 完成徽章（4 帧弹入） ----------------
$r = New-Canvas 112 112 $white
$badgeBase = $r[0]; $badgeG = $r[1]
$badgeBrush = New-Object System.Drawing.SolidBrush $success
$badgeG.FillEllipse($badgeBrush, 0, 0, 112, 112)
$badgeBrush.Dispose()
$badgePen = New-Object System.Drawing.Pen $white, 6
$badgePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$badgePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$badgeG.DrawLine($badgePen, 30, 57, 47, 74)
$badgeG.DrawLine($badgePen, 47, 74, 82, 36)
$badgePen.Dispose(); $badgeG.Dispose()
$badgeScales = @(0.6, 0.75, 0.9, 1.0)
for ($i = 0; $i -lt $badgeScales.Count; $i++) {
  $scale = $badgeScales[$i]
  $d = [int]([Math]::Round(112 * $scale))
  $x = [int]((112 - $d) / 2)
  $r = New-Canvas 112 112 $white
  $bmp = $r[0]; $g = $r[1]
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($badgeBase, (New-Object System.Drawing.Rectangle $x, $x, $d, $d))
  $g.Dispose()
  Save-Pair $bmp ('badge-' + ($i + 1)) 56 56
  $bmp.Dispose()
}
$badgeBase.Dispose()

# ---------------- 安装日志状态圆点 ----------------
function Save-LogIcon([string]$name, [string]$state) {
  $r = New-Canvas 28 28 $white
  $bmp = $r[0]; $g = $r[1]
  if ($state -eq 'todo') {
    $pen = New-Object System.Drawing.Pen $border, 3
    $g.DrawEllipse($pen, 1, 1, 26, 26)
    $pen.Dispose()
  } elseif ($state -eq 'active') {
    $pen = New-Object System.Drawing.Pen $blue, 3
    $g.DrawArc($pen, 1, 1, 26, 26, 0, 300)
    $pen.Dispose()
  } else {
    $brush = New-Object System.Drawing.SolidBrush $success
    $g.FillEllipse($brush, 0, 0, 28, 28)
    $brush.Dispose()
    $pen = New-Object System.Drawing.Pen $white, 3
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($pen, 8, 14, 12, 18)
    $g.DrawLine($pen, 12, 18, 20, 9)
    $pen.Dispose()
  }
  $g.Dispose()
  Save-Pair $bmp $name 14 14
  $bmp.Dispose()
}
Save-LogIcon 'log-todo' 'todo'
Save-LogIcon 'log-done' 'done'

function Save-Spin([int]$idx) {
  $r = New-Canvas 28 28 $white
  $bmp = $r[0]; $g = $r[1]
  $track = New-Object System.Drawing.Pen $border, 3
  $g.DrawEllipse($track, 1, 1, 26, 26)
  $track.Dispose()
  $pen = New-Object System.Drawing.Pen $blue, 3
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($pen, 1, 1, 26, 26, ($idx * 45), 270)
  $pen.Dispose(); $g.Dispose()
  Save-Pair $bmp ('log-spin-' + ($idx + 1)) 14 14
  $bmp.Dispose()
}
0..7 | ForEach-Object { Save-Spin $_ }

# ---------------- 复选框/单选框（深色强调色，20x20 画布内 16x16 字形） ----------------
$controlBorder = C 0x9a 0x9a 0x9a
function Save-ControlDot([string]$name, [string]$kind, [bool]$on) {
  $r = New-Canvas 40 40 $white
  $bmp = $r[0]; $g = $r[1]
  if ($kind -eq 'check') {
    $path = New-RoundPath 1 5 30 30 6
    if ($on) {
      $brush = New-Object System.Drawing.SolidBrush $brandDark
      $g.FillPath($brush, $path); $brush.Dispose()
      $pen = New-Object System.Drawing.Pen $white, 3
      $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $g.DrawLine($pen, 8, 20, 14, 26)
      $g.DrawLine($pen, 14, 26, 26, 12)
      $pen.Dispose()
    } else {
      $brush = New-Object System.Drawing.SolidBrush $white
      $g.FillPath($brush, $path); $brush.Dispose()
      $pen = New-Object System.Drawing.Pen $controlBorder, 2
      $g.DrawPath($pen, $path); $pen.Dispose()
    }
    $path.Dispose()
  } else {
    if ($on) {
      $brush = New-Object System.Drawing.SolidBrush $brandDark
      $g.FillEllipse($brush, 1, 5, 30, 30); $brush.Dispose()
      $brush = New-Object System.Drawing.SolidBrush $white
      $g.FillEllipse($brush, 10, 14, 12, 12); $brush.Dispose()
    } else {
      $brush = New-Object System.Drawing.SolidBrush $white
      $g.FillEllipse($brush, 1, 5, 30, 30); $brush.Dispose()
      $pen = New-Object System.Drawing.Pen $controlBorder, 2
      $g.DrawEllipse($pen, 2, 6, 28, 28); $pen.Dispose()
    }
  }
  $g.Dispose()
  Save-Pair $bmp $name 20 20
  $bmp.Dispose()
}
Save-ControlDot 'check-off' 'check' $false
Save-ControlDot 'check-on' 'check' $true
Save-ControlDot 'radio-off' 'radio' $false
Save-ControlDot 'radio-on' 'radio' $true

# ---------------- 按钮（按 DPI 精确出图） ----------------
$btnScales = @(100, 125, 150, 175, 200)
function Save-Button([string]$name, [int]$w, [int]$h, [string]$kind, [string]$text, [string]$outsideKind, [int]$pct) {
  $s = $pct / 100.0
  $bw = [int]([Math]::Round($w * $s))
  $bh = [int]([Math]::Round($h * $s))
  $outside = if ($outsideKind -eq 'footer') { $footerBg } else { $white }
  $r = New-Canvas $bw $bh $outside
  $bmp = $r[0]; $g = $r[1]
  $radius = [single](8 * $s)
  if ($kind -eq 'primary') {
    Draw-RoundedCard $g 0 0 $bw $bh $radius 0 $brandDark $brandDark
    $textColor = $white
  } elseif ($kind -eq 'disabled') {
    $disabledFill = C 0xbd 0xbd 0xc0
    Draw-RoundedCard $g 0 0 $bw $bh $radius 0 $disabledFill $disabledFill
    $textColor = C 0xf7 0xf7 0xf7
  } else {
    Draw-RoundedCard $g 0 0 $bw $bh $radius ([single](1 * $s)) $white $border
    $textColor = $brandDark
  }
  $font = New-Font 'Microsoft YaHei UI' ([single](14 * $s)) ([System.Drawing.FontStyle]::Regular)
  $brush = New-Object System.Drawing.SolidBrush $textColor
  Draw-TextCenter $g $text $font $brush 0 0 $bw $bh
  $brush.Dispose(); $font.Dispose(); $g.Dispose()
  Save-Bmp24 $bmp (Join-Path $outDir ($name + '@' + $pct + '.bmp'))
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.Dispose()
  $bmp.Save((Join-Path $previewDir ($name + '@' + $pct + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
$btns = @(
  @{ name = 'btn-next'; w = 96; h = 36; kind = 'primary'; text = '下一步'; outside = 'footer' },
  @{ name = 'btn-install'; w = 96; h = 36; kind = 'primary'; text = '安装'; outside = 'footer' },
  @{ name = 'btn-finish'; w = 96; h = 36; kind = 'primary'; text = '完成'; outside = 'footer' },
  @{ name = 'btn-back'; w = 80; h = 36; kind = 'secondary'; text = '上一步'; outside = 'footer' },
  @{ name = 'btn-installing'; w = 96; h = 36; kind = 'disabled'; text = '安装中…'; outside = 'footer' },
  @{ name = 'btn-browse'; w = 70; h = 36; kind = 'secondary'; text = '浏览…'; outside = 'white' }
)
foreach ($pct in $btnScales) {
  foreach ($b in $btns) {
    Save-Button $b.name $b.w $b.h $b.kind $b.text $b.outside $pct
  }
}

# ---------------- 进度条填充（渐变，按 DPI 精确出图） ----------------
foreach ($pct in $btnScales) {
  $s = $pct / 100.0
  $fw = [int]([Math]::Round(406 * $s))
  $fh = [int]([Math]::Round(6 * $s))
  $r = New-Canvas $fw $fh $mutedBg
  $bmp = $r[0]; $g = $r[1]
  $clip = New-RoundPath 0 0 $fw $fh ([single](3 * $s))
  $g.SetClip($clip)
  for ($x = 0; $x -lt $fw; $x++) {
    $t = if ($fw -le 1) { 0.0 } else { $x / ($fw - 1.0) }
    $rr = [int]([Math]::Round($teal.R * (1 - $t) + $blue.R * $t))
    $gg = [int]([Math]::Round($teal.G * (1 - $t) + $blue.G * $t))
    $bb = [int]([Math]::Round($teal.B * (1 - $t) + $blue.B * $t))
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, $rr, $gg, $bb)), 1
    $g.DrawLine($pen, $x, 0, $x, $fh)
    $pen.Dispose()
  }
  $g.ResetClip(); $clip.Dispose(); $g.Dispose()
  Save-Bmp24 $bmp (Join-Path $outDir ('fill@' + $pct + '.bmp'))
  $bmp.Save((Join-Path $previewDir ('fill@' + $pct + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Write-Host ("UI 资源已生成：{0}" -f $outDir)
Write-Host ("预览：{0}" -f $previewDir)
