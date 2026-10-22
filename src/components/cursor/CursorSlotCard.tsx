import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import { useCursorPreview } from "@/hooks/useCursorPreview";
import { cn } from "@/lib/utils";
import type { CursorSlot } from "@/types/theme";

interface CursorSlotCardProps {
  slot: CursorSlot;
  /**
   * 紧凑版：只留中文名，去掉英文副名与卡片描边。
   * 右侧检查器只有 320px 宽，15 个槽位要能一屏扫完。
   */
  compact?: boolean;
}

export function CursorSlotCard({ slot, compact = false }: CursorSlotCardProps) {
  const preview = useCursorPreview(slot.file_path);
  const isAnimated = preview ? preview.is_animated : slot.file_type === "ani";

  return (
    <Card className={cn("py-0", compact && "bg-transparent ring-0")}>
      <CardContent
        className={cn(
          "flex flex-col items-center",
          compact ? "gap-1 px-1 py-1.5" : "gap-1.5 px-3 py-3",
        )}
      >
        <div
          className={cn(
            "relative flex items-center justify-center",
            compact ? "h-8 w-8" : "h-12 w-12",
          )}
        >
          <CursorPreviewImage slot={slot} size={compact ? "sm" : "md"} />
          {/* 紧凑模式不挂 ANI 角标：检查器里 12 个槽位各挂一个角标会盖住光标本身，
              动态与否看它有没有在播 + 头部「N 个动态」已经说清 */}
          {isAnimated && !compact && (
            <Badge
              variant="secondary"
              className="absolute -right-3 -bottom-1 h-4 px-1 text-3xs font-normal"
            >
              ANI
            </Badge>
          )}
        </div>
        <span className={cn("font-medium", compact ? "text-2xs" : "text-xs")}>
          {slot.display_name}
        </span>
        {!compact && (
          <span className="text-2xs text-muted-foreground">{slot.english_name}</span>
        )}
      </CardContent>
    </Card>
  );
}
