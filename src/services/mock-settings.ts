import type { CursorTheme } from "@/types/theme";
import type { TaskProgress } from "@/services/theme";
import { addMockTheme } from "@/services/mock-theme";
import { MOCK_ARCHIVED_THEMES, MOCK_THEMES } from "@/services/mock";
import type {
  AutoBackupOutcome,
  AutostartStatus,
  BackupEntry,
  BackupThemeListing,
  BackupVerifyReport,
  ExportBackupSummary,
  RestoreBackupThemeOutcome,
  SettingsSnapshot,
  StorageStats,
  ThemesDirChangeResult,
  ThemesDirPlan,
  ThemesDirProgress,
} from "@/services/settings";

/**
 * 行为设置与备份命令的开发模式实现（决策 50）
 *
 * `services/settings.ts` 只留命令签名与真实 invoke 路径；浏览器里没有
 * settings.json / 注册表 / zip，这一份实现负责让设计验收与浏览器脚本拿到
 * 与真机同构的行为：开关走 localStorage 持久化、迁移与备份走内存态与
 * 定时节奏模拟，`?mock-*` 开关与真机故障形态一一对应。
 */

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

export function mockGetSettings(): SettingsSnapshot {
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

export function mockUpdateSettings(patch: Partial<SettingsSnapshot>): SettingsSnapshot {
  // 对齐后端语义：主题 ID 补丁的空串 = 清空（Rust 侧 normalize_theme_id）
  const merged = { ...mockGetSettings(), ...patch };
  return mockSave({
    ...merged,
    auto_switch_light_id: merged.auto_switch_light_id || null,
    auto_switch_dark_id: merged.auto_switch_dark_id || null,
    schedule_in_id: merged.schedule_in_id || null,
    schedule_out_id: merged.schedule_out_id || null,
  });
}

export function mockGetAutostart(): AutostartStatus {
  try {
    const enabled = localStorage.getItem("cursorstudio.autostart") === "1";
    return { enabled, exe_path: enabled ? MOCK_EXE : "" };
  } catch {
    return { enabled: false, exe_path: "" };
  }
}

export function mockSetAutostart(enable: boolean): AutostartStatus {
  try {
    localStorage.setItem("cursorstudio.autostart", enable ? "1" : "0");
  } catch {
    /* 同上 */
  }
  return mockGetAutostart();
}

// ---------------------------------------------------------------------------
// 主题存储目录迁移模拟
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

export function mockPreviewThemesDir(path: string | null): Promise<ThemesDirPlan> {
  const settings = mockGetSettings();
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

export async function mockSetThemesDir(
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
    ...mockGetSettings(),
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

// ---------------------------------------------------------------------------
// 备份历史模拟
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
export function mockListBackupThemes(): BackupThemeListing {
  const local = MOCK_THEMES.find((theme) => !theme.is_built_in);
  const partialId = new URLSearchParams(window.location.search).has("mock-backup-partial")
    ? MOCK_ARCHIVED_THEMES[0]?.id
    : null;
  const themes = [...(local ? [local] : []), ...MOCK_ARCHIVED_THEMES].map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
    created_at: theme.created_at,
    updated_at: theme.updated_at,
    slots: theme.cursors.length,
    files: theme.cursors.length + 1,
    bytes: theme.cursors.length * 4096 + 512,
    missing_files: theme.id === partialId ? 1 : 0,
  }));
  return { themes, warnings: [] };
}

export function mockRestoreThemeFromBackup(themeId: string): Promise<RestoreBackupThemeOutcome> {
  const source = MOCK_ARCHIVED_THEMES.find((theme) => theme.id === themeId);
  if (!source) {
    return Promise.reject(
      new Error("备份里没有这套主题，或它的 theme.json 已损坏（模拟）"),
    );
  }
  const theme: CursorTheme = { ...source, cursors: source.cursors.map((slot) => ({ ...slot })) };
  if (!addMockTheme(theme)) {
    return Promise.reject(new Error("主题库里已有同 ID 的主题，无需从备份恢复（模拟）"));
  }
  const partial = new URLSearchParams(window.location.search).has("mock-backup-partial");
  return Promise.resolve({
    theme,
    warnings: partial
      ? ["恢复后的主题有 1 个槽位文件缺失（忙），应用时这些槽位会被写成空"]
      : [],
  });
}

function mockStamp(offsetMinutes = 0): string {
  const now = new Date(Date.now() - offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function mockExportBackup(
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

export function mockImportBackup() {
  return { themes_added: 0, themes_skipped: 0, history_added: 0, warnings: [] };
}

export function mockListBackups(): BackupEntry[] {
  return [...mockBackups];
}

export function mockDeleteBackup(fileName: string): void {
  mockBackups = mockBackups.filter((entry) => entry.file_name !== fileName);
}

// ---------------------------------------------------------------------------
// 自动备份模拟（决策 32）
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

export async function mockRunAutoBackup(keep: number): Promise<AutoBackupOutcome> {
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

// ---------------------------------------------------------------------------
// 存储统计与备份体检模拟
// ---------------------------------------------------------------------------

/** 浏览器里的存储占用模拟：备份区随 mockBackups 走，其余编一个自洽的量级 */
export function mockGetStorageStats(): StorageStats {
  const backupsBytes = mockBackups.reduce((sum, entry) => sum + entry.bytes, 0);
  const themes = MOCK_THEMES.filter((theme) => !theme.is_built_in);
  const themeBytes = 28_400_000;
  const trashBytes = 18_700_000;
  return {
    themes: { count: themes.length, bytes: themeBytes },
    backups: { count: mockBackups.length, bytes: backupsBytes },
    trash: { count: 2, bytes: trashBytes },
    history_bytes: 38_400,
    settings_bytes: 1_120,
    total_bytes: themeBytes + backupsBytes + trashBytes + 38_400 + 1_120,
  };
}

/** 浏览器里的备份体检模拟（决策 37）：`?mock-backup-corrupt=1` 时手动备份报两处 CRC 损坏 */
export function mockVerifyBackup(fileName: string): BackupVerifyReport {
  const entry = mockBackups.find((backup) => backup.file_name === fileName);
  const corruptMode =
    new URLSearchParams(window.location.search).get("mock-backup-corrupt") === "1";
  if (corruptMode && entry?.kind === "manual") {
    return {
      file_name: fileName,
      entries_checked: entry.files,
      bytes: entry.bytes,
      corrupt: [
        "themes/8f2a1c32-55e0-4b8e-9d1a-2f0c33aa87e1/cursors/arrow.cur（Invalid checksum）",
        "themes/8f2a1c32-55e0-4b8e-9d1a-2f0c33aa87e1/theme.json（Invalid checksum）",
      ],
      corrupt_total: 2,
    };
  }
  return {
    file_name: fileName,
    entries_checked: entry?.files ?? 0,
    bytes: entry?.bytes ?? 0,
    corrupt: [],
    corrupt_total: 0,
  };
}
