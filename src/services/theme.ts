import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  ActiveState,
  ApplyOutcome,
  BatchDeleteOutcome,
  CursorTheme,
  DeleteOutcome,
  EmptyTrashOutcome,
  ImportReport,
  RestoreOutcome,
  SaveCurrentOutcome,
  ThemesResult,
  TrashListing,
} from "@/types/theme";
import type { CursorPreview } from "@/types/cursor";
import {
  mockApplyTheme,
  mockClearHistory,
  mockDeleteFromTrash,
  mockDeleteTheme,
  mockDeleteThemes,
  mockEmptyTrash,
  mockExportAllThemes,
  mockExportTheme,
  mockFindDuplicateThemes,
  mockGetActiveState,
  mockGetAllThemes,
  mockGetCursorPreview,
  mockGetDataDir,
  mockImportTheme,
  mockListTrash,
  mockOpenDataDir,
  mockRenameTheme,
  mockRestoreDefault,
  mockRestoreFromTrash,
  mockSaveCurrentTheme,
} from "@/services/mock-theme";

/** 是否运行在 Tauri 容器里（浏览器里打开时为 false） */
export const inTauri = "__TAURI_INTERNALS__" in window;

/** 长耗时任务的进度载荷；与 Rust `utils::progress::TaskProgress` 一一对应 */
export interface TaskProgress {
  stage: string;
  current: number;
  total: number;
  message: string;
}

/** 对应 Rust 命令 `get_all_themes`；数据源独立容错，失败项进 warnings 而非整体报错 */
export function getAllThemes(): Promise<ThemesResult> {
  if (!inTauri) return mockGetAllThemes();
  return invoke<ThemesResult>("get_all_themes");
}

/** 内容重复的一组主题（决策 38），字段与 Rust `DuplicateGroup` 一一对应 */
export interface DuplicateGroup {
  theme_ids: string[];
  theme_names: string[];
  /** 单套主题非空槽位文件的总字节 */
  bytes: number;
  slots_filled: number;
}

/** 对应 Rust 命令 `find_duplicate_themes`：主题内容查重（决策 38） */
export interface DuplicateReport {
  /** 内容完全一致的组（≥2 套），按可省字节降序 */
  groups: DuplicateGroup[];
  /** 参与比对的主题数（缺文件 / 无可用槽位的不参与） */
  scanned: number;
  /** 因槽位文件缺失而未参与比对的主题数（在证据里说明） */
  skipped_missing: number;
  /** 每组删到剩一套合计能省的字节 */
  wasted_bytes: number;
  warnings: string[];
}

/** 查重（决策 38）：只读比对，与存储统计（决策 35）配对——统计说占多少，查重说哪些重复 */
export function findDuplicateThemes(): Promise<DuplicateReport> {
  if (!inTauri) return Promise.resolve(mockFindDuplicateThemes());
  return invoke<DuplicateReport>("find_duplicate_themes");
}

/** 对应 Rust 命令 `get_active_state`：聚焦时轻量重查「当前使用」（决策 24） */
export function getActiveState(): Promise<ActiveState> {
  if (!inTauri) return mockGetActiveState();
  return invoke<ActiveState>("get_active_state");
}

/** 对应 Rust 命令 `get_cursor_preview`；浏览器环境无文件系统，返回 null 走占位图 */
export function getCursorPreview(filePath: string): Promise<CursorPreview | null> {
  if (!inTauri) return mockGetCursorPreview(filePath);
  return invoke<CursorPreview>("get_cursor_preview", { filePath });
}

/**
 * 对应 Rust 命令 `apply_theme`：写注册表并立即刷新系统光标
 *
 * 返回更新后的「最近使用」；`warning` 非空表示光标切了、但历史没记上。
 */
export function applyTheme(theme: CursorTheme): Promise<ApplyOutcome> {
  if (!inTauri) return mockApplyTheme(theme);
  return invoke<ApplyOutcome>("apply_theme", { theme });
}

/** 对应 Rust 命令 `restore_default`：清空光标设置并刷新 */
export function restoreDefault(): Promise<void> {
  if (!inTauri) return mockRestoreDefault();
  return invoke<void>("restore_default");
}

/**
 * 对应 Rust 命令 `save_current_theme`：把外部改写态的光标收编为我的主题
 *
 * 浏览器里的模拟见 `mock-theme.ts`（没有注册表，用示例主题顶上）。
 */
export function saveCurrentTheme(): Promise<SaveCurrentOutcome> {
  if (!inTauri) return mockSaveCurrentTheme();
  return invoke<SaveCurrentOutcome>("save_current_theme");
}

