import { MousePointer2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import { coverSlot, slotStats } from "@/lib/slots";
import { cn } from "@/lib/utils";
import type { CursorTheme } from "@/types/theme";

interface GalleryCardProps {
  theme: CursorTheme;
  active: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}

/**
 * 图库卡片：视觉优先
 *
 * 与旧版的最大区别是封面用棋盘格底（透明光标在纯色底上看不见）
 * 并把尺寸放大 —— 图库这一页的工作是「逛」，卡片得先好看，再谈信息量。
 */
export function GalleryCard({ theme, active, selected, onSelect }: GalleryCardProps) {
  const cover = coverSlot(theme);
  const stats = slotStats(theme);

  return (
    <button
      type="button"
      onClick={() => onSelect(theme.id)}
      aria-pressed={selected}
      aria-current={active ? "true" : undefined}
      data-theme-card={theme.id}
      className={cn(
        "focus-ring group flex w-full flex-col overflow-hidden rounded-xl bg-card text-left",
        "ring-1 transition-[background-color,box-shadow,translate] duration-(--motion-base) ease-standard active:translate-y-px",
        // ring 是 box-shadow，1px→2px 能被平滑插值；换成 border 会真的跳一下
        selected ? "bg-accent ring-2 ring-primary" : "ring-foreground/10 hover:ring-primary/40",
      )}
    >
      <div className="preview-surface relative flex h-28 w-full items-center justify-center border-b border-border/60">
        {cover ? (
          <CursorPreviewImage slot={cover} size="lg" />
        ) : (
          <MousePointer2 className="size-5 text-muted-foreground" />
        )}
        {active && <Badge className="absolute top-2 right-2">使用中</Badge>}
      </div>

      <div className="flex flex-col gap-0.5 p-3">
        <span className="truncate text-sm font-medium">{theme.name}</span>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {stats.filled} / {stats.total} 槽位
          {stats.animated > 0 ? ` · ${stats.animated} 个动态` : ""}
        </span>
      </div>
    </button>
  );
}
