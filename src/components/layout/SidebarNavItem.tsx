import type { LucideIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SidebarNavItemProps {
  icon: LucideIcon;
  label: string;
  /** 右侧计数；不传不渲染（不是所有导航项都有集合） */
  count?: number | string;
  /** 读取失败时计数传 "—"，0 会被读成"这里真的什么都没有" */
  active: boolean;
  onClick: () => void;
}

/**
 * 侧栏导航项：主导航与设置分组导航共用一份
 *
 * 精确类名承载三件事，别随手改：
 * - `buttonVariants(ghost)` 让它和「导入主题」同一套焦点环（design_check 断言
 *   `focus-visible:ring-3`）与 hover 态；
 * - 左侧 2px 活动条：单靠底色在深色模式下对比不足；
 * - `aria-current="page"`：读屏据此识别「你在哪」。
 */
export function SidebarNavItem({ icon: Icon, label, count, active, onClick }: SidebarNavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        buttonVariants({ variant: "ghost" }),
        "relative h-auto w-full justify-start gap-2.5 px-3 py-2",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/50",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary"
        />
      )}
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className="ml-auto text-2xs tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  );
}
