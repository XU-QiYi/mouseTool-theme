import { ArrowLeft, FolderDown, MousePointer2, RotateCcw } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { BrandMark } from "@/components/brand/BrandMark";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import { useImportTheme } from "@/hooks/useImportTheme";
import { PAGE_META, PAGE_ORDER, type PageMeta } from "@/lib/pages";
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_ORDER,
  type SettingsSectionMeta,
} from "@/lib/settings-sections";
import { coverSlot, slotStats } from "@/lib/slots";
import { cn } from "@/lib/utils";
import { actionBusyKey, useThemeStore } from "@/stores/themeStore";

/**
 * 侧栏两种形态：
 *
 * - 主导航（图库 / 我的主题 / 最近使用 / 设置）+ 常驻状态卡——主题管理的上下文；
 * - 设置分组（通用 / 快捷键 / 数据 / 系统集成 / 关于）+ 返回——进设置后侧栏
 *   整体切换成分组列表，点分组换内容页，返回键回到来路页面。
 *
 * 外观三态已迁入「设置 → 通用」（决策 14），侧栏不再放主题开关。
 */
export function Sidebar() {
  const currentPage = useThemeStore((s) => s.currentPage);
  const inSettings = currentPage === "settings";

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <Brand />

      {inSettings ? <SettingsNav /> : <MainNav />}

      <Separator />
      <div className="h-3" />
    </aside>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-4 pt-5 pb-4">
      <BrandMark className="size-5 shrink-0" />
      <div className="min-w-0">
        <p className="truncate text-sm leading-tight font-medium">鼠标主题工具</p>
        <p className="text-2xs text-muted-foreground">v0.1.0</p>
      </div>
    </div>
  );
}

