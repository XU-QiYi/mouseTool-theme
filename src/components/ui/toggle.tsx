import { cn } from "@/lib/utils";

export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** 无障碍名称：开关没有可见标签时必须传 */
  label: string;
  disabled?: boolean;
}

/**
 * 开关（role="switch"）
 *
 * 桌面端开关对应 Windows 设置里的「开 / 关」两态，不做半开、不做动画回弹。
 * 轨道 24×44、滑块 20 圆形，全部落在 2px 网格上；动效只过渡颜色与位移。
 */
export function Toggle({ checked, onCheckedChange, label, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "focus-ring relative h-6 w-11 shrink-0 rounded-4xl transition-[background-color] duration-(--motion-fast) ease-standard",
        checked ? "bg-primary" : "bg-muted-foreground/30",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 left-0.5 size-5 rounded-full bg-background shadow-raised transition-[translate] duration-(--motion-fast) ease-standard",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}
