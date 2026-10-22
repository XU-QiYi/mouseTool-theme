"""生成应用图标：设计母版 → 打包成品。

跑法（需要 Pillow）：
    python assets/icon/build_assets.py

产出分两处：
    src-tauri/icons/   Tauri 打包真正吃的文件（PNG / ICO / ICNS / 商店方块图）
    public/            前端 favicon

设计源（矢量 icon.svg、说明、prompt）留在 assets/icon/，不参与打包。
改色或调比例：改下面的 PALETTE / CURSOR / 几何参数后重跑本脚本即可。
"""

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
TAURI_ICONS = ROOT.parents[1] / "src-tauri" / "icons"
PUBLIC = ROOT.parents[1] / "public"

SCALE = 4
N = 1024
PALETTE = {"graphite": "#202329", "white": "#F6F8FC", "cyan": "#47C5DC", "blue": "#527DE8"}
CURSOR = [(212, 170), (717, 407), (506, 471), (611, 711), (498, 760), (394, 522), (228, 685)]

# 白色指针指向左上（有凹口 + 右下尾柄），形状取自系统标准箭头方向
GEOMETRY = {
    "tile": ((0, 0, 1024, 1024), 208),          # 石墨底板，圆角外透明
    "card_back": ((426, 182, 825, 659), 72),    # 钴蓝卡片（右上错位）
    "card_front": ((362, 261, 761, 737), 72),   # 青色卡片（左下错位）
}


def draw_canvas():
    """在 4 倍画布上作图，再降采样——小尺寸边缘才不会有锯齿。"""
    canvas = Image.new("RGBA", (N * SCALE, N * SCALE))

    def rounded(box, radius, fill, shadow=False):
        layer = Image.new("RGBA", canvas.size)
        ImageDraw.Draw(layer).rounded_rectangle(
            tuple(round(v * SCALE) for v in box), radius=radius * SCALE, fill=fill
        )
        if shadow:
            shade = Image.new("RGBA", canvas.size)
            mask = layer.getchannel("A").filter(ImageFilter.GaussianBlur(12 * SCALE))
            shade.putalpha(mask.point(lambda x: round(x * 0.20)))
            canvas.alpha_composite(shade, (0, 10 * SCALE))
        canvas.alpha_composite(layer)

    rounded(*GEOMETRY["tile"], fill=PALETTE["graphite"])
    rounded(*GEOMETRY["card_back"], fill=PALETTE["blue"], shadow=True)
    rounded(*GEOMETRY["card_front"], fill=PALETTE["cyan"], shadow=True)

    cursor = Image.new("RGBA", canvas.size)
    ImageDraw.Draw(cursor).polygon(
        [(x * SCALE, y * SCALE) for x, y in CURSOR], fill=PALETTE["white"]
    )
    shade = Image.new("RGBA", canvas.size)
    shade.putalpha(
        cursor.getchannel("A")
        .filter(ImageFilter.GaussianBlur(10 * SCALE))
        .point(lambda x: round(x * 0.30))
    )
    canvas.alpha_composite(shade, (0, 9 * SCALE))
    canvas.alpha_composite(cursor)
    return canvas


def write_svg():
    points = " ".join(f"{x},{y}" for x, y in CURSOR)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>鼠标主题工具 — 主题叠片</title>
  <desc>原创几何图标：石墨色圆角底、蓝色与青色主题卡片、白色鼠标指针。</desc>
  <defs>
    <filter id="card-shadow" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000000" flood-opacity=".20"/></filter>
    <filter id="pointer-shadow" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="9" stdDeviation="10" flood-color="#000000" flood-opacity=".30"/></filter>
  </defs>
  <rect width="1024" height="1024" rx="208" fill="{PALETTE['graphite']}"/>
  <rect x="426" y="182" width="399" height="477" rx="72" fill="{PALETTE['blue']}" filter="url(#card-shadow)"/>
  <rect x="362" y="261" width="399" height="476" rx="72" fill="{PALETTE['cyan']}" filter="url(#card-shadow)"/>
  <polygon points="{points}" fill="{PALETTE['white']}" filter="url(#pointer-shadow)"/>
