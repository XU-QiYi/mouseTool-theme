import { FolderDown, History, LayoutGrid, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { CursorTheme, HistoryEntry } from "@/types/theme";

/**
 * 页面清单 —— 加一个页面只改两处
 *
 * 1. 这张表加一条（导航文案 / 页头文案 / 搜索框 / 计数口径 / 有没有检查器）；
 * 2. `App.tsx` 的 `VIEWS` 映射加一行视图组件。
 *
 * 两处都由 TS 的 `Record<Page, …>` 逼着补全，漏了就编译不过 ——
 * 以前"加页面忘了写视图分支 → 中间区域白屏"的静默失败就是这么堵上的。
 */
export interface PageCountContext {
  themes: CursorTheme[];
  recent: HistoryEntry[];
}

export interface PageMeta {
  /** 侧栏导航文案 */
  label: string;
  icon: LucideIcon;
  /** 页头主标题 */
  title: string;
  /** 页头副标题：这一页要做什么 */
  hint: string;
  /** 有值才显示搜索框，值即占位符 */
  search?: string;
  /** 计数口径；不传就不显示计数（设置这类没有集合的页面） */
  count?: (ctx: PageCountContext) => number;
  /** 计数单位，与 count 成对出现 */
  unit?: string;
  /** 右侧是否挂主题检查器 */
  hasInspector: boolean;
  /**
   * 此页内容是否依赖主题列表加载成功；缺省视为 true。
   * false 的页面在整体读取失败时照常渲染——设置页的「打开数据目录」
   * 恰恰是加载失败时的排查手段，不能被错误态顶掉。
   */
  dependsOnThemes?: boolean;
}

export const PAGE_META = {
  gallery: {
    label: "主题图库",
    icon: LayoutGrid,
    title: "主题图库",
    hint: "选中方案后在右侧预览并应用",
    search: "搜索方案…",
    count: ({ themes }) => themes.length,
    unit: "个方案",
    hasInspector: true,
  },
  mine: {
    label: "我的主题",
    icon: FolderDown,
    title: "我的主题",
    hint: "从 ZIP 导入；可改名、导出、删除",
    search: "搜索我的主题…",
    count: ({ themes }) => themes.reduce((n, theme) => (theme.is_built_in ? n : n + 1), 0),
    unit: "个方案",
    hasInspector: true,
  },
  recent: {
    label: "最近使用",
    icon: History,
    title: "最近使用",
    hint: "按最近一次应用排序，每个主题一条",
    count: ({ recent }) => recent.length,
    unit: "个主题",
    hasInspector: false,
  },
  settings: {
    label: "设置",
    icon: Settings,
    // 标题/说明实际由 settings-sections 的当前分组接管（PageHeader），
    // 这里是兜底：分组元数据万一没取到，页头也不能开天窗
    title: "设置",
    hint: "应用偏好、数据维护与系统集成",
    dependsOnThemes: false,
    hasInspector: false,
  },
} satisfies Record<string, PageMeta>;

export type Page = keyof typeof PAGE_META;

/** 导航顺序 = 这里的声明顺序 */
export const PAGE_ORDER = Object.keys(PAGE_META) as Page[];
