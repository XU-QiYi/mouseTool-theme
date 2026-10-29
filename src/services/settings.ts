import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { addMockTheme, inTauri, type TaskProgress } from "@/services/theme";
import { MOCK_ARCHIVED_THEMES, MOCK_THEMES } from "@/services/mock";
import type { CursorTheme } from "@/types/theme";

/**
 * 行为设置的 Rust 命令封装
 *
 * 浏览器开发模式（设计验收就跑在这里）用 localStorage 顶上，
 * 让开关状态在刷新后仍然保持，截图与真机看到的行为一致。
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
// 开发模式模拟（非 Tauri 环境）
// ---------------------------------------------------------------------------

const MOCK_KEY = "cursorstudio.settings";
const MOCK_EXE = "C:\\Users\\demo\\App\\Local\\mousetool-theme.exe";

const MOCK_DEFAULT: SettingsSnapshot = {
  close_behavior: "exit",
  themes_dir: null,
  effective_themes_dir: "C:\\Users\\demo\\AppData\\Local\\CursorStudio\\themes",
  auto_check_update: true,
  shortcuts_enabled: true,
  auto_switch_enabled: false,
  auto_switch_light_id: null,
  auto_switch_dark_id: null,
  cursor_guard_enabled: false,
  auto_backup_enabled: false,
  auto_backup_keep: 10,
  schedule_switch_enabled: false,
  schedule_start: "09:00",
  schedule_end: "18:00",
  schedule_in_id: null,
  schedule_out_id: null,
  warnings: [],
};

function mockSettings(): SettingsSnapshot {
  try {
    const raw = localStorage.getItem(MOCK_KEY);
    return raw ? { ...MOCK_DEFAULT, ...JSON.parse(raw) } : MOCK_DEFAULT;
  } catch {
    return MOCK_DEFAULT;
  }
}

function mockSave(settings: SettingsSnapshot): SettingsSnapshot {
  try {
    localStorage.setItem(MOCK_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式存不了：本次会话内仍然生效 */
  }
  return settings;
}

