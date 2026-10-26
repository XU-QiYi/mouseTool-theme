import type { ReactNode } from "react";
import { CircleAlert, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SettingsStatusBannerProps {
  tone: "warning" | "destructive";
  title: string;
  children?: ReactNode;
  /** 重试按钮文案与回调；不传就没有按钮 */
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}

/**
 * 设置页状态横幅：读取失败 / 部分数据的可重试出口
 *
 * 只在设置页用，不做全局通知中心——每处失败出现在它自己的卡片上方，
 * 用户才知道「重试」重试的是哪一项。样式口径与 GeneralSection 原有的
 * settings-warning 一致（warning/10 底 + 同色环），destructive 用于
 * 完全读不到、必须重试的场景。
 */
export function SettingsStatusBanner({
  tone,
  title,
  children,
  retryLabel,
  onRetry,
  className,
}: SettingsStatusBannerProps) {
  const Icon = tone === "warning" ? TriangleAlert : CircleAlert;
  return (
    <div
      role="alert"
      data-settings-banner={tone}
      className={cn(
        "mb-4 rounded-lg px-3 py-2 ring-1",
        tone === "warning"
          ? "bg-warning/10 ring-warning/25"
          : "bg-destructive/10 ring-destructive/25",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn("mt-0.5 size-3.5 shrink-0", tone === "warning" ? "text-warning" : "text-destructive")}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-xs font-medium",
              tone === "warning" ? "text-warning" : "text-destructive",
            )}
          >
            {title}
          </p>
          {children && <div className="mt-0.5 break-all text-2xs text-muted-foreground">{children}</div>}
        </div>
        {retryLabel && onRetry && (
          <Button
            size="xs"
            variant="outline"
            className="mt-0.5 shrink-0"
            onClick={onRetry}
          >
            <RotateCcw data-icon="inline-start" />
            {retryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
