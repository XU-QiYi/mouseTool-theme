import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { inTauri, type TaskProgress } from "@/services/theme";
import {
  mockDeleteBackup,
  mockExportBackup,
  mockGetAutostart,
  mockGetSettings,
  mockGetStorageStats,
  mockImportBackup,
  mockListBackupThemes,
  mockListBackups,
  mockPreviewThemesDir,
  mockRestoreThemeFromBackup,
  mockRunAutoBackup,
  mockSetAutostart,
  mockSetThemesDir,
  mockUpdateSettings,
  mockVerifyBackup,
} from "@/services/mock-settings";
import type { CursorTheme } from "@/types/theme";

/**
 * 行为设置的 Rust 命令封装
 *
 * 浏览器开发模式的模拟在 `services/mock-settings.ts`（决策 50）：本文件
 * 只留命令签名、类型契约与真实 invoke 路径，mock 的业务口径不再散在这里。
 */

export type CloseBehavior = "exit" | "tray";

/** `get_settings` / `update_settings` 的返回值 */
export interface SettingsSnapshot {
  close_behavior: CloseBehavior;
  /** 用户选定的主题存储目录；null = 默认 `<数据目录>\themes` */
  themes_dir: string | null;
  /** 实际生效的主题目录 */
  effective_themes_dir: string;
  auto_check_update: boolean;
  shortcuts_enabled: boolean;
  /** 跟随系统深浅色自动切换主题（切换逻辑在 `lib/auto-switch.ts`） */
  auto_switch_enabled: boolean;
  /** 系统浅色时使用的主题 ID；null = 浅色时不切换 */
  auto_switch_light_id: string | null;
  /** 系统深色时使用的主题 ID；null = 深色时不切换 */
  auto_switch_dark_id: string | null;
  /** 光标守护：启动或检测到外部改写时自动恢复上次使用的主题（逻辑在 `lib/cursor-guard.ts`） */
  cursor_guard_enabled: boolean;
  /** 自动备份：每天第一份备份落进「备份历史」（逻辑在 `lib/auto-backup.ts`，决策 32） */
  auto_backup_enabled: boolean;
  /** 自动备份保留份数（1–100） */
  auto_backup_keep: number;
  /** 定时切换主题：时间段内 / 外应用配对主题（逻辑在 `lib/schedule-switch.ts`，决策 33） */
  schedule_switch_enabled: boolean;
  /** 时间段起点，24 小时制 `HH:MM` */
  schedule_start: string;
  /** 时间段终点，24 小时制 `HH:MM`；小于起点视为跨零点区间 */
  schedule_end: string;
  /** 时间段内使用的主题 ID；null = 期间内不切换 */
  schedule_in_id: string | null;
  /** 时间段外使用的主题 ID；null = 期间外不切换 */
  schedule_out_id: string | null;
  /** 读取设置时的非致命问题（典型：文件损坏已自动备份） */
  warnings: string[];
}

/** 开机自启动状态 */
export interface AutostartStatus {
  enabled: boolean;
  /** 注册表里实际登记的程序路径；未开启时为空串 */
  exe_path: string;
}

/** update_settings 的可选补丁：只传要改的字段 */
export interface SettingsPatch {
  close_behavior?: CloseBehavior;
  auto_check_update?: boolean;
  shortcuts_enabled?: boolean;
  auto_switch_enabled?: boolean;
  /**
   * 主题 ID 映射的清空用**空串**表示：后端要靠「传了」和「没传」区分补丁，
   * 而 serde_json 分不清 null 和缺省（与 Rust 侧 `normalize_theme_id` 对应）
   */
  auto_switch_light_id?: string;
  auto_switch_dark_id?: string;
  cursor_guard_enabled?: boolean;
  auto_backup_enabled?: boolean;
  auto_backup_keep?: number;
  schedule_switch_enabled?: boolean;
  schedule_start?: string;
  schedule_end?: string;
  /** 同主题 ID 映射：清空用空串（后端 normalize_theme_id） */
  schedule_in_id?: string;
  schedule_out_id?: string;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export function getSettings(): Promise<SettingsSnapshot> {
  if (!inTauri) return Promise.resolve(mockGetSettings());
  return invoke<SettingsSnapshot>("get_settings");
}

export function updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
  if (!inTauri) return Promise.resolve(mockUpdateSettings(patch));
  return invoke<SettingsSnapshot>("update_settings", {
    closeBehavior: patch.close_behavior,
    autoCheckUpdate: patch.auto_check_update,
    shortcutsEnabled: patch.shortcuts_enabled,
    autoSwitchEnabled: patch.auto_switch_enabled,
    autoSwitchLightId: patch.auto_switch_light_id,
    autoSwitchDarkId: patch.auto_switch_dark_id,
    cursorGuardEnabled: patch.cursor_guard_enabled,
    autoBackupEnabled: patch.auto_backup_enabled,
    autoBackupKeep: patch.auto_backup_keep,
    scheduleSwitchEnabled: patch.schedule_switch_enabled,
    scheduleStart: patch.schedule_start,
    scheduleEnd: patch.schedule_end,
    scheduleInId: patch.schedule_in_id,
    scheduleOutId: patch.schedule_out_id,
  });
}

