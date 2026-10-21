import { create } from "zustand";

import {
  applyTheme as apiApplyTheme,
  deleteTheme as apiDeleteTheme,
  getAllThemes,
  importTheme as apiImportTheme,
  inTauri,
  restoreDefault as apiRestoreDefault,
} from "@/services/theme";
import { readableError, toast } from "@/lib/toast";
import type { CursorTheme } from "@/types/theme";

export type Page = "library" | "imported" | "recent";

interface ThemeStore {
  /** 所有主题 */
  themes: CursorTheme[];
  /** 当前系统正在使用的主题 ID */
  activeThemeId: string | null;
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
  selectTheme: (id: string) => void;
  setSearchQuery: (q: string) => void;
  setCurrentPage: (p: Page) => void;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  themes: [],
  activeThemeId: null,
  selectedThemeId: null,
  searchQuery: "",
  currentPage: "library",
  loading: false,

  loadThemes: async () => {
    set({ loading: true });
    try {
      const { themes, warnings } = await getAllThemes();
      set({ themes });
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
      await apiApplyTheme(theme);
      set({ activeThemeId: id });
      toast.success(
        `已应用「${theme.name}」`,
        inTauri ? "系统光标已切换" : "开发模式：未真正写入系统",
      );
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

  selectTheme: (id) => set({ selectedThemeId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setCurrentPage: (p) => set({ currentPage: p }),
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
