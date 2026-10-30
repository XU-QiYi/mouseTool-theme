import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

interface CheckboxProps {
  checked: boolean;
  /** 半选：用于「全选」表头，三态必须能被读屏识别 */
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}

/**
 * 复选框（`role="checkbox"`）
 *
 * 表格批量选择用：20px 见方，选中态用 primary 填充，半选显示横线。
 * 键盘 Space / Enter 由原生 button 触发，不额外抢方向键。
 */
export function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  label,
  disabled,
  title,
  className,
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      data-state={indeterminate ? "indeterminate" : checked ? "checked" : "unchecked"}
      onClick={(event) => {
        event.stopPropagation();
        onCheckedChange(!checked);
      }}
      className={cn(
        "focus-ring grid size-5 shrink-0 place-items-center rounded-sm border transition-[background-color,border-color] duration-(--motion-fast) ease-standard",
        checked || indeterminate
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40 bg-background",
        !disabled && !checked && !indeterminate && "hover:border-primary/60",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {indeterminate ? (
        <Minus className="size-3.5" strokeWidth={3} aria-hidden />
      ) : checked ? (
        <Check className="size-3.5" strokeWidth={3} aria-hidden />
      ) : null}
    </button>
  );
}
