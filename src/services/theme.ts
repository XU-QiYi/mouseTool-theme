import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  ApplyOutcome,
  CursorTheme,
  HistoryEntry,
  ImportReport,
  ThemesResult,
} from "@/types/theme";
import type { CursorPreview } from "@/types/cursor";
import { MOCK_RECENT, MOCK_THEMES } from "@/services/mock";

/** 是否运行在 Tauri 容器里（浏览器里打开时为 false） */
export const inTauri = "__TAURI_INTERNALS__" in window;

/** 长耗时任务的进度载荷；与 Rust `utils::progress::TaskProgress` 一一对应 */
export interface TaskProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

/** 浏览器预览用的「上一次使用时间」，格式与 Rust 侧一致（本地时区、分钟精度） */
function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 浏览器里没有 history.json，用内存数组模拟，方便开发时走通「最近使用」 */
let devRecent: HistoryEntry[] = [...MOCK_RECENT];

/** 对应 Rust 命令 `get_all_themes`；数据源独立容错，失败项进 warnings 而非整体报错 */
export function getAllThemes(): Promise<ThemesResult> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，使用示例数据");
    // 开发用开关：?mock-fail 让「整体加载失败」这条分支能被真正走一遍
    //（正常情况下浏览器永远拿到示例数据，错误态没机会出现，也就没法验收）
    if (new URLSearchParams(window.location.search).has("mock-fail")) {
      return Promise.reject(new Error("读取光标方案被拒绝（EACCES，模拟）"));
    }
    // 浏览器里读不到注册表，无法判断哪个主题正在使用
    return Promise.resolve({
      themes: MOCK_THEMES,
      warnings: [],
      active_theme_id: null,
      recent: devRecent,
    });
  }
  return invoke<ThemesResult>("get_all_themes");
}

/** 对应 Rust 命令 `get_cursor_preview`；浏览器环境无文件系统，返回 null 走占位图 */
export function getCursorPreview(filePath: string): Promise<CursorPreview | null> {
  if (!inTauri) {
    return Promise.resolve(null);
  }
  return invoke<CursorPreview>("get_cursor_preview", { filePath });
}

/**
 * 对应 Rust 命令 `apply_theme`：写注册表并立即刷新系统光标
 *
 * 返回更新后的「最近使用」；`warning` 非空表示光标切了、但历史没记上。
 */
export function applyTheme(theme: CursorTheme): Promise<ApplyOutcome> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，跳过应用到系统");
    devRecent = [
      {
        theme_id: theme.id,
        name: theme.name,
        is_built_in: theme.is_built_in,
        applied_at: stamp(),
      },
      ...devRecent.filter((entry) => entry.theme_id !== theme.id),
    ].slice(0, 50);
    return Promise.resolve({ recent: devRecent, warning: null });
  }
  return invoke<ApplyOutcome>("apply_theme", { theme });
}

/** 对应 Rust 命令 `restore_default`：清空光标设置并刷新 */
export function restoreDefault(): Promise<void> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，跳过恢复默认");
    return Promise.resolve();
  }
  return invoke<void>("restore_default");
}

/** 对应 Rust 命令 `import_theme`：导入 .zip 包或整个文件夹（决策 16），返回新主题与跳过项 */
export async function importTheme(
  sourcePath: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ImportReport> {
  if (!inTauri) {
    // 浏览器里没有文件系统：用示例槽位生成一份新主题，
    // 让「导入 → 列表新增 → 检查器选中」这条链路在开发与自动化验收里能走通。
    // 名称取自文件名（含 zip 后缀也兜得住），与后端「文件名 stem 作主题名」的口径一致
    const fileName = sourcePath.split(/[\\/]/).pop() ?? "theme.zip";
    const name = fileName.replace(/\.zip$/i, "") || "未命名主题";
    const sample = MOCK_THEMES.find((t) => !t.is_built_in) ?? MOCK_THEMES[0];
    const now = stamp();
    onProgress?.({
      stage: "done",
      current: 1,
      total: 1,
      message: "导入完成（开发模式）",
    });
    return {
      theme: {
        id: crypto.randomUUID(),
        name,
        description: `导入自 ${fileName}`,
        created_at: now,
        updated_at: now,
        is_built_in: false,
        cursors: sample.cursors,
      },
      warnings: [],
    };
  }

  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<TaskProgress>("import-progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return await invoke<ImportReport>("import_theme", { sourcePath });
  } finally {
    unlisten?.();
  }
}

/** 对应 Rust 命令 `delete_theme`：删除已导入主题及其光标文件目录 */
export function deleteTheme(themeId: string): Promise<void> {
  if (!inTauri) {
    console.warn("[dev] 浏览器环境不删除真实主题");
    return Promise.resolve();
  }
  return invoke<void>("delete_theme", { themeId });
}

/**
 * 对应 Rust 命令 `rename_theme`：只改显示名，返回更新后的主题
 *
 * 浏览器环境直接本地改名，让开发时也能走通完整交互（不会持久化）。
 */
export function renameTheme(theme: CursorTheme, newName: string): Promise<CursorTheme> {
  if (!inTauri) {
    return Promise.resolve({ ...theme, name: newName });
  }
  return invoke<CursorTheme>("rename_theme", { themeId: theme.id, newName });
}

/** `export_theme` 的返回值：跳过的槽位要说清，否则用户不知道少了什么 */
export interface ExportSummary {
  file_count: number;
  skipped: string[];
}

/** 对应 Rust 命令 `export_theme`：把光标文件打包成 zip */
export function exportTheme(theme: CursorTheme, destPath: string): Promise<ExportSummary> {
  if (!inTauri) {
    return Promise.reject(new Error("浏览器环境不支持导出，请在桌面应用中使用"));
  }
  return invoke<ExportSummary>("export_theme", { theme, destPath });
}

/** 浏览器里演示用的数据目录路径（真实路径只有 Rust 侧知道，前端禁止自行拼接） */
const MOCK_DATA_DIR = "C:\\Users\\demo\\AppData\\Local\\CursorStudio";

/** 对应 Rust 命令 `get_data_dir`：数据目录的展示路径（只读，不创建目录） */
export function getDataDir(): Promise<string> {
  if (!inTauri) {
    return Promise.resolve(MOCK_DATA_DIR);
  }
  return invoke<string>("get_data_dir");
}

/** 对应 Rust 命令 `open_data_dir`：在系统文件管理器打开数据目录（不存在则先创建） */
export function openDataDir(): Promise<string> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，跳过打开系统目录");
    return Promise.resolve(MOCK_DATA_DIR);
  }
  return invoke<string>("open_data_dir");
}
