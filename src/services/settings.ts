import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { inTauri, type TaskProgress } from "@/services/theme";
import { MOCK_THEMES } from "@/services/mock";

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
}

/** 开机自启动状态 */
export interface AutostartStatus {
  enabled: boolean;
  /** 注册后命令指向的程序路径 */
  exe_path: string;
}

/** update_settings 的可选补丁：只传要改的字段 */
export interface SettingsPatch {
  close_behavior?: CloseBehavior;
  auto_check_update?: boolean;
  shortcuts_enabled?: boolean;
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
    return {
      enabled: localStorage.getItem("cursorstudio.autostart") === "1",
      exe_path: MOCK_EXE,
    };
  } catch {
    return { enabled: false, exe_path: MOCK_EXE };
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
    return Promise.resolve(mockSave({ ...mockSettings(), ...patch }));
  }
  return invoke<SettingsSnapshot>("update_settings", {
    closeBehavior: patch.close_behavior,
    autoCheckUpdate: patch.auto_check_update,
    shortcutsEnabled: patch.shortcuts_enabled,
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
  warnings: string[];
}

/** 恢复备份的结果（合并语义：只补回缺失的） */
export interface ImportBackupSummary {
  themes_added: number;
  themes_skipped: number;
  history_added: number;
  warnings: string[];
}

/** 导出全部主题与使用记录为备份 zip；进度来自 `backup-progress` 事件 */
export async function exportBackup(
  destPath: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ExportBackupSummary> {
  if (!inTauri) return { themes: 0, files: 0, warnings: [] };

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
