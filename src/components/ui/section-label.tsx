import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SectionLabelProps {
  /** 分组标题（主题名 / 日期 / 设置分组名） */
  label: string;
  /** 条目数；与 unit 成对出现 */
  count?: number;
  /** 计数单位（个 / 次 / 个主题…） */
  unit?: string;
  /** 追加在标题行右侧、细线之前的内容（如入口按钮） */
  trailing?: ReactNode;
  /** 不画右侧细线（默认画） */
  rule?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * 分段标题：`<h2>` + 可选计数 + 撑满右侧的细线
 *
 * 图库分段头、最近使用日期头、设置分组头共用，保证「同一层级的小标题
 * 长得一样」。渲染 `<h2>`：页面标题是 `<h1>`，下一级分段必须是 `<h2>`，
 * 组件里不允许降级成 `<p>`（标题层级跳级会挂无障碍审计）。
 */
export function SectionLabel({
  label,
  count,
  unit,
  trailing,
  rule = true,
  className,
  children,
}: SectionLabelProps) {
  return (
    <div className={cn("mb-2.5 flex items-center gap-2", className)}>
      <h2 className="text-xs font-medium">{label}</h2>
      {count !== undefined && unit !== undefined && (
        <span className="text-2xs text-muted-foreground tabular-nums">
          {count} {unit}
        </span>
      )}
      {children}
      {trailing}
      {rule && <span aria-hidden className="h-px flex-1 bg-border/60" />}
    </div>
  );
}
