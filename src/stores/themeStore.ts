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
import type { CursorTheme, HistoryEntry } from "@/types/theme";

export type Page = "library" | "imported" | "recent";

interface ThemeStore {
  /** 所有主题 */
  themes: CursorTheme[];
  /** 当前系统正在使用的主题 ID */
  activeThemeId: string | null;
  /** 最近使用记录，最新在前（由后端 history.json 提供） */
  recent: HistoryEntry[];
  /** 界面中选中的主题 ID */
  selectedThemeId: string | null;
  /** 搜索关键词 */
  searchQuery: string;
  /** 当前页面 */
  currentPage: Page;
  /** 加载状态 */
  loading: boolean;

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
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  themes: [],
  activeThemeId: null,
  recent: [],
  selectedThemeId: null,
  searchQuery: "",
  currentPage: "library",
  loading: false,

  loadThemes: async () => {
    // 选中是临时的界面状态：重新加载视同「重新打开界面」，不继承上一次点击。
    // 否则重新编译后，上次点过的卡片会一直戴着高亮框、看起来像「待应用」。
    set({ loading: true, selectedThemeId: null });
    try {
      const { themes, warnings, active_theme_id, recent } = await getAllThemes();
      // 「正在使用」每次都由后端从注册表反推，不沿用内存旧值：
      // 内存状态一重开就过期，会把已应用的主题当成还能再应用一次。
      // recent 兜底：前端热更新、后端还是旧二进制时字段会缺失，
      // 让状态变成 undefined 会让「最近使用」页直接白屏。
      set({ themes, activeThemeId: active_theme_id, recent: recent ?? [] });
      // 部分来源失败仍能拿到其余主题：告知降级即可，不要打断浏览
      if (warnings.length > 0) {
        for (const warn of warnings) console.warn("[loadThemes]", warn);
        const first = warnings[0];
        toast.warning(
          "有数据没能加载",
          warnings.length === 1
            ? first
            : `${first}（共 ${warnings.length} 个问题，详见控制台）`,
        );
      }
    } catch (err) {
      console.error("加载主题失败：", err);
      toast.error("读取主题列表失败", readableError(err));
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
    set({ loading: true });
    try {
      const theme = await apiImportTheme(zipPath);
      set((state) => ({
        themes: [theme, ...state.themes],
        selectedThemeId: theme.id,
        currentPage: "library" as const,
      }));
      toast.success(`已导入「${theme.name}」`, `共 ${theme.cursors.length} 个光标槽位`);
    } catch (err) {
      console.error("导入主题失败：", err);
      toast.error("导入失败", readableError(err));
    } finally {
      set({ loading: false });
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
        selectedThemeId: state.selectedThemeId === id ? null : state.selectedThemeId,
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

  selectTheme: (id) => set({ selectedThemeId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  // 切页清空选中：否则在「主题图库」选中的内置主题，切到「已导入」后
  // 详情区还挂着一个不属于当前列表的主题
  setCurrentPage: (p) => set({ currentPage: p, selectedThemeId: null }),
}));

/** 当前选中的主题对象（无选中时为 null） */
export function selectSelectedTheme(s: ThemeStore): CursorTheme | null {
  return s.themes.find((t) => t.id === s.selectedThemeId) ?? null;
}

/**
 * 按页面与关键词过滤主题
 *
 * 必须写成纯函数、在组件里用 `useMemo` 调用。若把它当作 zustand selector
 * 直接使用，每次都会返回新数组，`useSyncExternalStore` 会判定快照不断变化，
 * 触发无限重渲染直到 React 报 "Maximum update depth exceeded"。
 */
export function filterThemes(
  themes: CursorTheme[],
  page: Page,
  query: string,
): CursorTheme[] {
  let list = themes;
  if (page === "imported") {
    list = list.filter((t) => !t.is_built_in);
  } else if (page === "recent") {
    list = [];
  }
  const q = query.trim().toLowerCase();
  if (q) {
    list = list.filter((t) => t.name.toLowerCase().includes(q));
  }
  return list;
}

/** 「最近使用」列表项：主题可能已被删除，所以 theme 允许为 null */
export interface RecentItem {
  entry: HistoryEntry;
  theme: CursorTheme | null;
}

/**
 * 把历史记录映射成列表项（保持历史顺序，最新在前）
 *
 * 与 filterThemes 同理：必须是纯函数 + 组件内 `useMemo`。
 * 在 selector 里现算会每次返回新数组，触发无限重渲染。
 */
export function buildRecentItems(
  themes: CursorTheme[],
  recent: HistoryEntry[],
  query: string,
): RecentItem[] {
  const byId = new Map(themes.map((theme) => [theme.id, theme]));
  const q = query.trim().toLowerCase();

  return recent
    .map((entry) => ({ entry, theme: byId.get(entry.theme_id) ?? null }))
    .filter(({ entry, theme }) => {
      if (!q) return true;
      // 主题还在就按当前名字搜（可能改过名），被删了才退回快照名
      return (theme?.name ?? entry.name).toLowerCase().includes(q);
    });
}
