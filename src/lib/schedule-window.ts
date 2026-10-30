/**
 * 定时切换的纯时间计算（决策 33 / 49）
 *
 * 从 `schedule-switch.ts` 抽出：同文件依赖 zustand store 且把 `new Date()`
 * 写死在实现里，没法单测；这里全部接收 `now` 参数、零依赖，
 * 可用 `node --test` 直接跑。store 侧只保留「取当前时刻 + 读设置」的接线。
 */

/** "HH:MM" → 当天分钟数；格式不合法返回 null（后端已校验，这里兜底不炸） */
export function parseHHMM(raw: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Date → 当天分钟数 */
export function minutesOfDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * 当前是否处于时间段内；区间半开 `[start, end)`，`start === end` 视为空窗口。
 * 跨零点（start > end，如 22:00–06:00）按两段取并集。
 */
export function isInWindow(startRaw: string, endRaw: string, now: Date): boolean {
  const start = parseHHMM(startRaw);
  const end = parseHHMM(endRaw);
  if (start === null || end === null) return false;
  const nowMinutes = minutesOfDay(now);
  return start <= end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

/** 距离当天 minuteOfDay 这一分钟还有多少毫秒；已过则算明天 */
export function msUntilMinute(minuteOfDay: number, now: Date): number {
  const target = new Date(now);
  target.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/**
 * 到下一个 start / end 边界的毫秒数（取两者较近者，最长间隔 24h，
 * 不会触到 setTimeout 的 2^31 上限）；任一时刻格式不合法返回 null。
 */
export function msToNextBoundary(startRaw: string, endRaw: string, now: Date): number | null {
  const start = parseHHMM(startRaw);
  const end = parseHHMM(endRaw);
  if (start === null || end === null) return null;
  return Math.min(msUntilMinute(start, now), msUntilMinute(end, now));
}
