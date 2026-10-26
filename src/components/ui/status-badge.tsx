import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 状态徽标：表达"处于什么状态"，不是操作入口
 *
 * 语义色只有四种，**永远没有 primary**——主色留给每屏唯一的主动作，
 * 拿主色当状态底色会把「使用中」误读成一个可点的按钮。
 * tone 对应关系：success = 正常运转（使用中 / 健康项）；warning = 可用但有提示；
 * neutral = 中性事实（系统方案 / 进行中）；muted = 更弱的事实（已删除 / 排队）。
 */
export type StatusBadgeTone = "success" | "neutral" | "muted" | "warning";

const TONE_CLASS: Record<StatusBadgeTone, string> = {
  success: "bg-success/10 text-success",
  neutral: "bg-muted text-muted-foreground",
  muted: "bg-muted/60 text-muted-foreground",
  warning: "bg-warning/10 text-warning",
};

interface StatusBadgeProps {
  tone: StatusBadgeTone;
  children: ReactNode;
  /** 前置圆点（`bg-current`，跟文字同色）；状态一眼可辨时可以省 */
  dot?: boolean;
  className?: string;
}

export function StatusBadge({ tone, children, dot = false, className }: StatusBadgeProps) {
  return (
    <span
      data-status-badge
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-2xs font-medium",
        TONE_CLASS[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}