/** 对应 Rust 命令 `import_theme`：导入 .zip 包、.theme 光标方案（决策 36）或整个文件夹，返回新主题与跳过项 */
export async function importTheme(
  sourcePath: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ImportReport> {
  if (!inTauri) return mockImportTheme(sourcePath, onProgress);

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

/** 对应 Rust 命令 `delete_theme`：主题移入回收站（软删除，决策 26） */
export function deleteTheme(themeId: string): Promise<DeleteOutcome> {
  if (!inTauri) return mockDeleteTheme(themeId);
  return invoke<DeleteOutcome>("delete_theme", { themeId });
}

/**
 * 对应 Rust 命令 `delete_themes`：多选批量移入回收站（决策 43）
 *
 * 部分成功：单套被拒绝只进 `failed`，其余照常删除。后端在整批执行期间只
 * 取一把 `ops` 锁、只刷新一次托盘，逐套复用单套删除的校验与回收站链路。
 */
export async function deleteThemes(
  themeIds: string[],
  onProgress?: (progress: TaskProgress) => void,
): Promise<BatchDeleteOutcome> {
  const unique = [...new Set(themeIds)];
  if (!inTauri) return mockDeleteThemes(themeIds, onProgress);

  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<TaskProgress>("delete-progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return await invoke<BatchDeleteOutcome>("delete_themes", { themeIds: unique });
  } finally {
    unlisten?.();
  }
}

/** 对应 Rust 命令 `list_trash`：列出回收站与当前限额 */
export function listTrash(): Promise<TrashListing> {
  if (!inTauri) return mockListTrash();
  return invoke<TrashListing>("list_trash");
}

/** 对应 Rust 命令 `restore_from_trash`：把主题搬回当前主题目录 */
export function restoreFromTrash(entryId: string): Promise<RestoreOutcome> {
  if (!inTauri) return mockRestoreFromTrash(entryId);
  return invoke<RestoreOutcome>("restore_from_trash", { entryId });
}

/** 对应 Rust 命令 `delete_from_trash`：彻底删除一个条目 */
export function deleteFromTrash(entryId: string): Promise<void> {
  if (!inTauri) return mockDeleteFromTrash(entryId);
  return invoke<void>("delete_from_trash", { entryId });
}

/** 对应 Rust 命令 `empty_trash`：清空回收站 */
export function emptyTrash(): Promise<EmptyTrashOutcome> {
  if (!inTauri) return mockEmptyTrash();
  return invoke<EmptyTrashOutcome>("empty_trash");
}

/**
 * 对应 Rust 命令 `rename_theme`：只改显示名，返回更新后的主题
 *
 * 浏览器环境直接本地改名，让开发时也能走通完整交互（不会持久化）。
 */
export function renameTheme(theme: CursorTheme, newName: string): Promise<CursorTheme> {
  if (!inTauri) return mockRenameTheme(theme, newName);
  return invoke<CursorTheme>("rename_theme", { themeId: theme.id, newName });
}

/** `export_theme` 的返回值：跳过的槽位要说清，否则用户不知道少了什么 */
export interface ExportSummary {
  file_count: number;
  skipped: string[];
}

/** 对应 Rust 命令 `export_theme`：把光标文件打包成 zip */
export function exportTheme(theme: CursorTheme, destPath: string): Promise<ExportSummary> {
  if (!inTauri) return mockExportTheme(theme, destPath);
  return invoke<ExportSummary>("export_theme", { theme, destPath });
}

/** `export_all_themes` 结果里的一条成功项 */
export interface ExportAllItem {
  theme_id: string;
  name: string;
  /** 实际落盘的文件名；与目录里已有文件重名时后端自动加序号 */
  file_name: string;
  bytes: number;
  file_count: number;
}

/** `export_all_themes` 结果里的一条失败项（部分成功语义，硬约束 8） */
export interface ExportAllFailure {
  theme_id: string;
  name: string;
  error: string;
}

/** `export_all_themes` 的返回值（决策 34） */
export interface ExportAllOutcome {
  dir: string;
  exported: ExportAllItem[];
  failed: ExportAllFailure[];
  total_bytes: number;
  warnings: string[];
}

/**
 * 批量导出「我的主题」（决策 34）：进度来自 `export-all-progress` 事件
 *
 * 某一套导不出去只进 `failed`，其余照常落盘。
 */
export async function exportAllThemes(
  destDir: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ExportAllOutcome> {
  if (!inTauri) return mockExportAllThemes(destDir);

  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<TaskProgress>("export-all-progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return await invoke<ExportAllOutcome>("export_all_themes", { destDir });
  } finally {
    unlisten?.();
  }
}

/** 清空最近使用记录（决策 34）：返回清掉的条数 */
export function clearHistory(): Promise<number> {
  if (!inTauri) return mockClearHistory();
  return invoke<number>("clear_history");
}

/** 对应 Rust 命令 `get_data_dir`：数据目录的展示路径（只读，不创建目录） */
export function getDataDir(): Promise<string> {
  if (!inTauri) return mockGetDataDir();
  return invoke<string>("get_data_dir");
}

/** 对应 Rust 命令 `open_data_dir`：在系统文件管理器打开数据目录（不存在则先创建） */
export function openDataDir(): Promise<string> {
  if (!inTauri) return mockOpenDataDir();
  return invoke<string>("open_data_dir");
}
