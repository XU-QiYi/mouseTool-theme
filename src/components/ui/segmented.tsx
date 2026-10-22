import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedProps<T extends string> {
  /** 当前值 */
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** 无障碍名称（整组） */
  label: string;
}

/**
 * 分段单选（role="radiogroup"）
 *
 * 选项恒定少而短（2–3 个），对应 Windows 里「三选一」式的外观 / 行为选择。
 * 选中态用「抬起」表达（浅底 + 细环 + 阴影），不靠状态色——状态色只做反馈。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {options.map((option) => {
        const active = value === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "focus-ring flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-[color,background-color,box-shadow] duration-(--motion-fast) ease-standard",
              active
                ? "bg-card text-foreground shadow-raised ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="size-3.5 shrink-0" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
