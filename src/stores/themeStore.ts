import { create } from "zustand";

import {
  applyTheme as apiApplyTheme,
  deleteTheme as apiDeleteTheme,
  exportTheme as apiExportTheme,
  getActiveState,
  getAllThemes,
  getDataDir as apiGetDataDir,
  importTheme as apiImportTheme,
  inTauri,
  openDataDir as apiOpenDataDir,
  renameTheme as apiRenameTheme,
  restoreDefault as apiRestoreDefault,
  restoreFromTrash as apiRestoreFromTrash,
  type TaskProgress,
} from "@/services/theme";
import { readableError, toast } from "@/lib/toast";
import type { Page } from "@/lib/pages";
import type { SettingsSection } from "@/lib/settings-sections";
import {
  getZipMenuStatus as apiGetZipMenuStatus,
  openMousePanel as apiOpenMousePanel,
  setZipMenu as apiSetZipMenu,
  takePendingImport as apiTakePendingImport,
  type ZipMenuStatus,
} from "@/services/system";
import type { CursorTheme, HistoryEntry, TrashEntry } from "@/types/theme";

/**
 * 每页各记一份选中项：切页回来还是原来的上下文，又不会把别的页的选择带过来
 *
 * 用 `Partial` 而不是 `Record`：不是每一页都需要"选中的主题"——
 * 未来市场页选的是远程条目、编辑器页根本不选，硬给所有页面预留一个槽位
 * 只会让它们互相污染。页面自己不写这个键，就等于没有选中。
 */
type Selection = Partial<Record<Page, string | null>>;

const NO_SELECTION: Selection = {};

/** 重载后清掉已不存在的主题：还在列表里的选择要留着，那是用户上次的上下文 */
function pruneSelection(selection: Selection, ids: Set<string>): Selection {
  return Object.fromEntries(
    Object.entries(selection).map(([page, id]) => [page, id && ids.has(id) ? id : null]),
  );
}

/** 删除某主题后，任何一个页面的选择指向它都要清掉，否则检查器会挂着空 ID */
function clearSelection(selection: Selection, removedId: string): Selection {
  return Object.fromEntries(
    Object.entries(selection).map(([page, id]) => [page, id === removedId ? null : id]),
  );
}

/** 单个动作的忙碌键：`apply:<id>` / `delete:<id>` / `rename:<id>` / `export:<id>` */
export function actionBusyKey(action: string, id: string): string {
  return `${action}:${id}`;
}

function withBusyFlag(
  busy: Record<string, boolean>,
  key: string,
  value: boolean,
): Record<string, boolean> {
  if (value) return { ...busy, [key]: true };
  const next = { ...busy };
  delete next[key];
  return next;
}

interface ThemeStore {
  /** 所有主题 */
  themes: CursorTheme[];
  /** 当前系统正在使用的主题 ID */
  activeThemeId: string | null;
  /**
   * 光标被系统设置 / 其它工具改写（槽位非空但匹配不到任何主题，决策 24）
   *
   * 系统指针样式页随时可能整体改写注册表；没有这个标志，界面只能把
   * 这种状态误报成「系统默认」。
   */
  activeExternal: boolean;
  /** 注册表当前非空槽位数（诊断信息用；0 = 系统默认） */
  currentSlotsFilled: number;
  /** 最近主题，最新在前（后端由事件流派生，每个主题一条） */
  recent: HistoryEntry[];
  /** 每个页面各自选中的主题 ID；`recent` 页没有检查器，恒为 null */
  selection: Selection;
  /** 搜索关键词（切页清空，见 setCurrentPage） */
  searchQuery: string;
  /** 当前页面 */
  currentPage: Page;
  /** 设置页当前分组（进设置后侧栏按它切换内容页） */
  settingsSection: SettingsSection;
  /** 从哪个页面进的设置：「返回」回到那里，而不是硬编码回图库 */
  previousPage: Page | null;
  /** 加载状态（只用于"首次加载/重载"，导入有自己的 importing） */
  loading: boolean;
  /** 导入进行中：不复用 loading，否则导入时整个列表会变成骨架 */
  importing: boolean;
  /** 导入进度（解压 / 落盘阶段的人话说明）；null = 没有进行中的导入 */
  importProgress: TaskProgress | null;
  /**
   * 按动作区分的忙碌状态：键见 `actionBusyKey`
   *
   * 不能用一个全局 `busy`：同时点两行删除时，第二行不该因为第一行在跑而变灰。
   */
  busy: Record<string, boolean>;
  /** 整体加载失败；null = 正常。与 warnings（部分失败）是两回事 */
  loadError: string | null;
  /** 没能读到的数据源（部分成功时非空），展示为页面顶部的一条提示 */
  warnings: string[];
  /** 用户主动关掉了提示条；重新加载会复位 */
  warningsDismissed: boolean;
  /** 数据目录展示路径（设置页用）；null = 还没读到 */
  dataDir: string | null;
  /** 数据目录读取失败原因；null = 没有失败。设置页据此显示「读取失败 + 重试」 */
  dataDirError: string | null;
  /** `.zip` 右键菜单注册状态；null = 还没读到 */
  zipMenu: ZipMenuStatus | null;
  /** 右键菜单状态读取失败（典型原因：前端新、Rust 旧，重启应用即恢复） */
  zipMenuError: boolean;

