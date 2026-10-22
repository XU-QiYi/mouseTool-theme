import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 设置页的卡片与区块骨架
 *
 * 卡片视觉沿用设置页首版（决策 11）：圆角卡 + 1px 描边环、标题 + 说明 + 右侧动作，
 * 下方可挂一行状态文本或任意附加内容。分组区块是「小标题 + 撑满分隔线」，
 * 与图库的分组标题同一套口径；小标题省略时就是一个纯卡片栈（页头已说清是哪一组）。
 */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      {title && (
        <div className="mb-2.5 flex items-baseline gap-2">
          <h2 className="text-xs font-medium">{title}</h2>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      )}
      <div className="max-w-xl space-y-3">{children}</div>
    </section>
  );
}

export interface SettingCardProps {
  title: string;
  description: ReactNode;
  /** 右侧主动作区（按钮 / 开关 / 分段控件） */
  action?: ReactNode;
  /** 卡片下方的附加内容（路径、状态行、次级说明） */
  children?: ReactNode;
  className?: string;
}

export function SettingCard({
  title,
  description,
  action,
  children,
  className,
}: SettingCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </div>
  );
}
