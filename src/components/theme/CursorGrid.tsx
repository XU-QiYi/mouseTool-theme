import { CursorSlotCard } from "@/components/cursor/CursorSlotCard";
import { cn } from "@/lib/utils";
import type { CursorTheme } from "@/types/theme";

interface CursorGridProps {
  theme: CursorTheme;
  compact?: boolean;
}

export function CursorGrid({ theme, compact = false }: CursorGridProps) {
  return (
    <div
      className={cn(
        "grid gap-2",
        // 紧凑模式按面板宽度自适应列数：320px 出 3 列，拖宽到 480px 出 5 列，
        // 15 个槽位就少两行，常规窗口里不用滚动
        compact ? "grid-cols-[repeat(auto-fill,minmax(76px,1fr))]" : "grid-cols-4 gap-3",
      )}
    >
      {theme.cursors.map((slot) => (
        <CursorSlotCard key={slot.registry_key} slot={slot} compact={compact} />
      ))}
    </div>
  );
}
