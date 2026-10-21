import { create } from "zustand";

import {
  applyTheme as apiApplyTheme,
  getAllThemes,
  importTheme as apiImportTheme,
  restoreDefault as apiRestoreDefault,
} from "@/services/theme";
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
      const themes = await getAllThemes();
      set({ themes });
    } catch (err) {
      console.error("加载主题失败：", err);
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
    } catch (err) {
      console.error("应用主题失败：", err);
    }
  },

  restoreDefault: async () => {
    try {
      await apiRestoreDefault();
      set({ activeThemeId: null });
    } catch (err) {
      console.error("恢复默认失败：", err);
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
    } catch (err) {
      console.error("导入主题失败：", err);
    } finally {
      set({ loading: false });
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