export function getAutostart(): Promise<AutostartStatus> {
  if (!inTauri) return Promise.resolve(mockGetAutostart());
  return invoke<AutostartStatus>("get_autostart");
}

export function setAutostart(enable: boolean): Promise<AutostartStatus> {
  if (!inTauri) return Promise.resolve(mockSetAutostart(enable));
  return invoke<AutostartStatus>("set_autostart", { enable });
}

// ---------------------------------------------------------------------------
// 主题存储目录迁移
// ---------------------------------------------------------------------------

/** 迁移确认信息（`preview_themes_dir`） */
export interface ThemesDirPlan {
  source: string;
  target: string;
  /** 目标是默认目录（设置里不写自定义值） */
  is_default: boolean;
  theme_count: number;
  file_count: number;
  total_bytes: number;
  /** 不阻断迁移的提示（缺 theme.json 的目录等） */
  warnings: string[];
}

/** 迁移阶段；与 Rust 侧 `MoveProgress.phase` 一一对应 */
export type ThemesDirPhase =
  | "copy"
  | "verify"
  | "switch"
  | "registry"
  | "settings"
  | "cleanup"
  | "done";

export interface ThemesDirProgress {
  phase: ThemesDirPhase;
  current: number;
  total: number;
  message: string;
}

export interface ThemesDirReport {
  source: string;
  target: string;
  theme_count: number;
  file_count: number;
  total_bytes: number;
  /** 被重新绑定的注册表槽位数 */
  rebound_slots: number;
  warnings: string[];
}

export interface ThemesDirChangeResult {
  settings: SettingsSnapshot;
  report: ThemesDirReport;
}

/** 预检目标目录：只校验与统计，不搬任何文件 */
export function previewThemesDir(path: string | null): Promise<ThemesDirPlan> {
  if (!inTauri) return mockPreviewThemesDir(path);
  return invoke<ThemesDirPlan>("preview_themes_dir", { path });
}

/** 更换主题存储目录（null = 回默认）；进度通过事件回调给界面 */
export async function setThemesDir(
  path: string | null,
  onProgress?: (progress: ThemesDirProgress) => void,
): Promise<ThemesDirChangeResult> {
  if (!inTauri) return mockSetThemesDir(path, onProgress);

  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<ThemesDirProgress>("themes-dir-progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return await invoke<ThemesDirChangeResult>("set_themes_dir", { path });
  } finally {
    unlisten?.();
  }
}

// ---------------------------------------------------------------------------
// 数据备份
// ---------------------------------------------------------------------------

/** 导出备份的结果 */
export interface ExportBackupSummary {
  themes: number;
  files: number;
  /** 备份最终落盘的位置（应用内备份 = 数据目录 backups\ 下的路径） */
  saved_path: string;
  /** 备份文件体积（字节） */
  bytes: number;
  warnings: string[];
}

/** 恢复备份的结果（合并语义：只补回缺失的） */
export interface ImportBackupSummary {
  themes_added: number;
  themes_skipped: number;
  history_added: number;
  warnings: string[];
}

/** 备份历史的一条记录（`list_backups`），字段与 Rust `BackupEntry` 一一对应 */
export interface BackupEntry {
  file_name: string;
  path: string;
  /** 文件修改时间，本地时区 `YYYY-MM-DD HH:MM`；读不到为「未知」 */
  created_at: string;
  /** "manual"（手动）| "auto"（自动备份，决策 32） */
  kind: string;
  themes: number;
  files: number;
  bytes: number;
  /** "ok" | "corrupt" */
  status: string;
  error: string | null;
}

/** 备份里的一套主题摘要（`list_backup_themes`，只读，不解压光标） */
export interface BackupThemeEntry {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  slots: number;
  /** 这套主题在包里的条目数（含 theme.json） */
  files: number;
  /** 这套主题在包里的解压后总字节数（按中央目录声明值） */
  bytes: number;
  /** 声明的槽位里，包里找不到对应文件的个数（决策 31 的缺口口径） */
  missing_files: number;
}

/** `list_backup_themes` 的返回值 */
export interface BackupThemeListing {
  themes: BackupThemeEntry[];
  /** 备份里被跳过或损坏的主题说明 */
  warnings: string[];
}

/** `restore_theme_from_backup` 的返回值 */
export interface RestoreBackupThemeOutcome {
  /** 刚落盘的主题，槽位路径是运行时绝对路径 */
  theme: CursorTheme;
  /** 路径改写 / 槽位清洗等非致命提示 */
  warnings: string[];
}

/**
 * 只读备份内容：列出包里能完整恢复的主题
 *
 * 只读中央目录与 theme.json，不解压光标；用于「备份历史 → 内容」弹窗。
 */