  loadThemes: () => Promise<void>;
  /** 窗口聚焦时轻量重查「当前使用」：注册表可能已被系统设置改写（决策 24） */
  refreshActive: () => Promise<void>;
  applyTheme: (id: string) => Promise<void>;
  restoreDefault: () => Promise<void>;
  importTheme: (sourcePath: string) => Promise<void>;
  /** 返回是否真的删掉了；确认对话框据此决定关不关 */
  deleteTheme: (id: string) => Promise<boolean>;
  /** 从回收站恢复；成功后重读主题列表，并把恢复的主题选在图库与我的主题里 */
  restoreTrashEntry: (entry: TrashEntry) => Promise<boolean>;
  renameTheme: (id: string, newName: string) => Promise<void>;
  exportTheme: (id: string, destPath: string) => Promise<void>;
  /** 读一次数据目录路径（幂等，拿到就不再请求） */
  loadDataDir: () => Promise<void>;
  /** 在系统文件管理器打开数据目录 */
  openDataDir: () => Promise<void>;
  /** 打开经典「鼠标属性」面板（指针选项卡） */
  openMousePanel: () => Promise<void>;
  /** 读一次 `.zip` 右键菜单注册状态（幂等） */
  loadZipMenuStatus: () => Promise<void>;
  /** 注册 / 移除 `.zip` 右键菜单（试点，决策 12） */
  toggleZipMenu: () => Promise<void>;
  /** 领取待导入路径并走正常导入流程；没有就静默返回 */
  pickupPendingImport: () => Promise<void>;
  selectTheme: (id: string) => void;
  setSearchQuery: (q: string) => void;
  setCurrentPage: (p: Page) => void;
  setSettingsSection: (s: SettingsSection) => void;
  /** 从设置返回进入前的页面（没有上下文就回图库） */
  backFromSettings: () => void;
  dismissWarnings: () => void;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  themes: [],
  activeThemeId: null,
  activeExternal: false,
  currentSlotsFilled: 0,
  recent: [],
  selection: NO_SELECTION,
  searchQuery: "",
  currentPage: "gallery",
  settingsSection: "general",
  previousPage: null,
  loading: false,
  importing: false,
  importProgress: null,
  busy: {},
  loadError: null,
  warnings: [],
  warningsDismissed: false,
  dataDir: null,
  dataDirError: null,
  zipMenu: null,
  zipMenuError: false,

  loadThemes: async () => {
    set({ loading: true, loadError: null });
    try {
      const { themes, warnings, active_theme_id, current_slots_filled, active_external, recent } =
        await getAllThemes();
      // 「正在使用」每次都由后端从注册表反推，不沿用内存旧值：
      // 内存状态一重开就过期，会把已应用的主题当成还能再应用一次。
      // recent 兜底：前端热更新、后端还是旧二进制时字段会缺失，
      // 让状态变成 undefined 会让「最近使用」页直接白屏。
      const ids = new Set(themes.map((theme) => theme.id));

      set((state) => ({
        themes,
        activeThemeId: active_theme_id,
        activeExternal: active_external ?? false,
        currentSlotsFilled: current_slots_filled ?? 0,
        recent: recent ?? [],
        warnings,
        warningsDismissed: false,
        // 只清掉「已经不存在的主题」，其余选择保留：
        // 重载后还戴着高亮的那个主题确实还在列表里，不该被当成脏状态丢掉
        selection: pruneSelection(state.selection, ids),
      }));

      // 部分来源失败仍能拿到其余主题：交给顶部提示条，不打断浏览
      if (warnings.length > 0) {
        for (const warn of warnings) console.warn("[loadThemes]", warn);
      }
    } catch (err) {
      console.error("加载主题失败：", err);
      // 不再只弹一条过几秒就消失的 Toast：整次读取失败时列表是空的，
      // 而空状态会写成"还没有可用的主题"——那是在骗人。改成常驻错误态 + 重试。
      set({ loadError: readableError(err) });
    } finally {
      set({ loading: false });
    }
  },

