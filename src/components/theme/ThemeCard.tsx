import { MousePointer2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import type { CursorTheme } from "@/types/theme";

interface ThemeCardProps {
  theme: CursorTheme;
  active: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function ThemeCard({ theme, active, selected, onSelect }: ThemeCardProps) {
  const cover = theme.cursors[0];

  return (
    <button
      type="button"
      onClick={() => onSelect(theme.id)}
      className={`w-full rounded-xl border p-3 text-left transition-all ${
        selected
          ? "border-primary bg-accent"
          : "border-border hover:border-primary/40 hover:shadow-sm"
      }`}
    >
      <div className="mb-2.5 flex h-16 items-center justify-center rounded-lg bg-muted">
        {cover ? (
          <CursorPreviewImage slot={cover} />
        ) : (
          <MousePointer2 className="size-7 text-muted-foreground" />
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{theme.name}</span>
        {active && <Badge className="shrink-0">使用中</Badge>}
      </div>

      <p className="mt-0.5 text-xs text-muted-foreground">{theme.cursors.length} 个光标</p>
    </button>
  );
}
