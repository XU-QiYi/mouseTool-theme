import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  /** 主操作；没有可做的事就不传，别放一个点不动的按钮 */
  action?: ReactNode;
}

/**
 * 空状态：图标 + 主句 + 说明 + 可选的下一步
 *
 * 三个页面的空状态文案各不相同 —— 空状态是用户第一次看到某个页面的样子，
 * 说清「这一页是干什么的、下一步该做什么」，比一句「暂无数据」有用得多。
 */
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <div className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
