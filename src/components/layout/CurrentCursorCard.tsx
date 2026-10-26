import { MousePointer2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import { coverSlot, slotStats } from "@/lib/slots";
import { actionBusyKey, useThemeStore } from "@/stores/themeStore";

/**
 * 常驻「当前使用」卡：任何页面都能确认"现在用的是哪个"
 *
 * - full（主导航）：完整卡片，带「还原系统默认」；
 * - compact（设置分组导航）：只保留状态行与主题行——设置侧栏本来就
 *   挤（返回 + 五个分组），还原入口去「设置 → 通用」也有，这里只做展示。
 *
 * 三态（决策 24）：正在使用 / 系统默认 / **被系统设置改写**——第三种是
 * 注册表有值但不属于任何已知主题（系统指针样式页、其它光标工具），
 * 要警示出来而不是误报成「系统默认」。
 * 数据钩子留在组件内部：两种形态读同一批 store，调用方零负担。
 */
export function CurrentCursorCard({ variant }: { variant: "full" | "compact" }) {
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const activeExternal = useThemeStore((s) => s.activeExternal);
  const currentSlotsFilled = useThemeStore((s) => s.currentSlotsFilled);
  const activeTheme = useThemeStore(
    (s) => s.themes.find((theme) => theme.id === s.activeThemeId) ?? null,
  );
  const restoreDefault = useThemeStore((s) => s.restoreDefault);
  const busy = useThemeStore((s) => s.busy);

  const cover = activeTheme ? coverSlot(activeTheme) : undefined;
  const stats = activeTheme ? slotStats(activeTheme) : null;
  const restoring = Boolean(busy[actionBusyKey("restore", "default")]);

  return (
    <div className="rounded-xl bg-sidebar-accent/60 p-2.5 ring-1 ring-sidebar-border">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={
            activeTheme
              ? "size-1.5 rounded-full bg-success"
              : activeExternal
                ? "size-1.5 rounded-full bg-warning"
                : "size-1.5 rounded-full bg-muted-foreground/40"
          }
        />
        <span className="text-2xs text-muted-foreground">
          {activeTheme ? "当前使用中" : activeExternal ? "光标已被系统设置修改" : "系统默认"}
        </span>
      </div>

      <div className={variant === "compact" ? "mt-1.5 flex items-center gap-2" : "mt-2 flex items-center gap-2"}>
        <span className="preview-surface grid size-8 shrink-0 place-items-center rounded-md ring-1 ring-border/60">
          {cover ? (
            <CursorPreviewImage slot={cover} size="sm" />
          ) : (
            <MousePointer2 className="size-4 text-muted-foreground" />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">
            {activeTheme ? activeTheme.name : activeExternal ? "非本应用主题" : "未应用主题"}
          </p>
          <p className="truncate text-2xs text-muted-foreground">
            {activeTheme && stats
              ? `${activeTheme.is_built_in ? "系统方案" : "我的主题"} · ${stats.filled} 个槽位`
              : activeExternal
                ? `${currentSlotsFilled} 个槽位被占用 · 未匹配到任何主题`
                : "光标为 Windows 自带"}
          </p>
        </div>
      </div>

      {variant === "full" && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-2 w-full justify-start text-muted-foreground"
          onClick={restoreDefault}
          disabled={restoring}
          aria-busy={restoring}
          title={
            restoring
              ? "正在还原…"
              : activeThemeId
                ? "还原系统默认光标"
                : activeExternal
                  ? "槽位正被系统设置占用，点此清空还原"
                  : "当前已是系统默认"
          }
        >
          <RotateCcw data-icon="inline-start" />
          {restoring ? "还原中…" : "还原系统默认"}
        </Button>
      )}
    </div>
  );
}
