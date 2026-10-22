import { create } from "zustand";

import {
  applyTheme as apiApplyTheme,
  deleteTheme as apiDeleteTheme,
  exportTheme as apiExportTheme,
  getAllThemes,
  importTheme as apiImportTheme,
  inTauri,
  renameTheme as apiRenameTheme,
  restoreDefault as apiRestoreDefault,
} from "@/services/theme";
import { readableError, toast } from "@/lib/toast";
import type { Page } from "@/lib/pages";
import type { CursorTheme, HistoryEntry } from "@/types/theme";

/** 三个页面的语义（互不重叠，各自有一套视图与任务）： */
export type { Page };

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

interface ThemeStore {
  /** 所有主题 */
  themes: CursorTheme[];
  /** 当前系统正在使用的主题 ID */
  activeThemeId: string | null;
  /** 最近使用记录，最新在前（由后端 history.json 提供） */
  recent: HistoryEntry[];
  /** 每个页面各自选中的主题 ID；`recent` 页没有检查器，恒为 null */
  selection: Selection;
  /** 搜索关键词（切页清空，见 setCurrentPage） */
  searchQuery: string;
  /** 当前页面 */
  currentPage: Page;
  /** 加载状态（只用于"首次加载/重载"，导入有自己的 importing） */
  loading: boolean;
  /** 导入进行中：不复用 loading，否则导入时整个列表会变成骨架 */
  importing: boolean;
  /** 整体加载失败；null = 正常。与 warnings（部分失败）是两回事 */
  loadError: string | null;
  /** 没能读到的数据源（部分成功时非空），展示为页面顶部的一条提示 */
  warnings: string[];
  /** 用户主动关掉了提示条；重新加载会复位 */
  warningsDismissed: boolean;

  loadThemes: () => Promise<void>;
  applyTheme: (id: string) => Promise<void>;
  restoreDefault: () => Promise<void>;
  importTheme: (zipPath: string) => Promise<void>;
  deleteTheme: (id: string) => Promise<void>;
  renameTheme: (id: string, newName: string) => Promise<void>;
  exportTheme: (id: string, destPath: string) => Promise<void>;
  selectTheme: (id: string) => void;
  setSearchQuery: (q: string) => void;
  setCurrentPage: (p: Page) => void;
  dismissWarnings: () => void;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  themes: [],
  activeThemeId: null,
  recent: [],
  selection: NO_SELECTION,
  searchQuery: "",
  currentPage: "gallery",
  loading: false,
  importing: false,
  loadError: null,
  warnings: [],
  warningsDismissed: false,

  loadThemes: async () => {
    set({ loading: true, loadError: null });
    try {
      const { themes, warnings, active_theme_id, recent } = await getAllThemes();
      // 「正在使用」每次都由后端从注册表反推，不沿用内存旧值：
      // 内存状态一重开就过期，会把已应用的主题当成还能再应用一次。
      // recent 兜底：前端热更新、后端还是旧二进制时字段会缺失，
      // 让状态变成 undefined 会让「最近使用」页直接白屏。
      const ids = new Set(themes.map((theme) => theme.id));

      set((state) => ({
        themes,
        activeThemeId: active_theme_id,
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

  applyTheme: async (id) => {
    const theme = get().themes.find((t) => t.id === id);
    if (!theme) return;
    try {
      const outcome = await apiApplyTheme(theme);
      set({ activeThemeId: id, recent: outcome.recent });
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
    }
  },

  restoreDefault: async () => {
    try {
      await apiRestoreDefault();
      set({ activeThemeId: null });
      toast.success(
        "已还原系统默认光标",
        inTauri ? undefined : "开发模式：未真正写入系统",
      );
    } catch (err) {
      console.error("恢复默认失败：", err);
      toast.error("还原失败", readableError(err));
    }
  },

  importTheme: async (zipPath) => {
    // 用 importing 而不是 loading：导入是"往列表里加一条"，
    // 把列表换成骨架会让用户以为原来的主题没了
    set({ importing: true });
    try {
      const theme = await apiImportTheme(zipPath);
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
    } catch (err) {
      console.error("导入主题失败：", err);
      toast.error("导入失败", readableError(err));
    } finally {
      set({ importing: false });
    }
  },

  deleteTheme: async (id) => {
    const theme = get().themes.find((t) => t.id === id);
    if (!theme) return;

    // 双保险：按钮已禁用，这里再挡一次，防止别处调用时误删正在使用的主题
    if (get().activeThemeId === id) {
      toast.error("不能删除正在使用的主题", "请先切换到其它主题，或还原系统默认");
      return;
    }
    if (theme.is_built_in) {
      toast.error("系统自带方案不能删除");
      return;
    }

    try {
      await apiDeleteTheme(id);
      set((state) => ({
        themes: state.themes.filter((t) => t.id !== id),
        // 所有页面的选择都要清，不然检查器会挂着一个已经不存在的 ID
        selection: clearSelection(state.selection, id),
      }));
      toast.success(`已删除「${theme.name}」`);
    } catch (err) {
      console.error("删除主题失败：", err);
      toast.error("删除失败", readableError(err));
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
    }
  },

  exportTheme: async (id, destPath) => {
    const theme = get().themes.find((t) => t.id === id);
    if (!theme) return;

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
    }
  },

  selectTheme: (id) =>
    set((state) => ({
      selection: { ...state.selection, [state.currentPage]: id },
    })),

  setSearchQuery: (q) => set({ searchQuery: q }),

  // 切页清空搜索词：三页的搜索范围不同，沿用上一个页面的关键词
  // 会让用户看到「明明是空的」的列表，却以为是数据没了
  setCurrentPage: (p) => set({ currentPage: p, searchQuery: "" }),

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
