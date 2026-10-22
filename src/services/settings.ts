import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "@/services/theme";

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

/** 更换主题存储目录（null = 回默认）；现有主题由 Rust 一起搬过去 */
export function setThemesDir(path: string | null): Promise<SettingsSnapshot> {
  if (!inTauri) {
    const settings = mockSettings();
    return Promise.resolve(
      mockSave({
        ...settings,
        themes_dir: path,
        effective_themes_dir: path ?? MOCK_DEFAULT.effective_themes_dir,
      }),
    );
  }
  return invoke<SettingsSnapshot>("set_themes_dir", { path });
}

/** 导出备份的结果 */
export interface ExportBackupSummary {
  themes: number;
  files: number;
}

/** 恢复备份的结果（合并语义：只补回缺失的） */
export interface ImportBackupSummary {
  themes_added: number;
  themes_skipped: number;
  history_added: number;
}

/** 导出全部主题与使用记录为备份 zip */
export function exportBackup(destPath: string): Promise<ExportBackupSummary> {
  if (!inTauri) return Promise.resolve({ themes: 0, files: 0 });
  return invoke<ExportBackupSummary>("export_backup", { destPath });
}

/** 从备份 zip 合并恢复 */
export function importBackup(zipPath: string): Promise<ImportBackupSummary> {
  if (!inTauri) {
    return Promise.resolve({ themes_added: 0, themes_skipped: 0, history_added: 0 });
  }
  return invoke<ImportBackupSummary>("import_backup", { zipPath });
}
