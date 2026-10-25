import { useMemo } from "react";
import { History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { buildRecentItems, groupRecentByDay, appliedAtMachine, timeOfDay } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/themeStore";
import type { RecentItem } from "@/lib/themes";

/**
 * 最近使用：回溯
 *
 * 这一页没有检查器 —— 它回答的是「我什么时候用过什么」，
 * 时间顺序本身就是唯一的结构，塞一个详情面板只会把时间轴挤窄。
 * 按自然日分组、时间靠左、竖线串联，和表格、画廊都不是一个读法。
 */
export function RecentView() {
  const themes = useThemeStore((s) => s.themes);
  const recent = useThemeStore((s) => s.recent);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const applyTheme = useThemeStore((s) => s.applyTheme);
  const setCurrentPage = useThemeStore((s) => s.setCurrentPage);
  const loading = useThemeStore((s) => s.loading);

  const groups = useMemo(
    () => groupRecentByDay(buildRecentItems(themes, recent, "")),
    [themes, recent],
  );

  if (loading) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (recent.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={History}
          title="还没有使用记录"
          description="应用任意一个主题后，这里会按最近一次应用排列，每个主题一条，方便随时切回去"
          action={
            <Button variant="outline" onClick={() => setCurrentPage("gallery")}>
              去主题图库
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {/* 阅读宽度上限：窗口拉宽时时间与动作不会被拉到屏幕两端 */}
      <div className="max-w-3xl">
        {groups.map((group) => (
          <section key={group.key} className="mb-7 last:mb-0">
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-xs font-medium">{group.label}</h2>
              <span className="text-2xs text-muted-foreground tabular-nums">
                {group.items.length} 个主题
              </span>
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>

            <ol>
              {group.items.map((item, index) => (
                <Row
                  key={`${item.entry.theme_id}-${item.entry.applied_at}`}
                  item={item}
                  active={item.theme?.id === activeThemeId}
                  first={index === 0}
                  last={index === group.items.length - 1}
                  onApply={applyTheme}
                />
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  item: RecentItem;
  active: boolean;
  /** 组内首/末行：竖线不能伸出圆点之外，否则时间轴看起来断头 */
  first: boolean;
  last: boolean;
  onApply: (id: string) => Promise<void>;
}

function Row({ item, active, first, last, onApply }: RowProps) {
  const { entry, theme } = item;
  const deleted = theme === null;
  const name = theme?.name ?? entry.name;

  return (
    <li
      data-recent-row={entry.theme_id}
      className="grid grid-cols-[48px_16px_1fr_auto] gap-x-2 rounded-lg py-2 transition-[background-color] duration-(--motion-fast) ease-standard hover:bg-muted/50"
    >
      <time
        dateTime={appliedAtMachine(entry.applied_at)}
        className="pt-0.5 text-right text-2xs text-muted-foreground tabular-nums"
      >
        {timeOfDay(entry.applied_at)}
      </time>

      {/* 竖线画在圆点后面：每一行连一段，整组看起来是一条连续的时间轴 */}
      <span className="relative flex justify-center">
        <span
          aria-hidden
          className={cn(
            "absolute left-1/2 w-px -translate-x-1/2 bg-border",
            first ? "top-2 bottom-0" : last ? "top-0 bottom-2" : "inset-y-0",
          )}
        />
        <span
          aria-hidden
          className={cn(
            "relative mt-1 size-2 rounded-full",
            active
              ? "bg-primary"
              : deleted
                ? "border border-border bg-background"
                : "bg-muted-foreground/40",
          )}
        />
      </span>

      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm">{name}</span>
          {entry.is_built_in && (
            <span className="shrink-0 text-2xs text-muted-foreground">系统方案</span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
          {deleted
            ? "主题文件已被删除，无法再应用"
            : theme && `${theme.cursors.length} 个槽位`}
        </span>
      </span>

      <span className="flex items-center justify-end self-center">
        {deleted ? (
          <span className="px-2 text-2xs text-muted-foreground">已删除</span>
        ) : active ? (
          <Badge variant="secondary">使用中</Badge>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => theme && onApply(theme.id)}
            aria-label={`再次应用「${name}」`}
          >
            再次应用
          </Button>
        )}
      </span>
    </li>
  );
}
