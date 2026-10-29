import type { CursorSlot, CursorTheme, HistoryEntry } from "@/types/theme";

/** 浏览器预览用示例数据，仅在非 Tauri 环境生效，打包后不会走到这里 */

type Row = [registry_key: string, display_name: string, english_name: string, file: string];

function makeCursors(rows: Row[], dir: string, fileType: string): CursorSlot[] {
  return rows.map(([registry_key, display_name, english_name, file]) => ({
    registry_key,
    display_name,
    english_name,
    file_path: `${dir}\\${file}`,
    // 与后端 file_type_of 同义：取扩展名，取不到才退回入参
    file_type: file.split(".").pop() || fileType,
  }));
}

const WIN_DIR = "C:\\Windows\\Cursors";
const WIN_THEME_DIR = "C:\\Windows\\Cursors\\荧1.0";
const userDir = (id: string) =>
  `C:\\Users\\Public\\AppData\\Local\\CursorStudio\\themes\\${id}\\cursors`;

/** 示例用的 15 个标准槽位（顺序与 SLOT_DEFS 一致） */
const FULL_SLOTS: Row[] = [
  ["Arrow", "正常选择", "Normal Select", "arrow.cur"],
  ["Help", "帮助选择", "Help Select", "help.cur"],
  ["AppStarting", "后台运行", "Working in Background", "working.cur"],
  ["Wait", "忙", "Busy", "busy.cur"],
  ["Crosshair", "精确选择", "Precision Select", "cross.cur"],
  ["IBeam", "文本选择", "Text Select", "beam.cur"],
  ["NWPen", "手写笔", "Handwriting", "pen.cur"],
  ["No", "不可用", "Unavailable", "no.cur"],
  ["SizeNS", "垂直调整大小", "Vertical Resize", "ns.cur"],
  ["SizeWE", "水平调整大小", "Horizontal Resize", "we.cur"],
  ["SizeNWSE", "对角线调整 1", "Diagonal Resize 1", "nwse.cur"],
  ["SizeNESW", "对角线调整 2", "Diagonal Resize 2", "nesw.cur"],
  ["SizeAll", "移动", "Move", "move.cur"],
  ["UpArrow", "候选选择", "Alternate Select", "up.cur"],
  ["Hand", "链接选择", "Link Select", "hand.cur"],
];

/** 示例用的「今天/昨天」时间戳：固定日期会让最近使用页永远显示不存在的"今天" */
function stampOf(daysAgo: number, hour: number, minute: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:${pad(minute)}`;
}

export const MOCK_THEMES: CursorTheme[] = [
  {
    id: "sys_windows_default",
    name: "Windows 默认",
    description: "",
    created_at: "",
    updated_at: "",
    is_built_in: true,
    cursors: makeCursors(FULL_SLOTS, WIN_DIR, "cur"),
  },
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
      WIN_THEME_DIR,
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
      userDir("9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"),
      "cur",
    ),
  },
  {
    id: "4a7d92e1-3c8b-4f60-9a1d-5e2b8c7f0a33",
    name: "Paper & Ink",
    description: "导入自 paper-ink-2.1.zip",
    created_at: "2026-10-12 14:05",
    updated_at: "2026-10-12 14:05",
    is_built_in: false,
    cursors: makeCursors(
      [
        ["Arrow", "正常选择", "Normal Select", "arrow.cur"],
        ["Help", "帮助选择", "Help Select", "help.cur"],
        ["AppStarting", "后台运行", "Working in Background", "working.ani"],
        ["Wait", "忙", "Busy", "busy.ani"],
        ["IBeam", "文本选择", "Text Select", "beam.cur"],
        ["No", "不可用", "Unavailable", "no.cur"],
        ["SizeNS", "垂直调整大小", "Vertical Resize", "ns.cur"],
        ["SizeWE", "水平调整大小", "Horizontal Resize", "we.cur"],
        ["SizeAll", "移动", "Move", "move.cur"],
        ["Hand", "链接选择", "Link Select", "hand.cur"],
      ],
      userDir("4a7d92e1-3c8b-4f60-9a1d-5e2b8c7f0a33"),
      "cur",
    ),
  },
];

/**
 * 浏览器预览用「只存在于备份里」的主题（决策 34）
 *
 * 它的 ID 与下面「已删除」的那条最近使用记录一致：恢复后时间轴里的
 * 「已删除」会重新变成可应用状态，正好覆盖备份恢复的完整故事。
 */
export const MOCK_ARCHIVED_THEMES: CursorTheme[] = [
  {
    id: "6b1f0c44-2d95-4a37-8f18-0c9d2e5b7a90",
    name: "Midnight Blue",
    description: "导入自 midnight-blue.zip",
    created_at: "2026-10-05 22:10",
    updated_at: "2026-10-05 22:10",
    is_built_in: false,
    cursors: makeCursors(
      [
        ["Arrow", "正常选择", "Normal Select", "arrow.cur"],
        ["Help", "帮助选择", "Help Select", "help.cur"],
        ["AppStarting", "后台运行", "Working in Background", "working.ani"],
        ["Wait", "忙", "Busy", "busy.ani"],
        ["IBeam", "文本选择", "Text Select", "beam.cur"],
        ["No", "不可用", "Unavailable", "no.cur"],
        ["SizeAll", "移动", "Move", "move.cur"],
        ["Hand", "链接选择", "Link Select", "hand.cur"],
      ],
      userDir("6b1f0c44-2d95-4a37-8f18-0c9d2e5b7a90"),
      "cur",
    ),
  },
];

/**
 * 浏览器预览用的「最近使用」示例：真实记录由 Rust 侧写 history.json。
 * 覆盖三种状态：今天用过、昨天用过、主题已被删除。
 */
export const MOCK_RECENT: HistoryEntry[] = [
  {
    theme_id: "9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11",
    name: "Neon Night",
    is_built_in: false,
    applied_at: stampOf(0, 9, 12),
  },
  {
    theme_id: "sys_firefly",
    name: "firefly",
    is_built_in: true,
    applied_at: stampOf(1, 21, 40),
  },
  {
    // 这个主题已经不在列表里了：历史仍然保留，展示「已删除」状态
    theme_id: "6b1f0c44-2d95-4a37-8f18-0c9d2e5b7a90",
    name: "Midnight Blue",
    is_built_in: false,
    applied_at: stampOf(1, 10, 5),
  },
  {
    theme_id: "4a7d92e1-3c8b-4f60-9a1d-5e2b8c7f0a33",
    name: "Paper & Ink",
    is_built_in: false,
    applied_at: stampOf(3, 18, 26),
  },
];
