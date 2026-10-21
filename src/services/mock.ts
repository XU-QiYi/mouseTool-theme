import type { CursorSlot, CursorTheme } from "@/types/theme";

/** 浏览器预览用示例数据，仅在非 Tauri 环境生效，打包后不会走到这里 */

type Row = [registry_key: string, display_name: string, english_name: string, file: string];

function makeCursors(rows: Row[], dir: string, fileType: string): CursorSlot[] {
  return rows.map(([registry_key, display_name, english_name, file]) => ({
    registry_key,
    display_name,
    english_name,
    file_path: `${dir}\\${file}`,
    file_type: fileType,
  }));
}

const WINDOWS_CURSORS = "C:\\Windows\\Cursors\\荧1.0";

export const MOCK_THEMES: CursorTheme[] = [
  {
    id: "sys_firefly",
    name: "firefly",
    description: "",
    created_at: "",
    updated_at: "",
    is_built_in: true,
    cursors: makeCursors(
      [
        ["Arrow", "正常选择", "Normal Select", "arrow.ani"],
        ["AppStarting", "后台运行", "Working in Background", "working.ani"],
        ["Wait", "忙", "Busy", "busy.ani"],
        ["Crosshair", "精确选择", "Precision Select", "cross.ani"],
        ["IBeam", "文本选择", "Text Select", "beam.ani"],
        ["No", "不可用", "Unavailable", "no.ani"],
        ["SizeNS", "垂直调整大小", "Vertical Resize", "ns.ani"],
        ["SizeWE", "水平调整大小", "Horizontal Resize", "we.ani"],
        ["SizeNWSE", "对角线调整 1", "Diagonal Resize 1", "nwse.ani"],
        ["SizeNESW", "对角线调整 2", "Diagonal Resize 2", "nesw.ani"],
        ["SizeAll", "移动", "Move", "move.ani"],
        ["Hand", "链接选择", "Link Select", "link.ani"],
      ],
      WINDOWS_CURSORS,
      "ani",
    ),
  },
  {
    // 已导入主题：槽位通常不全，删除流程也靠它验证
    id: "9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11",
    name: "Neon Night",
    description: "导入自 neon-night.zip",
    created_at: "2026-10-18 21:40",
    updated_at: "2026-10-18 21:40",
    is_built_in: false,
    cursors: makeCursors(
      [
        ["Arrow", "正常选择", "Normal Select", "arrow.cur"],
        ["Wait", "忙", "Busy", "busy.cur"],
        ["IBeam", "文本选择", "Text Select", "text.cur"],
        ["Hand", "链接选择", "Link Select", "hand.cur"],
        ["No", "不可用", "Unavailable", "no.cur"],
        ["SizeAll", "移动", "Move", "move.cur"],
      ],
      "C:\\Users\\LeoGene\\AppData\\Local\\CursorStudio\\themes\\9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11\\cursors",
      "cur",
    ),
  },
];