  // 只读注册表与主题清单，失败静默保留旧状态：聚焦很频繁，
  // 不能因为一次读取失败就弹提示打断用户
  refreshActive: async () => {
    try {
      const state = await getActiveState();
      set({
        activeThemeId: state.active_theme_id,
        activeExternal: state.active_external,
        currentSlotsFilled: state.current_slots_filled,
      });
    } catch (err) {
      console.warn("[refreshActive]", readableError(err));
    }
  },

  applyTheme: async (id) => {
    const theme = get().themes.find((t) => t.id === id);
    if (!theme) return;

    const key = actionBusyKey("apply", id);
    if (get().busy[key]) return;
    set((state) => ({ busy: withBusyFlag(state.busy, key, true) }));
    try {
      const outcome = await apiApplyTheme(theme);
      set({ activeThemeId: id, activeExternal: false, recent: outcome.recent });
      toast.success(
        `已应用「${theme.name}」`,
        inTauri ? "系统光标已切换" : "开发模式：未真正写入系统",
      );
      // 光标已经切了，这只是附属信息没记上：不能反过来报「应用失败」
      if (outcome.warning) {
        toast.warning("光标已切换，但没记入最近使用", outcome.warning);
      }
    } catch (err) {
      console.error("应用主题失败：", err);
      toast.error("应用失败", readableError(err));
    } finally {
      set((state) => ({ busy: withBusyFlag(state.busy, key, false) }));
    }
  },

  restoreDefault: async () => {
    const key = actionBusyKey("restore", "default");
    if (get().busy[key]) return;
    set((state) => ({ busy: withBusyFlag(state.busy, key, true) }));
    try {
      await apiRestoreDefault();
      set({ activeThemeId: null, activeExternal: false, currentSlotsFilled: 0 });
      toast.success(
        "已还原系统默认光标",
        inTauri ? undefined : "开发模式：未真正写入系统",
      );
    } catch (err) {
      console.error("恢复默认失败：", err);
      toast.error("还原失败", readableError(err));
    } finally {
      set((state) => ({ busy: withBusyFlag(state.busy, key, false) }));
    }
  },

  importTheme: async (sourcePath) => {
    // 用 importing 而不是 loading：导入是"往列表里加一条"，
    // 把列表换成骨架会让用户以为原来的主题没了
    set({ importing: true, importProgress: null });
    try {
      const { theme, warnings } = await apiImportTheme(sourcePath, (progress) =>
        set({ importProgress: progress }),
      );
      set((state) => ({
        themes: [theme, ...state.themes],
        // 留在当前页，但把新方案在「图库」和「我的主题」里都选中：
        // 无论用户此刻在哪一页，右侧都会立刻显示刚导入的东西
        selection: { ...state.selection, gallery: theme.id, mine: theme.id },
        // 有搜索词时新方案可能被过滤掉，清空免得「导入了却看不见」
        searchQuery: "",
        // 整体读取失败后仍能导入成功，说明数据目录还活着：
        // 有数据了再挂着「读取失败」的错误态是在骗人
        loadError: null,
      }));
      toast.success(`已导入「${theme.name}」`, `共 ${theme.cursors.length} 个光标槽位`);
      if (warnings.length > 0) {
        for (const warning of warnings) console.warn("[importTheme]", warning);
        toast.warning(
          "导入完成，但有内容被跳过",
          warnings.length > 1 ? `${warnings[0]}（共 ${warnings.length} 条）` : warnings[0],
        );
      }
    } catch (err) {
      console.error("导入主题失败：", err);
      toast.error("导入失败", readableError(err));
    } finally {
      set({ importing: false, importProgress: null });
    }
  },

