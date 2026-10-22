import type { CursorTheme, HistoryEntry } from "@/types/theme";

/**
 * 主题的纯派生计算（筛选、分组、排序）
 *
 * 这里全部是纯函数：**不要**把它们塞进 zustand selector。
 * selector 返回新数组/新对象会让 `useSyncExternalStore` 认为快照一直在变，
 * 触发无限重渲染直到整页白屏（本仓库踩过）。正确用法是组件里
 * `const rows = useMemo(() => mineThemes(themes, query), [themes, query])`。
 */

/** 按来源把主题分成两组：系统方案与我的主题 */
export function splitBySource(themes: CursorTheme[]): {
  builtIn: CursorTheme[];
  mine: CursorTheme[];
} {
  return {
    builtIn: themes.filter((theme) => theme.is_built_in),
    mine: themes.filter((theme) => !theme.is_built_in),
  };
}

/** 关键词过滤（名称、不区分大小写） */
export function filterByName(themes: CursorTheme[], query: string): CursorTheme[] {
  const q = query.trim().toLowerCase();
  if (!q) return themes;
  return themes.filter((theme) => theme.name.toLowerCase().includes(q));
}

/** 「我的主题」页的数据：非系统方案 + 关键词过滤 */
export function mineThemes(themes: CursorTheme[], query: string): CursorTheme[] {
  return filterByName(
    themes.filter((theme) => !theme.is_built_in),
    query,
  );
}

/** 「最近使用」列表项：主题可能已被删除，所以 theme 允许为 null */
export interface RecentItem {
  entry: HistoryEntry;
  theme: CursorTheme | null;
}

/**
 * 把历史记录映射成列表项（保持历史顺序，最新在前）
 *
 * 被删掉的主题 `theme` 为 null，但仍然保留这一条：它是「你什么时候用过什么」
 * 的事实记录，删掉主题不等于没发生过。
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

export interface RecentGroup {
  /** 分组键，形如 `2026-10-22` */
  key: string;
  /** 展示用日期，「今天」「昨天」或「10月20日」 */
  label: string;
  items: RecentItem[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地时区的 `YYYY-MM-DD`，与后端 `applied_at` 的前半段同格式 */
function dayKeyOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 今天 / 昨天 / 具体日期 —— 只做展示映射，不参与排序 */
function labelOf(key: string, now: Date): string {
  if (!DAY_RE.test(key)) return "更早";

  const today = dayKeyOf(now);
  if (key === today) return "今天";

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKeyOf(yesterday)) return "昨天";

  const [year, month, day] = key.split("-");
  // 跨年记录必须带年份，否则「1月3日」说不清是哪一年的
  return Number(year) === now.getFullYear()
    ? `${Number(month)}月${Number(day)}日`
    : `${year}年${Number(month)}月${Number(day)}日`;
}

/**
 * 按自然日分组（保持传入顺序：最新在前）
 *
 * `applied_at` 是后端给的本地时区字符串 `YYYY-MM-DD HH:mm`，
 * 这里只切字符串取日期，不做 Date 解析 —— 避免时区把「今天」算错一天。
 */
export function groupRecentByDay(items: RecentItem[], now = new Date()): RecentGroup[] {
  const groups: RecentGroup[] = [];
  const index = new Map<string, RecentGroup>();

  for (const item of items) {
    const key = item.entry.applied_at.slice(0, 10);
    let group = index.get(key);
    if (!group) {
      group = { key, label: labelOf(key, now), items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  return groups;
}

/** 只取 `HH:mm`，时间轴左列只放得下这个精度；格式不认识就原样返回 */
export function timeOfDay(appliedAt: string): string {
  const time = appliedAt.split(" ")[1];
  return time && /^\d{1,2}:\d{2}$/.test(time) ? time : appliedAt;
}
