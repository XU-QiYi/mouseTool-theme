import { useState } from "react";
import type { CSSProperties } from "react";
import { Archive, Check, MousePointer2, ScanSearch, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import { CursorGrid } from "@/components/theme/CursorGrid";
import { SlotMeter } from "@/components/theme/SlotMeter";
import { DeleteThemeDialog } from "@/components/theme/DeleteThemeDialog";
import { ThemeNameField } from "@/components/theme/ThemeNameField";
import { useExportTheme } from "@/hooks/useExportTheme";
import { coverSlot, slotStats } from "@/lib/slots";
import { missingSlotNames, missingSlotsOf } from "@/lib/themes";
import { actionBusyKey, useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

interface ThemeInspectorProps {
  theme: CursorTheme | null;
  /** 由分隔条拖动决定，见 `useInspectorWidth` */
  width: number;
}

/**
 * 右侧检查器：选中主题的全部上下文与操作
 *
 * 图库与「我的主题」共用它 —— 两个页面的「集合视图」完全不同（网格 / 表格），
 * 但「选中之后能做什么」应该一致，所以只在这里写一份。
 * 动作条固定在头部下方，不随槽位列表滚走；宽度由外部分隔条拖动。
 * 「使用中」是标题区的小徽标，不再占一整条面板——状态跟着名字走，
 * 主动作位只在真正能应用时才出现。
 */
export function ThemeInspector({ theme, width }: ThemeInspectorProps) {
  const style: CSSProperties = { width };
  if (!theme) return <EmptyInspector style={style} />;
  return <InspectorBody theme={theme} style={style} />;
}

function EmptyInspector({ style }: { style: CSSProperties }) {
  return (
    <aside
      aria-label="主题详情"
      style={style}
      className="flex shrink-0 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <div className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
        <ScanSearch className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">还没有选中主题</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          在中间点一个主题，这里会显示它的槽位预览、覆盖情况和可执行的操作
        </p>
      </div>
    </aside>
  );
}

function InspectorBody({ theme, style }: { theme: CursorTheme; style: CSSProperties }) {
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const fileGaps = useThemeStore((s) => s.fileGaps);
  const applyTheme = useThemeStore((s) => s.applyTheme);
  const busy = useThemeStore((s) => s.busy);
  const { isExporting, pickAndExport } = useExportTheme();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isActive = theme.id === activeThemeId;
  const applying = Boolean(busy[actionBusyKey("apply", theme.id)]);
  const deleting = Boolean(busy[actionBusyKey("delete", theme.id)]);
  const exporting = isExporting(theme.id);
  const stats = slotStats(theme);
  const cover = coverSlot(theme);
  const missingNames = missingSlotNames(theme, missingSlotsOf(fileGaps, theme.id));

  // 系统自带方案没有文件可删；正在使用的主题删掉会让注册表指向空文件
  const canDelete = !theme.is_built_in && !isActive;
  const deleteHint = theme.is_built_in
    ? "系统自带方案不能删除"
    : isActive
      ? "正在使用这个主题，请先切换到其它主题"
      : "删除此主题";

  // 来源与导入时间合成一行放底部：原先四行 dl 会把 15 个槽位挤出可视区，
  // 逼用户滚动才能看全一套光标，而这些字面元数据在「我的主题」表格里本来就有
  const footnote = [
    theme.is_built_in ? "系统方案（注册表）" : theme.description || "导入的主题",
    theme.updated_at ? `导入于 ${theme.updated_at}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside aria-label="主题详情" style={style} className="flex shrink-0 flex-col">
      {/* key 让换选中项时整块重放淡入：换的是内容，不是弹了个新面板 */}
      <div key={theme.id} className="enter-fade flex min-h-0 flex-1 flex-col">
        {/* 封面加大到 80px 后，头部与滚动区同步收一档内边距：
            15 槽位在默认 320px 宽下仍要一屏放下（design_check 断言不溢出） */}
        <div className="shrink-0 border-b p-3">
          <div className="flex items-start gap-3">
            <span className="preview-surface grid size-20 shrink-0 place-items-center rounded-lg ring-1 ring-border/60">
              {cover ? (
                <CursorPreviewImage slot={cover} size="xl" />
              ) : (
                <MousePointer2 className="size-5 text-muted-foreground" />
              )}
            </span>

            <div className="min-w-0 flex-1">
              <h2 className="flex min-w-0 items-center gap-1.5">
                <ThemeNameField theme={theme} nameClassName="text-base font-medium" />
                {isActive && (
                  <span className="shrink-0">
                    <StatusBadge tone="success" dot>
                      使用中
                    </StatusBadge>
                  </span>
                )}
              </h2>
              <p className="mt-0.5 truncate text-2xs text-muted-foreground">
                {theme.is_built_in ? "系统方案" : "我的主题"}
                {` · ${stats.filled} / ${stats.total} 槽位`}
                {stats.animated > 0 ? ` · ${stats.animated} 个动态` : ""}
              </p>
            </div>
          </div>

          <div className="mt-2.5 flex items-center gap-1.5">
            {/* 已在用的主题不摆「应用」按钮：状态徽标已说明一切，
                灰掉的按钮会让人以为"再点一次能刷新" */}
            {!isActive && (
              <Button
                className="flex-1"
                onClick={() => applyTheme(theme.id)}
                disabled={applying || deleting}
                aria-busy={applying}
              >
                <Check data-icon="inline-start" />
                {applying ? "应用中…" : "应用此主题"}
              </Button>
            )}
            <Button
              variant="outline"
              size="icon"
              aria-label="导出 ZIP"
              title={exporting ? "导出中…" : "导出 ZIP"}
              onClick={() => pickAndExport(theme)}
              disabled={exporting || deleting}
              className={isActive ? "ml-auto" : undefined}
            >
              <Archive />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="删除此主题"
              title={deleting ? "删除中…" : deleteHint}
              onClick={() => setConfirmOpen(true)}
              disabled={!canDelete || deleting || applying}
            >
              <Trash2 />
            </Button>
          </div>

          {/* 文件缺口警示（决策 31）：放头部不随槽位列表滚走——
              「应用后这些槽位会被写成空」是应用前必须看见的后果，不是详情 */}
          {missingNames.length > 0 && (
            <div
              data-missing-files
              role="status"
              className="mt-2.5 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 ring-1 ring-warning/25"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <p className="text-xs leading-relaxed text-warning">
                {missingNames.length} 个槽位的光标文件缺失或不可读（{missingNames.join("、")}
                ）。应用后这些槽位会被写成空，建议重新导入，或在「我的主题」删除该主题。
              </p>
            </div>
          )}
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-medium">槽位</h3>
            <span className="text-2xs text-muted-foreground tabular-nums">
              {stats.filled} / {stats.total}
            </span>
          </div>
          <SlotMeter filled={stats.filled} total={stats.total} className="mt-1.5" />
          {stats.missing > 0 && (
            <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
              缺 {stats.missing} 个，未覆盖的槽位沿用当前系统光标
            </p>
          )}

          <div className="mt-3">
            <CursorGrid theme={theme} compact />
          </div>

          <p className="mt-3 truncate text-2xs text-muted-foreground" title={footnote}>
            {footnote}
          </p>
        </div>
      </div>

      <DeleteThemeDialog theme={theme} open={confirmOpen} onOpenChange={setConfirmOpen} />
    </aside>
  );
}