  deleteTheme: async (id) => {
    const theme = get().themes.find((t) => t.id === id);
    if (!theme) return false;

    // 双保险：按钮已禁用，这里再挡一次，防止别处调用时误删正在使用的主题
    if (get().activeThemeId === id) {
      toast.error("不能删除正在使用的主题", "请先切换到其它主题，或还原系统默认");
      return false;
    }
    if (theme.is_built_in) {
      toast.error("系统自带方案不能删除");
      return false;
    }

    const key = actionBusyKey("delete", id);
    if (get().busy[key]) return false;
    set((state) => ({ busy: withBusyFlag(state.busy, key, true) }));
    try {
      // 前端热更新、后端还是旧二进制时返回值可能为空；删除结果以列表变更为准
      const outcome = (await apiDeleteTheme(id)) ?? { auto_purged: 0, warning: null };
      set((state) => ({
        themes: state.themes.filter((t) => t.id !== id),
        // 所有页面的选择都要清，不然检查器会挂着一个已经不存在的 ID
        selection: clearSelection(state.selection, id),
      }));
      const hints = ["可在 设置 → 数据 → 回收站 恢复"];
      if (outcome.auto_purged > 0) {
        hints.push(`回收站超出上限，已自动清理最早的 ${outcome.auto_purged} 套`);
      }
      toast.success(`已移入回收站「${theme.name}」`, hints.join("；"));
      if (outcome.warning) {
        toast.warning("主题已移入回收站，但收尾没完全成功", outcome.warning);
      }
      return true;
    } catch (err) {
      console.error("删除主题失败：", err);
      toast.error("删除失败", readableError(err));
      return false;
    } finally {
      set((state) => ({ busy: withBusyFlag(state.busy, key, false) }));
    }
  },

  restoreTrashEntry: async (entry) => {
    try {
      const outcome = (await apiRestoreFromTrash(entry.id)) ?? { warning: null };
      await get().loadThemes();
      // 恢复目标可能因为列表读取失败而不在本地列表里；只有确实回来了才选中
      if (get().themes.some((theme) => theme.id === entry.theme_id)) {
        set((state) => ({
          selection: {
            ...state.selection,
            gallery: entry.theme_id,
            mine: entry.theme_id,
          },
        }));
      }
      if (outcome.warning) {
        toast.warning(`已恢复「${entry.name}」`, outcome.warning);
      } else {
        toast.success(`已恢复「${entry.name}」`, "已重新出现在主题图库与我的主题里");
      }
      return true;
    } catch (err) {
      console.error("恢复主题失败：", err);
      toast.error("恢复失败", readableError(err));
      return false;
    }
  },

  renameTheme: async (id, newName) => {
    const theme = get().themes.find((t) => t.id === id);
    if (!theme) return;

    const name = newName.trim();
    if (!name || name === theme.name) return;

    if (theme.is_built_in) {
      toast.error("系统自带方案不能改名");
      return;
    }

    const key = actionBusyKey("rename", id);
    if (get().busy[key]) return;
    set((state) => ({ busy: withBusyFlag(state.busy, key, true) }));
    try {
      const updated = await apiRenameTheme(theme, name);
      set((state) => ({
        themes: state.themes.map((t) => (t.id === id ? updated : t)),
      }));
      // 正在使用的主题改名后，注册表里的 SchemeName 还是旧名，需重新应用才同步
      const hint =
        get().activeThemeId === id ? "系统设置里的方案名会在下次应用时更新" : undefined;
      toast.success(`已改名为「${updated.name}」`, hint);
    } catch (err) {
      console.error("改名失败：", err);
      toast.error("改名失败", readableError(err));
    } finally {
      set((state) => ({ busy: withBusyFlag(state.busy, key, false) }));
    }
  },

  exportTheme: async (id, destPath) => {
    const theme = get().themes.find((t) => t.id === id);
    if (!theme) return;

    const key = actionBusyKey("export", id);
    if (get().busy[key]) return;
    set((state) => ({ busy: withBusyFlag(state.busy, key, true) }));
    try {
      const summary = await apiExportTheme(theme, destPath);
      // 跳过的槽位必须说出来：用户拿到 zip 才发现少了几个光标会很难查
      const hint = summary.skipped.length
        ? `${summary.skipped.length} 个槽位被跳过：${summary.skipped.join("、")}`
        : `已保存到 ${destPath}`;
      toast.success(`已导出 ${summary.file_count} 个光标文件`, hint);
    } catch (err) {
      console.error("导出主题失败：", err);
      toast.error("导出失败", readableError(err));
    } finally {
      set((state) => ({ busy: withBusyFlag(state.busy, key, false) }));
    }
  },

