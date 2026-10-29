import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  ActiveState,
  ApplyOutcome,
  CursorTheme,
  DeleteOutcome,
  EmptyTrashOutcome,
  HistoryEntry,
  ImportReport,
  RestoreOutcome,
  SaveCurrentOutcome,
  ThemeFileGap,
  ThemesResult,
  TrashEntry,
  TrashListing,
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
function stampAt(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function stamp(): string {
  return stampAt(new Date());
}

function stampMinutesAgo(minutes: number): string {
  return stampAt(new Date(Date.now() - minutes * 60_000));
}

/** 浏览器里没有 history.json，用内存数组模拟，方便开发时走通「最近使用」 */
let devRecent: HistoryEntry[] = [...MOCK_RECENT];

/**
 * 浏览器里模拟「已导入主题」的内存数组（最新在前）
 *
 * mock 的 `importTheme` 落在这里，让批量导入中心跑完后的 `loadThemes()`
 * 也能读到新主题——真机上这一步是从磁盘读回，语义一致。
 */
let devThemes: CursorTheme[] = [];

/**
 * 仅开发模式：备份恢复 mock 把主题补进内存主题库
 *
 * 真机上由 Rust 落盘后 `loadThemes` 读回；这里保持同样的「恢复 → 重读列表」
 * 语义，避免备份弹窗只能靠本地状态假装成功。已存在的 ID 不重复加入。
 */
export function addMockTheme(theme: CursorTheme): boolean {
  if (inTauri) return false;
  if (MOCK_THEMES.some((item) => item.id === theme.id)) return false;
  if (devThemes.some((item) => item.id === theme.id)) return false;
  devThemes = [theme, ...devThemes];
  return true;
}

/**
 * 浏览器里模拟的「当前使用」状态（决策 24）
 *
 * 真机上它由注册表反推；mock 里由 apply / restore 维护，
 * 让聚焦重查（refreshActive）在开发与自动化验收中不把状态冲掉。
 */
const devActive: { id: string | null; external: boolean } = {
  id: null,
  // 开发用开关：?mock-external=1 从「被外部改写」态起步，方便目验与验收；
  // 应用 / 还原 / 保存当前光标后会被收编为普通状态。
  external: new URLSearchParams(window.location.search).has("mock-external"),
};

/**
 * 浏览器里模拟的「文件缺口」清单（决策 31）
 *
 * 开发用开关：`?mock-broken-files=1` 把示例里第一套导入主题标记成
 * 「缺 2 个文件」，方便目验与验收（真机上由后端 stat 每个槽位文件得出）。
 */
const mockBrokenFiles = new URLSearchParams(window.location.search).has("mock-broken-files");

function devFileGaps(): ThemeFileGap[] {
  if (!mockBrokenFiles) return [];
  const target = MOCK_THEMES.find((theme) => !theme.is_built_in);
  if (!target || target.cursors.length === 0) return [];
  return [
    {
      theme_id: target.id,
      slots: target.cursors.slice(0, 2).map((slot) => slot.registry_key),
    },
  ];
}

/** 浏览器里的当前光标三态：外部改写优先，其次使用中，最后系统默认 */
function devCurrentState() {
  return {
    active_theme_id: devActive.external ? null : devActive.id,
    current_slots_filled: devActive.external ? 13 : devActive.id ? 15 : 0,
    active_external: devActive.external,
  };
}

/**
 * 浏览器里被「删除」的 mock 主题 ID
 *
 * MOCK_THEMES 是常量列表；删除后再 `getAllThemes`（例如回收站恢复后刷新）
 * 不能让它复活，所以用一份隐藏集合表达「已从主题库移走」。
 */
const devHiddenThemeIds = new Set<string>();

/** 浏览器里模拟的回收站：条目 + 恢复所需的完整主题对象 */
const devTrash = new Map<string, { entry: TrashEntry; theme: CursorTheme }>();

/** 回收站示例数据：给「设置 → 数据 → 回收站」在浏览器里两行可视内容 */
function seedDevTrash() {
  const sources = MOCK_THEMES.filter((theme) => !theme.is_built_in);
  const samples = [
    { source: sources[0], name: "像素小队（示例）", minutesAgo: 45 },
    { source: sources[1], name: "旧日黑白（示例）", minutesAgo: 26 * 60 },
  ].filter((sample) => Boolean(sample.source));

  for (const sample of samples) {
    const theme: CursorTheme = {
      ...sample.source,
      id: crypto.randomUUID(),
      name: sample.name,
      is_built_in: false,
      cursors: sample.source.cursors.map((slot) => ({ ...slot })),
    };
    const entry: TrashEntry = {
      id: crypto.randomUUID(),
      theme_id: theme.id,
      name: theme.name,
      deleted_at: stampMinutesAgo(sample.minutesAgo),
      slot_count: theme.cursors.length,
      bytes: theme.cursors.length * 4096 + 512,
      status: "ok",
      error: null,
    };
    devTrash.set(entry.id, { entry, theme });
  }

  // 开发用开关：?mock-trash-damaged 让第一行进入「记录损坏」态，方便目验
  if (new URLSearchParams(window.location.search).has("mock-trash-damaged")) {
    const first = devTrash.values().next().value;
    if (first) {
      first.entry.status = "damaged";
      first.entry.error = "回收站记录不是有效 JSON（模拟）";
    }
  }
}

if (!inTauri) seedDevTrash();

/** 对应 Rust 命令 `get_all_themes`；数据源独立容错，失败项进 warnings 而非整体报错 */
export function getAllThemes(): Promise<ThemesResult> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，使用示例数据");
    // 开发用开关：?mock-fail 让「整体加载失败」这条分支能被真正走一遍
    //（正常情况下浏览器永远拿到示例数据，错误态没机会出现，也就没法验收）
    if (new URLSearchParams(window.location.search).has("mock-fail")) {
      return Promise.reject(new Error("读取光标方案被拒绝（EACCES，模拟）"));
    }
    // 浏览器里读不到注册表，用 mock 状态回填（槽位数编一个自洽的）
    return Promise.resolve({
      themes: [
        ...devThemes,
        ...MOCK_THEMES.filter((theme) => !devHiddenThemeIds.has(theme.id)),
      ],
      warnings: [],
      ...devCurrentState(),
      recent: devRecent,
      file_gaps: devFileGaps(),
    });
  }
  return invoke<ThemesResult>("get_all_themes");
}