function mockAutostart(): AutostartStatus {
  try {
    const enabled = localStorage.getItem("cursorstudio.autostart") === "1";
    return { enabled, exe_path: enabled ? MOCK_EXE : "" };
  } catch {
    return { enabled: false, exe_path: "" };
  }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export function getSettings(): Promise<SettingsSnapshot> {
  if (!inTauri) return Promise.resolve(mockSettings());
  return invoke<SettingsSnapshot>("get_settings");
}

export function updateSettings(patch: SettingsPatch): Promise<SettingsSnapshot> {
  if (!inTauri) {
    // 对齐后端语义：主题 ID 补丁的空串 = 清空（Rust 侧 normalize_theme_id）
    const merged = { ...mockSettings(), ...patch };
    return Promise.resolve(
      mockSave({
        ...merged,
        auto_switch_light_id: merged.auto_switch_light_id || null,
        auto_switch_dark_id: merged.auto_switch_dark_id || null,
        schedule_in_id: merged.schedule_in_id || null,
        schedule_out_id: merged.schedule_out_id || null,
      }),
    );
  }
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
  if (!inTauri) return Promise.resolve(mockAutostart());
  return invoke<AutostartStatus>("get_autostart");
}

export function setAutostart(enable: boolean): Promise<AutostartStatus> {
  if (!inTauri) {
    try {
      localStorage.setItem("cursorstudio.autostart", enable ? "1" : "0");
    } catch {
      /* 同上 */
    }
    return Promise.resolve(mockAutostart());
  }
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
// 开发模式迁移模拟
// ---------------------------------------------------------------------------

const MOCK_DATA_ROOT = "C:\\Users\\demo\\AppData\\Local\\CursorStudio";
const MOCK_DEFAULT_THEMES_DIR = `${MOCK_DATA_ROOT}\\themes`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockTarget(path: string | null): string {
  return path ?? MOCK_DEFAULT_THEMES_DIR;
}

function sameMockPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function mockPreviewThemesDir(path: string | null): Promise<ThemesDirPlan> {
  const settings = mockSettings();
  const target = mockTarget(path);
  if (sameMockPath(target, settings.effective_themes_dir)) {
    return Promise.reject(new Error("当前已经使用这个主题目录，无需迁移"));
  }
  if (
    target.toLowerCase().startsWith(`${MOCK_DATA_ROOT.toLowerCase()}\\`) &&
    !sameMockPath(target, MOCK_DEFAULT_THEMES_DIR)
  ) {
    return Promise.reject(
      new Error("不能把主题目录设在数据目录内部（默认目录除外）：备份与清理会把它当成数据一起处理"),
    );
  }
  if (new URLSearchParams(window.location.search).has("mock-migrate-error")) {
    return Promise.reject(new Error("目标目录里已经有同名主题，为避免覆盖不会迁移（模拟）"));
  }

  const userThemes = MOCK_THEMES.filter((theme) => !theme.is_built_in);
  const fileCount = userThemes.reduce((sum, theme) => sum + theme.cursors.length, 0);
  return Promise.resolve({
    source: settings.effective_themes_dir,
    target,
    is_default: path === null,
    theme_count: userThemes.length,
    file_count: fileCount,
    total_bytes: fileCount * 4096,
    warnings: [],
  });
}

async function mockSetThemesDir(
  path: string | null,
  onProgress?: (progress: ThemesDirProgress) => void,
): Promise<ThemesDirChangeResult> {
  const plan = await mockPreviewThemesDir(path);
  const failMode = new URLSearchParams(window.location.search).get("mock-migrate-fail");
  const phases: ThemesDirProgress[] = [
    {
      phase: "copy",
      current: plan.file_count,
      total: plan.file_count,
      message: `正在复制主题文件（${plan.file_count}/${plan.file_count}）`,
    },
    { phase: "verify", current: 0, total: plan.theme_count, message: "正在校验复制结果…" },
    { phase: "switch", current: 0, total: 0, message: "正在切换到新目录…" },
    { phase: "registry", current: 0, total: 0, message: "正在重新绑定正在使用的主题…" },
    { phase: "settings", current: 0, total: 0, message: "正在保存设置…" },
    { phase: "cleanup", current: 0, total: 0, message: "正在清理原目录…" },
    { phase: "done", current: 0, total: 0, message: "迁移完成" },
  ];

  for (const phase of phases) {
    onProgress?.(phase);
    await delay(90);
    if (failMode === "settings" && phase.phase === "settings") {
      throw new Error("保存设置失败（模拟）；已回滚，原目录与设置均未改动");
    }
  }

  const next = mockSave({
    ...mockSettings(),
    themes_dir: path,
    effective_themes_dir: plan.target,
  });
  return {
    settings: next,
    report: {
      source: plan.source,
      target: plan.target,
      theme_count: plan.theme_count,
      file_count: plan.file_count,
      total_bytes: plan.total_bytes,
      rebound_slots: 0,
      warnings: plan.warnings,
    },
  };
}

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
  if (!inTauri) return Promise.resolve(mockBackupContent());
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
  if (!inTauri) {
    return { themes_added: 0, themes_skipped: 0, history_added: 0, warnings: [] };
  }

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
  if (!inTauri) return Promise.resolve([...mockBackups]);
  return invoke<BackupEntry[]>("list_backups");
}

/** 删除一个应用内备份（只按文件名，后端拒绝越出 backups\ 的输入） */
export function deleteBackup(fileName: string): Promise<void> {
  if (!inTauri) {
    mockBackups = mockBackups.filter((entry) => entry.file_name !== fileName);
    return Promise.resolve();
  }
  return invoke<void>("delete_backup", { fileName });
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

// ---------------------------------------------------------------------------
// 开发模式备份模拟
// ---------------------------------------------------------------------------

const MOCK_BACKUPS_DIR = `${MOCK_DATA_ROOT}\\backups`;

/** 浏览器里的示例备份历史：内存数组，删除 / 新增只改内存 */
let mockBackups: BackupEntry[] = [
  {
    file_name: "cursorstudio-backup-20261026-093000.zip",
    path: `${MOCK_BACKUPS_DIR}\\cursorstudio-backup-20261026-093000.zip`,
    created_at: "2026-10-26 09:30",
    kind: "manual",
    themes: 2,
    files: 9,
    bytes: 1_234_567,
    status: "ok",
    error: null,
  },
  {
    file_name: "cursorstudio-backup-20261025-184500.zip",
    path: `${MOCK_BACKUPS_DIR}\\cursorstudio-backup-20261025-184500.zip`,
    created_at: "2026-10-25 18:45",
    kind: "manual",
    themes: 1,
    files: 5,
    bytes: 640_112,
    status: "ok",
    error: null,
  },
];

/** 浏览器里的备份内容：一套主题库里已有的（用于「已在主题库」）+ 一套只在备份里的 */
function mockBackupContent(): BackupThemeListing {
  const local = MOCK_THEMES.find((theme) => !theme.is_built_in);
  const themes = [...(local ? [local] : []), ...MOCK_ARCHIVED_THEMES].map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
    created_at: theme.created_at,
    updated_at: theme.updated_at,
    slots: theme.cursors.length,
    files: theme.cursors.length + 1,
    bytes: theme.cursors.length * 4096 + 512,
  }));
  return { themes, warnings: [] };
}

function mockRestoreThemeFromBackup(themeId: string): Promise<RestoreBackupThemeOutcome> {
  const source = MOCK_ARCHIVED_THEMES.find((theme) => theme.id === themeId);
  if (!source) {
    return Promise.reject(
      new Error("备份里没有这套主题，或它的 theme.json 已损坏（模拟）"),
    );
  }
  const theme = { ...source, cursors: source.cursors.map((slot) => ({ ...slot })) };
  if (!addMockTheme(theme)) {
    return Promise.reject(new Error("主题库里已有同 ID 的主题，无需从备份恢复（模拟）"));
  }
  return Promise.resolve({ theme, warnings: [] });
}

