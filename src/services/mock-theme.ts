import type {
  ActiveState,
  ApplyOutcome,
  BatchDeleteOutcome,
  DeleteOutcome,
  EmptyTrashOutcome,
  HistoryEntry,
  ImportReport,
  RestoreOutcome,
  SaveCurrentOutcome,
  ThemesResult,
  ThemeFileGap,
  TrashEntry,
  TrashListing,
  CursorTheme,
} from "@/types/theme";
import type { CursorPreview } from "@/types/cursor";
import type { DuplicateReport, TaskProgress } from "@/services/theme";
import { MOCK_RECENT, MOCK_THEMES } from "@/services/mock";

/**
 * 主题命令的开发模式实现（决策 50）
 *
 * `services/theme.ts` 只留命令签名与真实 invoke 路径；浏览器里没有文件系统
 * 与注册表，这一份内存实现负责让开发与 26 个浏览器验收脚本走完整条链路。
 * 与 Rust 的语义差异（无持久化、槽位数编造）都在各函数注释里说明。
 */

/** 是否运行在 Tauri 容器里；与 `services/theme.ts` 的 `inTauri` 同一判定 */
const inApp = "__TAURI_INTERNALS__" in window;

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
  if (inApp) return false;
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

if (!inApp) seedDevTrash();

export function mockGetAllThemes(): Promise<ThemesResult> {
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

/** 浏览器里的查重模拟：`?mock-duplicates=1` 时把前两套「我的主题」编成一组 */
export function mockFindDuplicateThemes(): DuplicateReport {
  const mine = MOCK_THEMES.filter((theme) => !theme.is_built_in);
  if (new URLSearchParams(window.location.search).get("mock-duplicates") === "1" && mine.length >= 2) {
    const [first, second] = mine;
    return {
      groups: [
        {
          theme_ids: [first.id, second.id],
          theme_names: [first.name, second.name],
          bytes: 1_887_436,
          slots_filled: 4,
        },
      ],
      scanned: mine.length,
      skipped_missing: 0,
      wasted_bytes: 1_887_436,
      warnings: [],
    };
  }
  return { groups: [], scanned: mine.length, skipped_missing: 0, wasted_bytes: 0, warnings: [] };
}

export function mockGetActiveState(): Promise<ActiveState> {
  return Promise.resolve(devCurrentState());
}

export function mockGetCursorPreview(_filePath: string): Promise<CursorPreview | null> {
  return Promise.resolve(null);
}

export function mockApplyTheme(theme: CursorTheme): Promise<ApplyOutcome> {
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

export function mockRestoreDefault(): Promise<void> {
  console.warn("[dev] 非 Tauri 环境，跳过恢复默认");
  devActive.id = null;
  devActive.external = false;
  return Promise.resolve();
}

export function mockSaveCurrentTheme(): Promise<SaveCurrentOutcome> {
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

export async function mockImportTheme(
  sourcePath: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ImportReport> {
  // 浏览器里没有文件系统：用示例槽位生成一份新主题，
  // 让「导入 → 列表新增 → 检查器选中」这条链路在开发与自动化验收里能走通。
  // 名称取自文件名（含 zip/theme 后缀也兜得住），与后端「文件名 stem 作主题名」的口径一致
  const fileName = sourcePath.split(/[\\/]/).pop() ?? "theme.zip";
  const name =
    fileName.replace(/\.(zip|theme|themepack)$/i, "") || "未命名主题";
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
    duplicate_of: null,
  };
}

export function mockDeleteTheme(themeId: string): Promise<DeleteOutcome> {
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

export async function mockDeleteThemes(
  themeIds: string[],
  onProgress?: (progress: TaskProgress) => void,
): Promise<BatchDeleteOutcome> {
  const unique = [...new Set(themeIds)];
  const deleted: string[] = [];
  const failed: BatchDeleteOutcome["failed"] = [];
  for (const [index, themeId] of unique.entries()) {
    onProgress?.({
      stage: "delete",
      current: index + 1,
      total: unique.length,
      message: "正在移入回收站",
    });
    try {
      await mockDeleteTheme(themeId);
      deleted.push(themeId);
    } catch (err) {
      failed.push({
        theme_id: themeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { deleted, failed, auto_purged: 0, warning: null };
}

export function mockListTrash(): Promise<TrashListing> {
  const entries = [...devTrash.values()]
    .map((item) => item.entry)
    .sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
  return Promise.resolve({
    entries,
    max_entries: 20,
    max_bytes: 512 * 1024 * 1024,
  });
}

export function mockRestoreFromTrash(entryId: string): Promise<RestoreOutcome> {
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

export function mockDeleteFromTrash(entryId: string): Promise<void> {
  devTrash.delete(entryId);
  return Promise.resolve();
}

export function mockEmptyTrash(): Promise<EmptyTrashOutcome> {
  const removed = devTrash.size;
  devTrash.clear();
  return Promise.resolve({ removed, failed: [] });
}

export function mockRenameTheme(theme: CursorTheme, newName: string): Promise<CursorTheme> {
  return Promise.resolve({ ...theme, name: newName });
}

export function mockExportTheme(_theme: CursorTheme, _destPath: string): Promise<never> {
  return Promise.reject(new Error("浏览器环境不支持导出，请在桌面应用中使用"));
}

/** 浏览器里演示用的数据目录路径（真实路径只有 Rust 侧知道，前端禁止自行拼接） */
export const MOCK_DATA_DIR = "C:\\Users\\demo\\AppData\\Local\\CursorStudio";

/** 浏览器里的批量导出模拟：导出「已导入的 mock 主题」，数量随内存数据走 */
export function mockExportAllThemes(destDir: string) {
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

export function mockClearHistory(): Promise<number> {
  const count = devRecent.length;
  devRecent.splice(0, devRecent.length);
  return Promise.resolve(count);
}

export function mockGetDataDir(): Promise<string> {
  return Promise.resolve(MOCK_DATA_DIR);
}

export function mockOpenDataDir(): Promise<string> {
  console.warn("[dev] 非 Tauri 环境，跳过打开系统目录");
  return Promise.resolve(MOCK_DATA_DIR);
}
