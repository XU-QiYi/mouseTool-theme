import { SYSTEM_SLOT_TOTAL } from "@/lib/slots";
import { cn } from "@/lib/utils";

interface SlotMeterProps {
  /** 已覆盖的槽位数（0–total） */
  filled: number;
  /** 槽位总数；默认 15（`lib/slots.ts` 的系统槽位口径） */
  total?: number;
  /** 紧凑版（表格行用 3px 高；检查器用标准 4px） */
  compact?: boolean;
  /** meter 的无障碍名称，默认「槽位覆盖」 */
  label?: string;
  className?: string;
}

/**
 * 槽位覆盖刻度：15 段离散刻度，一眼看出「填了几个」
 *
 * 用 `role="meter"` 而不是 progressbar：它读的是"当前覆盖数"，
 * 不是"任务完成了多少"。每段代表一个槽位，填满段数 = filled；
 * 这比一根连续进度条诚实——12/15 和 13/15 之间没有"进度"语义。
 * 替代原先的连续覆盖率条（检查器与表格），两种场景共用这一份。
 */
export function SlotMeter({
  filled,
  total = SYSTEM_SLOT_TOTAL,
  compact = false,
  label = "槽位覆盖",
  className,
}: SlotMeterProps) {
  const segments = Array.from({ length: total }, (_, index) => index < filled);

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={filled}
      className={cn(
        "grid grid-cols-[repeat(15,minmax(0,1fr))] gap-0.5",
        compact ? "h-0.75" : "h-1",
        className,
      )}
    >
      {segments.map((on, index) => (
        <span
          key={index}
          className={cn("rounded-full", on ? "bg-foreground/70" : "bg-muted")}
        />
      ))}
    </div>
  );
}