function mockStamp(offsetMinutes = 0): string {
  const now = new Date(Date.now() - offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function mockExportBackup(
  destPath: string | null,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ExportBackupSummary> {
  const userThemes = MOCK_THEMES.filter((theme) => !theme.is_built_in);
  const files = userThemes.reduce((sum, theme) => sum + theme.cursors.length, 0) + 1;
  onProgress?.({
    stage: "write",
    current: files,
    total: files,
    message: `正在打包主题（${userThemes.length}/${userThemes.length}）`,
  });
  await delay(120);
  const file_name = `cursorstudio-backup-${mockStamp()}.zip`;
  const saved_path =
    destPath ?? `${MOCK_BACKUPS_DIR}\\${file_name}`;
  if (destPath === null) {
    mockBackups = [
      {
        file_name,
        path: saved_path,
        created_at: new Date().toLocaleString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        kind: "manual",
        themes: userThemes.length,
        files,
        bytes: 1_048_576,
        status: "ok",
        error: null,
      },
      ...mockBackups,
    ];
  }
  onProgress?.({ stage: "done", current: files, total: files, message: "备份完成（开发模式）" });
  return {
    themes: userThemes.length,
    files,
    saved_path,
    bytes: 1_048_576,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// 开发模式自动备份模拟（决策 32）
// ---------------------------------------------------------------------------

const AUTO_BACKUP_PREFIX_MOCK = "cursorstudio-backup-auto-";

/** 从自动备份文件名里取出日期段（`YYYYMMDD`）；非自动备份返回 null */
function mockAutoBackupDate(fileName: string): string | null {
  if (!fileName.startsWith(AUTO_BACKUP_PREFIX_MOCK)) return null;
  return fileName.slice(AUTO_BACKUP_PREFIX_MOCK.length, AUTO_BACKUP_PREFIX_MOCK.length + 8);
}

function mockDayStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** 验收脚本用：`?mock-backup-old=N` 预置 N 份过去若干天的自动备份（只播种一次） */
let mockAutoOldSeeded = false;

function seedMockAutoBackups(): void {
  if (mockAutoOldSeeded) return;
  mockAutoOldSeeded = true;
  const count = Number(new URLSearchParams(window.location.search).get("mock-backup-old") ?? "0");
  if (!Number.isInteger(count) || count <= 0) return;
  const userThemes = MOCK_THEMES.filter((theme) => !theme.is_built_in);
  const files = userThemes.reduce((sum, theme) => sum + theme.cursors.length, 0) + 1;
  for (let index = 0; index < count; index += 1) {
    const day = new Date(Date.now() - (index + 1) * 86_400_000);
    const date = mockDayStamp(day);
    const file_name = `${AUTO_BACKUP_PREFIX_MOCK}${date}-080000.zip`;
    mockBackups = [
      {
        file_name,
        path: `${MOCK_BACKUPS_DIR}\\${file_name}`,
        created_at: new Date(day.getTime() + 8 * 3_600_000).toLocaleString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        kind: "auto",
        themes: userThemes.length,
        files,
        bytes: 512_000,
        status: "ok",
        error: null,
      },
      ...mockBackups,
    ];
  }
}

async function mockRunAutoBackup(keep: number): Promise<AutoBackupOutcome> {
  await delay(80);
  seedMockAutoBackups();

  const today = mockDayStamp(new Date());
  const hasToday = mockBackups.some((entry) => mockAutoBackupDate(entry.file_name) === today);
  let created: string | null = null;
  if (!hasToday) {
    const file_name = `cursorstudio-backup-auto-${mockStamp()}.zip`;
    const userThemes = MOCK_THEMES.filter((theme) => !theme.is_built_in);
    const files = userThemes.reduce((sum, theme) => sum + theme.cursors.length, 0) + 1;
    created = file_name;
    mockBackups = [
      {
        file_name,
        path: `${MOCK_BACKUPS_DIR}\\${file_name}`,
        created_at: new Date().toLocaleString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        kind: "auto",
        themes: userThemes.length,
        files,
        bytes: 1_048_576,
        status: "ok",
        error: null,
      },
      ...mockBackups,
    ];
  }

  // 清理过期：与 Rust prune 同一口径——按文件名时间戳新到旧排序（字典序即
  // 时间序），保 keep 份；不做会像 mtime 一样被"写入更晚的旧日期文件"骗过
  const keepCount = Math.max(1, Math.min(100, Math.trunc(keep) || 10));
  const autos = mockBackups
    .filter((entry) => mockAutoBackupDate(entry.file_name) !== null)
    .sort((left, right) => right.file_name.localeCompare(left.file_name));
  let pruned = 0;
  if (autos.length > keepCount) {
    const doomed = new Set(autos.slice(keepCount).map((entry) => entry.file_name));
    mockBackups = mockBackups.filter((entry) => !doomed.has(entry.file_name));
    pruned = doomed.size;
  }

  return { created: created !== null, skipped: created === null, file_name: created, pruned };
}
