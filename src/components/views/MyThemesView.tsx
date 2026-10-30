import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  FolderDown,
  FolderOutput,
  ListChecks,
  MousePointer2,
  SearchX,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ContentFrame } from "@/components/layout/ContentFrame";
import { EmptyState } from "@/components/layout/EmptyState";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import { SlotMeter } from "@/components/theme/SlotMeter";
import { BatchDeleteDialog } from "@/components/theme/BatchDeleteDialog";
import { DeleteThemeDialog } from "@/components/theme/DeleteThemeDialog";
import { useExportAllThemes } from "@/hooks/useExportAllThemes";
import { useExportTheme } from "@/hooks/useExportTheme";
import { useImportTheme } from "@/hooks/useImportTheme";
import { coverSlot, slotStats } from "@/lib/slots";
import { mineThemes, missingSlotsOf, type MineFilter, type MineSort } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { actionBusyKey, BATCH_DELETE_BUSY_KEY, useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

/**
 * 我的主题：管
 *
 * 与图库看的是同一批对象，但回答的是完全不同的问题：
 * 槽位覆盖了几个、什么时候导入的、要不要改名/导出/删除。
 * 所以用表格而不是卡片 —— 这一页要比对，不是要欣赏。
 *
 * 整行可选中：名称按钮用 `after:absolute after:inset-0` 把点击区铺满整行
 * （鼠标 + 键盘仍只有这一个入口）；操作列 `z-10` 压在铺层之上，
 * 行内按钮都阻止冒泡，点「导出」不会顺带选中。
 */
export function MyThemesView() {
  const themes = useThemeStore((s) => s.themes);
  const fileGaps = useThemeStore((s) => s.fileGaps);
  const recent = useThemeStore((s) => s.recent);
  const query = useThemeStore((s) => s.searchQuery);
  const setSearchQuery = useThemeStore((s) => s.setSearchQuery);
  const loading = useThemeStore((s) => s.loading);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const selectedId = useThemeStore((s) => s.selection.mine);
  const selectTheme = useThemeStore((s) => s.selectTheme);
  const busy = useThemeStore((s) => s.busy);
  const exportAllProgress = useThemeStore((s) => s.exportAllProgress);
  const batchDeleteProgress = useThemeStore((s) => s.batchDeleteProgress);
  const { picking, pick } = useImportTheme();
  const { isExporting, pickAndExport } = useExportTheme();
  const { picking: pickingAll, exportingAll, pickAndExportAll } = useExportAllThemes();

  const [pendingDelete, setPendingDelete] = useState<CursorTheme | null>(null);
  const [singleConfirmOpen, setSingleConfirmOpen] = useState(false);
  // 整理模式是页面内的一次性会话：勾选不进 store、不落盘，离开页面即消失
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  // 排序与筛选同样是会话内状态（决策 48）：不落盘、不影响别的页面
  const [sort, setSort] = useState<MineSort>("newest");
  const [filter, setFilter] = useState<MineFilter>("all");

  // 「从未使用」= 最近使用记录里没出现过的主题 ID
  const usedIds = useMemo(
    () => new Set(recent.map((entry) => entry.theme_id)),
    [recent],
  );

  const rows = useMemo(
    () => mineThemes(themes, query, { sort, filter, fileGaps, usedIds }),
    [themes, query, sort, filter, fileGaps, usedIds],
  );
  const hasImported = useMemo(
    () => themes.some((theme) => !theme.is_built_in),
    [themes],
  );
  const batchDeleting = Boolean(busy[BATCH_DELETE_BUSY_KEY]);
  // 使用中的主题可以看、可以选进检查器，但不能进入批量删除
  const deletableRows = useMemo(
    () => rows.filter((theme) => theme.id !== activeThemeId),
    [rows, activeThemeId],
  );
  const selectedThemes = useMemo(
    () => rows.filter((theme) => selectedIds.has(theme.id) && theme.id !== activeThemeId),
    [rows, selectedIds, activeThemeId],
  );
  const selectedCount = selectedThemes.length;
  const allSelected = deletableRows.length > 0 && selectedCount === deletableRows.length;
  const someSelected = selectedCount > 0 && !allSelected;

  // 删除范围永远与眼前列表一致：换搜索词就清空勾选，避免删掉被过滤掉的行
  useEffect(() => {
    setSelectedIds(new Set());
  }, [query]);

  // 列表变化（删除 / 导入 / 恢复）后，把已经不存在的 ID 从勾选里剔除
  useEffect(() => {
    const available = new Set(rows.map((theme) => theme.id));
    setSelectedIds((prev) => {
      if ([...prev].every((id) => available.has(id))) return prev;
      return new Set([...prev].filter((id) => available.has(id)));
    });
  }, [rows]);

  // 应用主题后，刚变成「使用中」的那一套必须立刻退出勾选
  useEffect(() => {
    if (!activeThemeId) return;
    setSelectedIds((prev) => {
      if (!prev.has(activeThemeId)) return prev;
      const next = new Set(prev);
      next.delete(activeThemeId);
      return next;
    });
  }, [activeThemeId]);

  // 主题库清空后退出整理模式；否则下次导入会莫名回到勾选状态
  useEffect(() => {
    if (!hasImported && batchMode) {
      setBatchMode(false);
      setSelectedIds(new Set());
    }
  }, [hasImported, batchMode]);

  useEffect(() => {
    if (batchConfirmOpen && selectedThemes.length === 0) setBatchConfirmOpen(false);
  }, [batchConfirmOpen, selectedThemes.length]);

  const requestDelete = (theme: CursorTheme) => {
    setPendingDelete(theme);
    setSingleConfirmOpen(true);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(deletableRows.map((theme) => theme.id)));
    }
  };

  const exitBatchMode = () => {
    if (batchDeleting) return;
    setBatchMode(false);
    setSelectedIds(new Set());
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
          description="导入 ZIP 或整个主题文件夹后，主题会出现在这里。"
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
    const keyword = query.trim();
    const filterTitle =
      filter === "gapped"
        ? "没有缺文件的主题"
        : filter === "unused"
          ? "没有从未使用过的主题"
          : null;
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={SearchX}
          title={
            keyword
              ? `没有匹配「${keyword}」的主题`
              : (filterTitle ?? "没有匹配的主题")
          }
          description={
            keyword
              ? "换个关键词试试，或者清除搜索看全部"
              : "当前筛选条件下没有主题，切回「全部主题」看完整列表"
          }
          action={
            <Button
              variant="outline"
              onClick={() => {
                if (keyword) setSearchQuery("");
                if (filter !== "all") setFilter("all");
              }}
            >
              {keyword ? "清除搜索" : "显示全部主题"}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <ContentFrame width="wide">
        {/* 工具条：默认批量导出（决策 34）；整理模式换成选择与批量删除（决策 43） */}
        <div className="mb-3 flex items-center justify-between gap-3" data-export-all-bar>
          <p className="text-2xs text-muted-foreground tabular-nums">
            共 {rows.length} 套主题{filter !== "all" ? "（已按条件筛选）" : ""}
          </p>
          <div className="flex items-center gap-2">
            {batchMode ? (
              <>
                {batchDeleteProgress && (
                  <span
                    data-batch-delete-progress
                    className="text-2xs text-muted-foreground tabular-nums whitespace-nowrap"
                  >
                    {batchDeleteProgress.current}/{batchDeleteProgress.total} ·{" "}
                    {batchDeleteProgress.message}
                  </span>
                )}
                <span
                  data-batch-count
                  aria-live="polite"
                  className="text-2xs text-muted-foreground tabular-nums whitespace-nowrap"
                >
                  已选 {selectedCount} 套
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  data-select-all
                  onClick={toggleSelectAll}
                  disabled={deletableRows.length === 0 || batchDeleting}
                >
                  {allSelected ? "取消全选" : "全选"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  data-batch-delete
                  onClick={() => setBatchConfirmOpen(true)}
                  disabled={selectedCount === 0 || batchDeleting}
                >
                  <Trash2 data-icon="inline-start" />
                  {batchDeleting ? "删除中…" : "删除所选"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-batch-exit
                  onClick={exitBatchMode}
                  disabled={batchDeleting}
                >
                  退出整理
                </Button>
              </>
            ) : (
              <>
                {exportAllProgress && (
                  <span
                    data-export-all-progress
                    className="text-2xs text-muted-foreground tabular-nums"
                  >
                    {exportAllProgress.current}/{exportAllProgress.total} ·{" "}
                    {exportAllProgress.message}
                  </span>
                )}
                {/* 排序与筛选（决策 48）：原生 select 拿免费的无障碍与键盘行为；
                    整理模式下让位——批量范围永远等于眼前列表，中途换条件会让勾选失义 */}
                <select
                  aria-label="排序方式"
                  data-mine-sort
                  className="h-8 rounded-lg border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as MineSort)}
                >
                  <option value="newest">最新导入在前</option>
                  <option value="oldest">最早导入在前</option>
                  <option value="name">按名称</option>
                  <option value="slots">按槽位完整度</option>
                </select>
                <select
                  aria-label="筛选"
                  data-mine-filter
                  className="h-8 rounded-lg border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value as MineFilter)}
                >
                  <option value="all">全部主题</option>
                  <option value="gapped">缺文件的</option>
                  <option value="unused">从未使用的</option>
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  data-batch-mode
                  title={
                    deletableRows.length === 0
                      ? "当前列表没有可批量删除的主题（使用中的主题需先切换或还原系统默认）"
                      : undefined
                  }
                  onClick={() => setBatchMode(true)}
                  disabled={exportingAll || pickingAll || batchDeleting || deletableRows.length === 0}
                >
                  <ListChecks data-icon="inline-start" />
                  批量整理
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-export-all
                  onClick={() => void pickAndExportAll()}
                  disabled={exportingAll || pickingAll || batchDeleting}
                >
                  <FolderOutput data-icon="inline-start" />
                  {exportingAll ? "导出中…" : pickingAll ? "选择中…" : "导出全部"}
                </Button>
              </>
            )}
          </div>
        </div>
        {/* 抵消首末列 padding：表格首列文字与页标题左缘对齐 */}
        <table className="-mx-3 w-[calc(100%+1.5rem)] table-fixed text-sm">
        <caption className="sr-only">我导入的主题：槽位覆盖、导入时间与操作</caption>
        <thead>
          <tr className="border-b border-border/60">
            <th scope="col" className="px-3 py-2 text-left text-xs font-normal text-muted-foreground">
              {batchMode ? (
                <span className="flex items-center gap-2.5 whitespace-nowrap">
                  <Checkbox
                    checked={allSelected}
                    indeterminate={someSelected}
                    onCheckedChange={toggleSelectAll}
                    label="全选当前列表中的可删除主题"
                    disabled={deletableRows.length === 0 || batchDeleting}
                  />
                  主题
                </span>
              ) : (
                "主题"
              )}
            </th>
            <th scope="col" className="w-32 px-3 py-2 text-left text-xs font-normal text-muted-foreground">
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
            const batchSelected = selectedIds.has(theme.id);
            // 批量导出 / 批量删除占用重操作锁时，行内动作也让位：第二个动作会被锁立即拒绝
            const exporting = isExporting(theme.id) || exportingAll || batchDeleting;
            const deleting = Boolean(busy[actionBusyKey("delete", theme.id)]) || batchDeleting;
            const stats = slotStats(theme);
            const cover = coverSlot(theme);
            const missing = missingSlotsOf(fileGaps, theme.id);
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
                  <div className="flex min-w-0 items-center gap-2.5">
                    {batchMode && (
                      <Checkbox
                        checked={batchSelected}
                        onCheckedChange={() => toggleSelected(theme.id)}
                        label={
                          isActive
                            ? `「${theme.name}」使用中，不能批量删除`
                            : batchSelected
                              ? `取消选择「${theme.name}」`
                              : `选择「${theme.name}」`
                        }
                        title={
                          isActive
                            ? "使用中的主题需要先切换或还原系统默认才能删除"
                            : undefined
                        }
                        disabled={isActive || batchDeleting}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => selectTheme(theme.id)}
                      aria-pressed={selected}
                      className="focus-ring relative flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left after:absolute after:inset-0"
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
                        <span className="z-10 shrink-0">
                          <StatusBadge tone="success" dot>
                            使用中
                          </StatusBadge>
                        </span>
                      )}
                    </button>
                  </div>
                </td>

                <td className="px-3 py-2.5">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground">{stats.filled}</span>
                    {" / "}
                    {stats.total}
                  </span>
                  <SlotMeter compact filled={stats.filled} total={stats.total} className="mt-1 w-14" />
                  {/* 「没提供槽位」是部分覆盖（上面的口径），「文件丢了」是缺口——两种缺要分开说（决策 31） */}
                  {missing.length > 0 && (
                    <span
                      data-gap-hint={theme.id}
                      title="声明的槽位文件读不到，应用后这些槽位会被写成空"
                      className="mt-1 block text-2xs text-warning"
                    >
                      缺 {missing.length} 个文件
                    </span>
                  )}
                </td>

                <td className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">
                  <span className="block">{importDate}</span>
                  {importTime && <span className="block text-2xs">{importTime}</span>}
                </td>

                <td className="relative z-10 px-3 py-2.5">
                  <span className="flex items-center justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`导出「${theme.name}」`}
                      title={exporting ? "导出中…" : "导出 ZIP"}
                      onClick={(event) => {
                        event.stopPropagation();
                        void pickAndExport(theme);
                      }}
                      disabled={exporting || deleting}
                      className="text-muted-foreground [&_svg:not([class*='size-'])]:size-3.5"
                    >
                      <Archive />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={
                        isActive
                          ? `「${theme.name}」使用中，需先恢复默认才能删除`
                          : `删除「${theme.name}」`
                      }
                      title={
                        deleting
                          ? "删除中…"
                          : isActive
                            ? "使用中的主题需要先恢复默认才能删除"
                            : "删除此主题"
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        // 使用中的主题不能用原生 disabled——那会把 title 一起藏掉，
                        // 用户永远不知道为什么点不了；改成可聚焦 + 点击守卫说明原因
                        if (isActive) return;
                        requestDelete(theme);
                      }}
                      aria-disabled={isActive || deleting || exportingAll}
                      disabled={deleting || exportingAll}
                      className={cn(
                        "text-muted-foreground",
                        !isActive && "hover:text-destructive hover:ring-1 hover:ring-destructive/40",
                      )}
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
      </ContentFrame>

      <DeleteThemeDialog
        theme={pendingDelete}
        open={singleConfirmOpen}
        onOpenChange={setSingleConfirmOpen}
      />
      <BatchDeleteDialog
        themes={selectedThemes}
        open={batchConfirmOpen}
        onOpenChange={setBatchConfirmOpen}
      />
    </div>
  );
}