/** 主导航：四页 + 导入按钮 + 常驻状态卡 */
function MainNav() {
  const currentPage = useThemeStore((s) => s.currentPage);
  const setCurrentPage = useThemeStore((s) => s.setCurrentPage);
  const themes = useThemeStore((s) => s.themes);
  const recent = useThemeStore((s) => s.recent);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const activeTheme = useThemeStore(
    (s) => s.themes.find((theme) => theme.id === s.activeThemeId) ?? null,
  );
  const restoreDefault = useThemeStore((s) => s.restoreDefault);
  const loadError = useThemeStore((s) => s.loadError);
  const importing = useThemeStore((s) => s.importing);
  const importProgress = useThemeStore((s) => s.importProgress);
  const busy = useThemeStore((s) => s.busy);
  const { picking, pick } = useImportTheme();

  const cover = activeTheme ? coverSlot(activeTheme) : undefined;
  const stats = activeTheme ? slotStats(activeTheme) : null;
  const restoring = Boolean(busy[actionBusyKey("restore", "default")]);

  return (
    <>
      <div className="px-3 pb-4">
        <Button className="w-full" onClick={pick} disabled={picking || importing}>
          <FolderDown data-icon="inline-start" />
          {picking ? "选择中…" : importing ? "导入中…" : "导入主题"}
        </Button>
        {importing && importProgress && (
          <p
            data-import-progress
            aria-live="polite"
            className="mt-1.5 truncate text-2xs text-muted-foreground"
            title={importProgress.message}
          >
            {importProgress.message}
            {importProgress.total > 0
              ? `（${Math.min(importProgress.current, importProgress.total)}/${importProgress.total}）`
              : ""}
          </p>
        )}
      </div>

      <nav aria-label="主导航" className="flex-1 space-y-0.5 px-3">
        {PAGE_ORDER.map((page) => {
          // 标注成 PageMeta：字面量收窄后，不写 count 的页面会让 meta.count 报错
          const meta: PageMeta = PAGE_META[page];
          const isCurrent = currentPage === page;
          // 读取失败时计数显示「—」：0 会被读成"这里真的什么都没有"
          const count = loadError ? "—" : meta.count?.({ themes, recent });
          const Icon = meta.icon;
          return (
            <button
              key={page}
              type="button"
              onClick={() => setCurrentPage(page)}
              aria-current={isCurrent ? "page" : undefined}
              className={cn(
                // 复用 shadcn 按钮的变体，保证与上方「导入主题」同一套状态与焦点环
                buttonVariants({ variant: "ghost" }),
                "relative h-auto w-full justify-start gap-2.5 px-3 py-2",
                isCurrent
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50",
              )}
            >
              {/* 当前项的左侧短竖线：只靠底色区分，深色模式下对比太弱 */}
              {isCurrent && (
                <span
                  aria-hidden
                  className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary"
                />
              )}
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{meta.label}</span>
              {count !== undefined && (
                <span className="ml-auto text-2xs tabular-nums text-muted-foreground">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* 常驻状态卡：用户在任何一个页面都能确认「现在到底用的是哪个」，
          不用回图库去找那个「使用中」徽章 */}
      <div className="px-3 pb-3">
        <div className="rounded-xl bg-sidebar-accent/60 p-2.5 ring-1 ring-sidebar-border">
          <div className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                activeTheme ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
            <span className="text-2xs text-muted-foreground">
              {activeTheme ? "当前使用中" : "系统默认"}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="preview-surface grid size-8 shrink-0 place-items-center rounded-md ring-1 ring-border/60">
              {cover ? (
                <CursorPreviewImage slot={cover} size="sm" />
              ) : (
                <MousePointer2 className="size-4 text-muted-foreground" />
              )}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">
                {activeTheme ? activeTheme.name : "未应用主题"}
              </p>
              <p className="truncate text-2xs text-muted-foreground">
                {activeTheme && stats
                  ? `${activeTheme.is_built_in ? "系统方案" : "我的主题"} · ${stats.filled} 个槽位`
                  : "光标为 Windows 自带"}
              </p>
            </div>
          </div>

          <Button
            variant="ghost"
            size="xs"
            className="mt-2 w-full justify-start text-muted-foreground"
            onClick={restoreDefault}
            disabled={!activeThemeId || restoring}
            aria-busy={restoring}
            title={
              restoring
                ? "正在还原…"
                : activeThemeId
                  ? "还原系统默认光标"
                  : "当前已是系统默认"
            }
          >
            <RotateCcw data-icon="inline-start" />
            {restoring ? "还原中…" : "还原系统默认"}
          </Button>
        </div>
      </div>
    </>
  );
}

/** 设置导航：返回 + 分组列表（点分组换内容页） */
function SettingsNav() {
  const settingsSection = useThemeStore((s) => s.settingsSection);
  const setSettingsSection = useThemeStore((s) => s.setSettingsSection);
  const backFromSettings = useThemeStore((s) => s.backFromSettings);

  return (
    <nav aria-label="设置导航" className="flex-1 space-y-0.5 px-3">
      <button
        type="button"
        onClick={backFromSettings}
        className={cn(
          buttonVariants({ variant: "ghost" }),
          "h-auto w-full justify-start gap-2.5 px-3 py-2 text-muted-foreground hover:bg-sidebar-accent/50",
        )}
      >
        <ArrowLeft className="size-4 shrink-0" />
        <span className="truncate">返回</span>
      </button>

      <div className="h-2" />

      {SETTINGS_SECTION_ORDER.map((key) => {
        // 标注成 SettingsSectionMeta：字面量收窄后，缺字段的分组过不了编译
        const meta: SettingsSectionMeta = SETTINGS_SECTIONS[key];
        const isCurrent = settingsSection === key;
        const Icon = meta.icon;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setSettingsSection(key)}
            aria-current={isCurrent ? "page" : undefined}
            className={cn(
              buttonVariants({ variant: "ghost" }),
              "relative h-auto w-full justify-start gap-2.5 px-3 py-2",
              isCurrent
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50",
            )}
          >
            {isCurrent && (
              <span
                aria-hidden
                className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary"
              />
            )}
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{meta.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
