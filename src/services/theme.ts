import { invoke } from "@tauri-apps/api/core";

import type { CursorTheme } from "@/types/theme";
import type { CursorPreview } from "@/types/cursor";
import { MOCK_THEMES } from "@/services/mock";

/** 是否运行在 Tauri 容器里（浏览器里打开时为 false） */
export const inTauri = "__TAURI_INTERNALS__" in window;

/** 对应 Rust 命令 `get_all_themes` */
export function getAllThemes(): Promise<CursorTheme[]> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，使用示例数据");
    return Promise.resolve(MOCK_THEMES);
  }
  return invoke<CursorTheme[]>("get_all_themes");
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