</svg>
'''
    (ROOT / "icon.svg").write_text(svg, encoding="utf-8")


def write_icns(icon):
    """ICNS 容器：'icns' + 总长 + 若干 [类型4B + 块长(含头8B) + PNG数据]。

    PNG 直接内嵌是合法的（ic07/08/09/10 分别对应 128/256/512/1024）。
    Pillow 不支持写 ICNS，只能手搓字节。
    """
    blocks = [(b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024)]
    body = b""
    for typ, size in blocks:
        bio = io.BytesIO()
        icon.resize((size, size), Image.Resampling.LANCZOS).save(bio, format="PNG")
        data = bio.getvalue()
        body += typ + struct.pack(">I", len(data) + 8) + data
    (TAURI_ICONS / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def write_preview(icon):
    """评审图：浅/深底 + 原生尺寸缩略图 + 配色。不是交付物，只是给人看的。"""
    board = Image.new("RGB", (1400, 850), "#ECEEF1")
    d = ImageDraw.Draw(board)
    font_path = Path("C:/Windows/Fonts/segoeui.ttf")

    def font(size):
        return (
            ImageFont.truetype(str(font_path), size)
            if font_path.exists()
            else ImageFont.load_default()
        )

    d.text((64, 42), "CURSOR THEME MANAGER", fill="#202329", font=font(26))
    d.text((64, 88), "Layered themes / Original vector proposal", fill="#656C77", font=font(19))
    big = icon.resize((440, 440), Image.Resampling.LANCZOS)
    board.paste(big, (64, 160), big)

    for box, color, title, fg in [
        ((570, 160, 1336, 370), "#FFFFFF", "LIGHT SURFACE", "#656C77"),
        ((570, 400, 1336, 610), "#16181D", "DARK SURFACE", "#A4ABB7"),
    ]:
        d.rounded_rectangle(box, radius=22, fill=color)
        d.text((box[0] + 26, box[1] + 20), title, fill=fg, font=font(15))
        xpos = box[0] + 36
        for size in [64, 48, 32, 24, 20, 16]:
            thumb = icon.resize((size, size), Image.Resampling.LANCZOS)
            board.paste(thumb, (xpos, box[1] + 85 + (64 - size) // 2), thumb)
            d.text((xpos, box[1] + 165), str(size), fill=fg, font=font(14))
            xpos += 118

    d.text((64, 664), "PALETTE", fill="#656C77", font=font(15))
    for i, (name, value) in enumerate(PALETTE.items()):
        x = 64 + i * 318
        d.rounded_rectangle((x, 710, x + 54, 764), radius=12, fill=value, outline="#D5D9DF")
        d.text((x + 72, 708), name.upper(), fill="#656C77", font=font(14))
        d.text((x + 72, 737), value, fill="#202329", font=font(18))
    board.save(ROOT / "preview.png")


def main():
    TAURI_ICONS.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)

    canvas = draw_canvas()

    # 设计母版：留在 assets/，不参与打包
    canvas.resize((2048, 2048), Image.Resampling.LANCZOS).save(ROOT / "icon-master-2048.png")
    write_svg()

    icon = canvas.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon.save(ROOT / "icon-1024.png")

    # 打包成品：Tauri 的 bundle.icon 列了哪些就出哪些
    for filename, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
        icon.resize((size, size), Image.Resampling.LANCZOS).save(TAURI_ICONS / filename)
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(TAURI_ICONS / "icon.png")
    icon.save(
        TAURI_ICONS / "icon.ico",
        sizes=[(s, s) for s in [16, 20, 24, 32, 40, 48, 64, 128, 256]],
    )
    write_icns(icon)

    # Windows 商店方块图标：MSIX 资源，命名沿用 Tauri 模板
    for name, size in [
        ("Square30x30Logo.png", 30), ("Square44x44Logo.png", 44), ("Square71x71Logo.png", 71),
        ("Square89x89Logo.png", 89), ("Square107x107Logo.png", 107), ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150), ("Square284x284Logo.png", 284), ("Square310x310Logo.png", 310),
        ("StoreLogo.png", 50),
    ]:
        icon.resize((size, size), Image.Resampling.LANCZOS).save(TAURI_ICONS / name)

    # 前端 favicon
    (PUBLIC / "favicon.svg").write_text(
        (ROOT / "icon.svg").read_text(encoding="utf-8"), encoding="utf-8"
    )
    icon.resize((32, 32), Image.Resampling.LANCZOS).save(PUBLIC / "favicon-32.png")
    icon.resize((128, 128), Image.Resampling.LANCZOS).save(PUBLIC / "favicon-128.png")

    write_preview(icon)
    print(f"设计母版 → {ROOT}")
    print(f"打包成品 → {TAURI_ICONS}")
    print(f"favicon  → {PUBLIC}")


if __name__ == "__main__":
    main()