export function listBackupThemes(path: string): Promise<BackupThemeListing> {
  if (!inTauri) return Promise.resolve(mockListBackupThemes());
  return invoke<BackupThemeListing>("list_backup_themes", { path });
}

/**
 * 从备份里恢复一套主题（追加语义）
 *
 * 目标 ID 已存在时后端拒绝；不合并使用记录，也不影响备份里的其它主题。
 */
export function restoreThemeFromBackup(
  zipPath: string,
  themeId: string,
): Promise<RestoreBackupThemeOutcome> {
  if (!inTauri) return mockRestoreThemeFromBackup(themeId);
  return invoke<RestoreBackupThemeOutcome>("restore_theme_from_backup", { zipPath, themeId });
}

/**
 * 导出全部主题与使用记录为备份 zip；进度来自 `backup-progress` 事件
 *
 * `destPath = null` 写入应用内备份目录 `backups\`（自动命名，进「备份历史」）；
 * 传路径则导出到用户自选位置（不受历史管理）。
 */
export async function exportBackup(
  destPath: string | null,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ExportBackupSummary> {
  if (!inTauri) return mockExportBackup(destPath, onProgress);

  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<TaskProgress>("backup-progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return await invoke<ExportBackupSummary>("export_backup", { destPath });
  } finally {
    unlisten?.();
  }
}

/** 从备份 zip 合并恢复；进度来自 `backup-progress` 事件 */
export async function importBackup(
  zipPath: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ImportBackupSummary> {
  if (!inTauri) return Promise.resolve(mockImportBackup());

  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<TaskProgress>("backup-progress", (event) => {
      onProgress(event.payload);
    });
  }
  try {
    return await invoke<ImportBackupSummary>("import_backup", { zipPath });
  } finally {
    unlisten?.();
  }
}

// ---------------------------------------------------------------------------
// 备份历史（应用内备份目录 backups\）
// ---------------------------------------------------------------------------

/** 列出应用内备份（按时间倒序）；目录不存在返回空 */
export function listBackups(): Promise<BackupEntry[]> {
  if (!inTauri) return Promise.resolve(mockListBackups());
  return invoke<BackupEntry[]>("list_backups");
}

/** 删除一个应用内备份（只按文件名，后端拒绝越出 backups\ 的输入） */
export function deleteBackup(fileName: string): Promise<void> {
  if (!inTauri) {
    mockDeleteBackup(fileName);
    return Promise.resolve();
  }
  return invoke<void>("delete_backup", { fileName });
}

/** 一块区域的占用：条目数与字节数（`get_storage_stats`，决策 34） */
export interface StorageDirStats {
  count: number;
  bytes: number;
}

/** 数据目录各区域的磁盘占用（只读统计） */
export interface StorageStats {
  themes: StorageDirStats;
  backups: StorageDirStats;
  trash: StorageDirStats;
  history_bytes: number;
  settings_bytes: number;
  total_bytes: number;
}

/** 数据目录各区域的磁盘占用（决策 34）；统计期间其它操作照常跑 */
export function getStorageStats(): Promise<StorageStats> {
  if (!inTauri) return Promise.resolve(mockGetStorageStats());
  return invoke<StorageStats>("get_storage_stats");
}

/** 备份完整性体检结果（决策 37），字段与 Rust `BackupVerifyReport` 一一对应 */
export interface BackupVerifyReport {
  file_name: string;
  /** 实际做了 CRC 校验的文件条目数（目录条目不计） */
  entries_checked: number;
  /** 条目声明大小的累计值（概数） */
  bytes: number;
  /** 损坏条目名（最多列出 20 条） */
  corrupt: string[];
  /** 损坏条目总数（corrupt 可能被截断） */
  corrupt_total: number;
}

/** 体检一份应用内备份：流式读每个条目触发 CRC 校验，当场点名坏条目 */
export function verifyBackup(fileName: string): Promise<BackupVerifyReport> {
  if (!inTauri) return Promise.resolve(mockVerifyBackup(fileName));
  return invoke<BackupVerifyReport>("verify_backup", { fileName });
}

/** 自动备份的结果，字段与 Rust `AutoBackupSummary` 一一对应 */
export interface AutoBackupOutcome {
  /** 本次是否真的创建了备份 */
  created: boolean;
  /** 今天已有自动备份而跳过 */
  skipped: boolean;
  /** 本次创建时的落盘文件名（跳过时为 null） */
  file_name: string | null;
  /** 本次顺带清理掉的过期自动备份数 */
  pruned: number;
}

/**
 * 自动备份（决策 32）：命令层负责当日去重与过期清理，前端只管在合适的时机
 * 调用（启动后、窗口聚焦节流后、开关打开时，见 `lib/auto-backup.ts`）。
 * 不发 `backup-progress`：自动备份不顶掉手动备份的进度展示。
 */
export function runAutoBackup(keep: number): Promise<AutoBackupOutcome> {
  if (!inTauri) return mockRunAutoBackup(keep);
  return invoke<AutoBackupOutcome>("run_auto_backup", { keep });
}
