import type { CursorTheme } from "@/types/theme";

/** 浏览器预览用示例数据，仅在非 Tauri 环境生效，打包后不会走到这里 */
export const MOCK_THEMES: CursorTheme[] = [
  {
    id: "sys_firefly",
    name: "firefly",
    description: "",
    created_at: "",
    updated_at: "",
    is_built_in: true,
    cursors: [
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
    ].map(([registry_key, display_name, english_name, file]) => ({
      registry_key,
      display_name,
      english_name,
      file_path: `C:\\Windows\\Cursors\\荧1.0\\${file}`,
      file_type: "ani",
    })),
  },
];