  selectTheme: (id) =>
    set((state) => ({
      selection: { ...state.selection, [state.currentPage]: id },
    })),

  // 静态信息，成功拿到一次就够；失败挂错误态让设置页给出重试出口
  //（路径没显示出来顶多少个提示，但永远「…」会让人以为页面坏了）
  loadDataDir: async () => {
    if (get().dataDir) return;
    try {
      set({ dataDir: await apiGetDataDir(), dataDirError: null });
    } catch (err) {
      console.warn("[loadDataDir]", readableError(err));
      set({ dataDirError: readableError(err) });
    }
  },

  openDataDir: async () => {
    try {
      const dir = await apiOpenDataDir();
      toast.success("已打开数据目录", inTauri ? dir : "开发模式：未真正打开系统目录");
    } catch (err) {
      console.error("打开数据目录失败：", err);
      toast.error("打开失败", readableError(err));
    }
  },

  openMousePanel: async () => {
    try {
      await apiOpenMousePanel();
    } catch (err) {
      console.error("打开鼠标属性面板失败：", err);
      toast.error("打开失败", readableError(err));
    }
  },

  loadZipMenuStatus: async () => {
    if (get().zipMenu) return;
    try {
      set({ zipMenu: await apiGetZipMenuStatus(), zipMenuError: false });
    } catch (err) {
      // 卡在「读取中…」比失败更骗人：挂个错误态让界面能说清原因
      console.warn("[loadZipMenuStatus]", readableError(err));
      set({ zipMenuError: true });
    }
  },

  toggleZipMenu: async () => {
    const current = get().zipMenu;
    if (!current) return;
    try {
      await apiSetZipMenu(!current.registered);
      // 以注册表回读为准，不用本地推测值：写失败半途的状态不能靠猜
      const next = await apiGetZipMenuStatus();
      set({ zipMenu: next });
      toast.success(
        next.registered ? "已注册右键菜单" : "已移除右键菜单注册",
        next.registered ? `.zip 右键菜单指向 ${next.exe_path}` : undefined,
      );
    } catch (err) {
      console.error("右键菜单注册失败：", err);
      toast.error("操作失败", readableError(err));
      // 操作失败时回读真实状态，别让界面停在猜出来的值上
      try {
        set({ zipMenu: await apiGetZipMenuStatus(), zipMenuError: false });
      } catch {
        /* 回读失败就保留旧值 */
      }
    }
  },

  pickupPendingImport: async () => {
    const zipPath = await apiTakePendingImport();
    if (zipPath) {
      await get().importTheme(zipPath);
    }
  },

  setSearchQuery: (q) => set({ searchQuery: q }),

  // 切页清空搜索词：三页的搜索范围不同，沿用上一个页面的关键词
  // 会让用户看到「明明是空的」的列表，却以为是数据没了
  // 进设置时记住来路，「返回」才有地方可回；已经在设置里再点设置不覆盖
  setCurrentPage: (p) =>
    set((state) => ({
      currentPage: p,
      searchQuery: "",
      previousPage:
        p === "settings"
          ? state.currentPage === "settings"
            ? state.previousPage
            : state.currentPage
          : state.previousPage,
    })),

  setSettingsSection: (s) => set({ settingsSection: s }),

  backFromSettings: () =>
    set((state) => ({
      currentPage: state.previousPage ?? "gallery",
      searchQuery: "",
    })),

  dismissWarnings: () => set({ warningsDismissed: true }),
}));

// 开发期把 store 挂到 window 上：验收脚本要能把界面摆到「加载失败 / 导入中」这类
// 真实环境里很难复现的状态。生产构建里 `import.meta.env.DEV` 为 false，整块会被摇掉。
if (import.meta.env.DEV) {
  (window as unknown as { __themeStore?: typeof useThemeStore }).__themeStore = useThemeStore;
}

/** 当前页面选中的主题对象（无选中时为 null） */
export function selectSelectedTheme(s: ThemeStore): CursorTheme | null {
  const id = s.selection[s.currentPage];
  if (!id) return null;
  return s.themes.find((t) => t.id === id) ?? null;
}
