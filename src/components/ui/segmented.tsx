import { useRef } from "react";
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
 *
 * 键盘模型按 WAI-ARIA 单选组：整组一个 Tab 停靠点（roving tabindex），
 * 方向键在选项间移动并**立即选中**，Home / End 跳到首尾。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: SegmentedProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex((option) => option.value === value);
  const tabbableIndex = checkedIndex === -1 ? 0 : checkedIndex;

  const moveTo = (index: number) => {
    const next = options[index];
    if (!next) return;
    onChange(next.value);
    buttons.current[index]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {options.map((option, index) => {
        const active = value === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={index === tabbableIndex ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              let next: number | null = null;
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                next = (index + 1) % options.length;
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                next = (index - 1 + options.length) % options.length;
              } else if (event.key === "Home") {
                next = 0;
              } else if (event.key === "End") {
                next = options.length - 1;
              }
              if (next === null) return;
              event.preventDefault();
              moveTo(next);
            }}
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
