import { useMemo, useState } from "react";
import { Archive, FolderDown, MousePointer2, SearchX, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import { DeleteThemeDialog } from "@/components/theme/DeleteThemeDialog";
import { useExportTheme } from "@/hooks/useExportTheme";
import { useImportTheme } from "@/hooks/useImportTheme";
import { coverage, coverSlot, slotStats } from "@/lib/slots";
import { mineThemes } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

/**
 * 我的主题：管
 *
 * 与图库看的是同一批对象，但回答的是完全不同的问题：
 * 槽位覆盖了几个、什么时候导入的、要不要改名/导出/删除。
 * 所以用表格而不是卡片 —— 这一页要比对，不是要欣赏。
 */
export function MyThemesView() {
  const themes = useThemeStore((s) => s.themes);
  const query = useThemeStore((s) => s.searchQuery);
  const setSearchQuery = useThemeStore((s) => s.setSearchQuery);
  const loading = useThemeStore((s) => s.loading);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const selectedId = useThemeStore((s) => s.selection.mine);
  const selectTheme = useThemeStore((s) => s.selectTheme);
  const { picking, pick } = useImportTheme();
  const { exporting, pickAndExport } = useExportTheme();

  const [pendingDelete, setPendingDelete] = useState<CursorTheme | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const rows = useMemo(() => mineThemes(themes, query), [themes, query]);
  const hasImported = useMemo(
    () => themes.some((theme) => !theme.is_built_in),
    [themes],
  );

  const requestDelete = (theme: CursorTheme) => {
    setPendingDelete(theme);
    setConfirmOpen(true);
  };

  if (loading) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (!hasImported) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={FolderDown}
          title="还没有导入过主题"
          description="支持 .zip 主题包；包内光标按 arrow、busy、hand 这类标准命名，导入时会自动对上槽位"
          action={
            <Button onClick={pick} disabled={picking}>
              {picking ? "选择中…" : "导入主题"}
            </Button>
          }
        />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={SearchX}
          title={`没有匹配「${query.trim()}」的主题`}
          description="换个关键词试试，或者清除搜索看全部"
          action={
            <Button variant="outline" onClick={() => setSearchQuery("")}>
              清除搜索
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-4">
      {/* 表格列宽固定，窗口拉宽时给一个上限，免得名称列被撑成一片空白 */}
      <table className="w-full max-w-4xl table-fixed text-sm">
        <caption className="sr-only">我导入的主题：槽位覆盖、导入时间与操作</caption>
        <thead>
          <tr className="border-b border-border/60">
            <th scope="col" className="px-3 py-2 text-left text-xs font-normal text-muted-foreground">
              方案
            </th>
            <th scope="col" className="w-28 px-3 py-2 text-left text-xs font-normal text-muted-foreground">
              槽位
            </th>
            <th scope="col" className="w-28 px-3 py-2 text-left text-xs font-normal text-muted-foreground">
              导入于
            </th>
            <th scope="col" className="w-24 px-3 py-2 text-right text-xs font-normal text-muted-foreground">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((theme) => {
            const selected = theme.id === selectedId;
            const isActive = theme.id === activeThemeId;
            const stats = slotStats(theme);
            const cover = coverSlot(theme);
            const [importDate, importTime] = theme.updated_at
              ? theme.updated_at.split(" ")
              : ["—", undefined];

            return (
              <tr
                key={theme.id}
                data-theme-row={theme.id}
                className={cn(
                  "border-b border-border/60 transition-[background-color] duration-(--motion-fast) ease-standard",
                  selected ? "bg-accent" : "hover:bg-muted/50",
                )}
              >
                <td className="relative px-3 py-2.5">
                  {/* 选中条用整行高的 2px 竖线：accent 底色只有 3% 明度差，
                      单靠底色在深色模式下几乎看不出选中 */}
                  {selected && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-primary"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => selectTheme(theme.id)}
                    aria-pressed={selected}
                    className="focus-ring flex w-full min-w-0 items-center gap-2.5 rounded-md text-left"
                  >
                    <span className="preview-surface grid size-9 shrink-0 place-items-center rounded-md ring-1 ring-border/60">
                      {cover ? (
                        <CursorPreviewImage slot={cover} size="sm" />
                      ) : (
                        <MousePointer2 className="size-4 text-muted-foreground" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{theme.name}</span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {stats.animated > 0
                          ? `${stats.animated} 个动态光标`
                          : "全部为静态光标"}
                      </span>
                    </span>
                    {isActive && (
                      <Badge className="shrink-0">使用中</Badge>
                    )}
                  </button>
                </td>

                <td className="px-3 py-2.5">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground">{stats.filled}</span>
                    {" / "}
                    {stats.total}
                  </span>
                  <span className="mt-1 block h-1 w-14 overflow-hidden rounded-4xl bg-muted">
                    <span
                      className="block h-full rounded-4xl bg-primary"
                      style={{ width: `${coverage(stats)}%` }}
                    />
                  </span>
                </td>

                <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">
                  <span className="block">{importDate}</span>
                  {importTime && <span className="block text-2xs">{importTime}</span>}
                </td>

                <td className="px-3 py-2.5">
                  <span className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`导出「${theme.name}」`}
                      title={exporting ? "导出中…" : "导出 ZIP"}
                      onClick={() => pickAndExport(theme)}
                      disabled={exporting}
                      className="text-muted-foreground"
                    >
                      <Archive />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`删除「${theme.name}」`}
                      title={isActive ? "正在使用这个主题，请先切换到其它主题" : "删除此主题"}
                      onClick={() => requestDelete(theme)}
                      disabled={isActive}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 />
                    </Button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <DeleteThemeDialog theme={pendingDelete} open={confirmOpen} onOpenChange={setConfirmOpen} />
    </div>
  );
}
