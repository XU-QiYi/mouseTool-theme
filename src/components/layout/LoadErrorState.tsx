import { CircleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

interface LoadErrorStateProps {
  message: string;
  onRetry: () => void;
}

/**
 * 整次读取失败
 *
 * 和「还没有主题」必须分开：空列表是一个**事实**（用户真的一个都没导入），
 * 读取失败是一个**故障**（主题还在，只是没拿到）。把故障说成"还没有"，
 * 用户会去重新导入，或者以为数据被删了。
 */
export function LoadErrorState({ message, onRetry }: LoadErrorStateProps) {
  return (
    <div data-error-state className="flex min-h-0 flex-1 items-center justify-center">
      <div className="flex flex-col items-center gap-3 px-8 text-center">
        <div className="grid size-11 place-items-center rounded-xl bg-destructive/10 text-destructive">
          <CircleAlert className="size-5" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">读取主题失败</p>
          <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
            系统方案和已导入的主题都没能读出来。文件没有被删除，重试通常就能恢复。
          </p>
          <p className="max-w-xs text-2xs break-words text-muted-foreground/80">{message}</p>
        </div>
        <Button variant="outline" onClick={onRetry}>
          重试
        </Button>
      </div>
    </div>
  );
}
