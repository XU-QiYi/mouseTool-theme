import type { CursorSlot, CursorTheme } from "@/types/theme";

/**
 * 系统光标槽位总数（用于「这个主题覆盖了几个槽位」这类展示口径）
 *
 * **唯一事实来源是 `src-tauri/src/utils/registry.rs::SLOT_DEFS`（15 个）。**
 * 这里只放一个数字，不复制槽位表本身：槽位键名、顺序、读写注册表的逻辑
 * 全部留在后端。后端增删槽位时，这个常量必须跟着改。
 */
export const SYSTEM_SLOT_TOTAL = 15;

export interface SlotStats {
  /** 主题实际包含的槽位数 */
  filled: number;
  /** 系统槽位总数 */
  total: number;
  /** 未覆盖的槽位数：这些槽位仍沿用当前系统光标 */
  missing: number;
  /** 动态（.ani）槽位数量 */
  animated: number;
  /** 静态（.cur/.ico）槽位数量 */
  still: number;
}

export function slotStats(theme: CursorTheme): SlotStats {
  const filled = theme.cursors.length;
  const animated = theme.cursors.filter((slot) => slot.file_type === "ani").length;
  return {
    filled,
    total: SYSTEM_SLOT_TOTAL,
    missing: Math.max(0, SYSTEM_SLOT_TOTAL - filled),
    animated,
    still: filled - animated,
  };
}

/**
 * 封面槽位：优先「正常选择」
 *
 * 导入包的槽位顺序取决于压缩包里的文件名，第一条不一定是箭头光标。
 * 用 `registry_key === "Arrow"` 取到真正的「正常选择」，
 * 找不到才退回第一条，保证封面始终有东西可画。
 */
export function coverSlot(theme: CursorTheme): CursorSlot | undefined {
  return theme.cursors.find((slot) => slot.registry_key === "Arrow") ?? theme.cursors[0];
}

/** 槽位覆盖率百分比（0–100，用于表格里的覆盖条） */
export function coverage(stats: SlotStats): number {
  if (stats.total <= 0) return 0;
  return Math.min(100, Math.round((stats.filled / stats.total) * 100));
}
