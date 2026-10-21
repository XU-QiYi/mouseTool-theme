import { Archive, Check, MousePointer2, RotateCcw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CursorGrid } from "@/components/theme/CursorGrid";
import { useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

interface ThemeDetailProps {
  theme: CursorTheme;
}

export function ThemeDetail({ theme }: ThemeDetailProps) {
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const applyTheme = useThemeStore((s) => s.applyTheme);
  const restoreDefault = useThemeStore((s) => s.restoreDefault);
  const isActive = theme.id === activeThemeId;

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-start gap-6 p-6 pb-4">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl border bg-muted">
          <MousePointer2 className="size-10 text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-medium">{theme.name}</h2>
            {theme.is_built_in && <Badge variant="outline">系统方案</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {theme.description || `${theme.cursors.length} 个光标槽位`}
          </p>

          <div className="mt-4 flex gap-2">
            <Button onClick={() => applyTheme(theme.id)} disabled={isActive}>
              <Check data-icon="inline-start" />
              {isActive ? "当前使用中" : "应用此主题"}
            </Button>
            <Button variant="outline" disabled title="阶段 6 实现">
              <Archive data-icon="inline-start" />
              导出 ZIP
            </Button>
          </div>
        </div>
      </div>

      <Separator />

      <div className="flex-1 overflow-y-auto p-6">
        <CursorGrid theme={theme} />
      </div>

      <Separator />

      <div className="flex items-center gap-2 p-4">
        <Button variant="destructive" disabled title="阶段 6 实现">
          <Trash2 data-icon="inline-start" />
          删除此主题
        </Button>
        <Button variant="ghost" onClick={restoreDefault} disabled={!activeThemeId}>
          <RotateCcw data-icon="inline-start" />
          还原系统默认
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {theme.updated_at || "导入时间待实现"}
        </span>
      </div>
    </section>
  );
}
