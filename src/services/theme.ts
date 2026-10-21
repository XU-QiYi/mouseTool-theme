import { invoke } from "@tauri-apps/api/core";

import type { CursorTheme, ThemesResult } from "@/types/theme";
import type { CursorPreview } from "@/types/cursor";
import { MOCK_THEMES } from "@/services/mock";

/** 是否运行在 Tauri 容器里（浏览器里打开时为 false） */
export const inTauri = "__TAURI_INTERNALS__" in window;

/** 对应 Rust 命令 `get_all_themes`；数据源独立容错，失败项进 warnings 而非整体报错 */
export function getAllThemes(): Promise<ThemesResult> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，使用示例数据");
    // 浏览器里读不到注册表，无法判断哪个主题正在使用
    return Promise.resolve({ themes: MOCK_THEMES, warnings: [], active_theme_id: null });
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

/** 对应 Rust 命令 `apply_theme`：写注册表并立即刷新系统光标 */
export function applyTheme(theme: CursorTheme): Promise<void> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，跳过应用到系统");
    return Promise.resolve();
  }
  return invoke<void>("apply_theme", { theme });
}

/** 对应 Rust 命令 `restore_default`：清空光标设置并刷新 */
export function restoreDefault(): Promise<void> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，跳过恢复默认");
    return Promise.resolve();
  }
  return invoke<void>("restore_default");
}

/** 对应 Rust 命令 `import_theme`：导入 zip 主题包，返回新主题 */
export function importTheme(zipPath: string): Promise<CursorTheme> {
  if (!inTauri) {
    return Promise.reject(new Error("浏览器环境不支持导入，请在桌面应用中使用"));
  }
  return invoke<CursorTheme>("import_theme", { zipPath });
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