/** 对应 Rust 命令 `get_active_state`：聚焦时轻量重查「当前使用」（决策 24） */
export function getActiveState(): Promise<ActiveState> {
  if (!inTauri) {
    return Promise.resolve(devCurrentState());
  }
  return invoke<ActiveState>("get_active_state");
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
    devActive.id = theme.id;
    devActive.external = false;
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
    devActive.id = null;
    devActive.external = false;
    return Promise.resolve();
  }
  return invoke<void>("restore_default");
}

/**
 * 对应 Rust 命令 `save_current_theme`：把外部改写态的光标收编为我的主题
 *
 * 浏览器里没有注册表，用一份完整示例主题模拟；保存后当前主题切换为它。
 */
export function saveCurrentTheme(): Promise<SaveCurrentOutcome> {
  if (!inTauri) {
    if (!devActive.external) {
      return Promise.reject(new Error("当前光标已经是已知主题或系统默认，无需再保存"));
    }
    console.warn("[dev] 浏览器环境：当前光标保存为内存主题");
    const now = stamp();
    const source = MOCK_THEMES[0];
    const theme: CursorTheme = {
      ...source,
      id: crypto.randomUUID(),
      name: `当前光标 ${now}`,
      is_built_in: false,
      created_at: now,
      updated_at: now,
      cursors: source.cursors.map((slot) => ({ ...slot })),
    };
    devThemes = [theme, ...devThemes];
    devActive.id = theme.id;
    devActive.external = false;
    devRecent = [
      {
        theme_id: theme.id,
        name: theme.name,
        is_built_in: false,
        applied_at: now,
      },
      ...devRecent,
    ].slice(0, 50);
    return Promise.resolve({
      theme,
      warnings: [],
      file_count: theme.cursors.length,
      applied: true,
      recent: devRecent,
      warning: null,
    });
  }
  return invoke<SaveCurrentOutcome>("save_current_theme");
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
    const theme: CursorTheme = {
      id: crypto.randomUUID(),
      name,
      description: `导入自 ${fileName}`,
      created_at: now,
      updated_at: now,
      is_built_in: false,
      cursors: sample.cursors,
    };
    // 落进 mock 的「磁盘」：之后的 getAllThemes（重读列表）也能看到它
    devThemes = [theme, ...devThemes];
    return {
      theme,
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

/** 对应 Rust 命令 `delete_theme`：主题移入回收站（软删除，决策 26） */
export function deleteTheme(themeId: string): Promise<DeleteOutcome> {
  if (!inTauri) {
    console.warn("[dev] 浏览器环境：主题移入内存回收站");
    const theme = [...devThemes, ...MOCK_THEMES].find((item) => item.id === themeId);
    if (theme) {
      const entry: TrashEntry = {
        id: crypto.randomUUID(),
        theme_id: theme.id,
        name: theme.name,
        deleted_at: stamp(),
        slot_count: theme.cursors.length,
        bytes: theme.cursors.length * 4096 + 512,
        status: "ok",
        error: null,
      };
      devTrash.set(entry.id, { entry, theme });
      if (MOCK_THEMES.some((item) => item.id === themeId)) {
        devHiddenThemeIds.add(themeId);
      } else {
        devThemes = devThemes.filter((item) => item.id !== themeId);
      }
    }
    return Promise.resolve({ auto_purged: 0, warning: null });
  }
  return invoke<DeleteOutcome>("delete_theme", { themeId });
}

/** 对应 Rust 命令 `list_trash`：列出回收站与当前限额 */
export function listTrash(): Promise<TrashListing> {
  if (!inTauri) {
    const entries = [...devTrash.values()]
      .map((item) => item.entry)
      .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
    return Promise.resolve({
      entries,
      max_entries: 20,
      max_bytes: 512 * 1024 * 1024,
    });
  }
  return invoke<TrashListing>("list_trash");
}

/** 对应 Rust 命令 `restore_from_trash`：把主题搬回当前主题目录 */
export function restoreFromTrash(entryId: string): Promise<RestoreOutcome> {
  if (!inTauri) {
    const found = devTrash.get(entryId);
    if (!found) {
      return Promise.reject(new Error("回收站里没有这个条目，可能已被清理"));
    }
    if (found.entry.status !== "ok") {
      return Promise.reject(new Error("回收站记录已损坏，无法恢复"));
    }
    devTrash.delete(entryId);
    // 删除时藏起来的 mock 主题：取消隐藏即可原样回来；导入过的主题则重新加入列表
    if (!devHiddenThemeIds.delete(found.theme.id)) {
      devThemes = [found.theme, ...devThemes];
    }
    return Promise.resolve({ warning: null });
  }
  return invoke<RestoreOutcome>("restore_from_trash", { entryId });
}

/** 对应 Rust 命令 `delete_from_trash`：彻底删除一个条目 */
export function deleteFromTrash(entryId: string): Promise<void> {
  if (!inTauri) {
    devTrash.delete(entryId);
    return Promise.resolve();
  }
  return invoke<void>("delete_from_trash", { entryId });
}

/** 对应 Rust 命令 `empty_trash`：清空回收站 */
export function emptyTrash(): Promise<EmptyTrashOutcome> {
  if (!inTauri) {
    const removed = devTrash.size;
    devTrash.clear();
    return Promise.resolve({ removed, failed: [] });
  }
  return invoke<EmptyTrashOutcome>("empty_trash");
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
  if (!inTauri) return mockExportAll(destDir);

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
  if (!inTauri) {
    const count = devRecent.length;
    devRecent.splice(0, devRecent.length);
    return Promise.resolve(count);
  }
  return invoke<number>("clear_history");
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

/** 浏览器里的批量导出模拟：导出「已导入的 mock 主题」，数量随内存数据走 */
function mockExportAll(destDir: string): Promise<ExportAllOutcome> {
  const mine = devThemes.filter((theme) => !theme.is_built_in);
  const exported = mine.map((theme, index) => ({
    theme_id: theme.id,
    name: theme.name,
    file_name: `${theme.name}.zip`,
    bytes: 180_000 + index * 45_123,
    file_count: theme.cursors.length,
  }));
  return Promise.resolve({
    dir: destDir || `${MOCK_DATA_DIR}\\exports`,
    exported,
    failed: [],
    total_bytes: exported.reduce((sum, item) => sum + item.bytes, 0),
    warnings: [],
  });
}
