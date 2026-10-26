import { ArrowLeft, FolderDown, FolderUp } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { BrandMark } from "@/components/brand/BrandMark";
import { CurrentCursorCard } from "@/components/layout/CurrentCursorCard";
import { SidebarNavItem } from "@/components/layout/SidebarNavItem";
import { useAppVersion } from "@/hooks/use-app-version";
import { useImportTheme } from "@/hooks/useImportTheme";
import { pickAndQueueThemes } from "@/lib/import-zip";
import { PAGE_META, PAGE_ORDER, type PageMeta } from "@/lib/pages";
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_ORDER,
  type SettingsSectionMeta,
} from "@/lib/settings-sections";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 侧栏两种形态：
 *
 * - 主导航（图库 / 我的主题 / 最近使用 / 设置）+ 导入区 + 常驻状态卡——
 *   主题管理的上下文；
 * - 设置分组（通用 / 快捷键 / 数据 / 系统集成 / 关于）+ 返回 + 紧凑状态卡——
 *   进设置后侧栏整体切换成分组列表，点分组换内容页，返回键回到来路页面。
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
  const version = useAppVersion();
  return (
    <div className="flex items-center gap-2 px-4 pt-5 pb-4">
      <BrandMark className="size-5 shrink-0" />
      <div className="min-w-0">
        <p className="truncate text-sm leading-tight font-medium">鼠标主题工具</p>
        <p className="text-2xs text-muted-foreground">v{version}</p>
      </div>
    </div>
  );
}

/** 主导航：四页 + 导入区 + 常驻状态卡 */
function MainNav() {
  const currentPage = useThemeStore((s) => s.currentPage);
  const setCurrentPage = useThemeStore((s) => s.setCurrentPage);
  const themes = useThemeStore((s) => s.themes);
  const recent = useThemeStore((s) => s.recent);
  const loadError = useThemeStore((s) => s.loadError);
  const importing = useThemeStore((s) => s.importing);
  const importProgress = useThemeStore((s) => s.importProgress);
  const { picking, pick } = useImportTheme();

  return (
    <>
      <div className="px-3 pb-4">
        <div className="flex items-center gap-1.5">
          <Button className="flex-1" onClick={pick} disabled={picking || importing}>
            <FolderDown data-icon="inline-start" />
            {picking ? "选择中…" : importing ? "导入中…" : "导入主题"}
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="批量导入"
            title="批量导入：一次选多个 ZIP，逐个导入"
            onClick={() => void pickAndQueueThemes()}
            disabled={picking || importing}
          >
            <FolderUp />
          </Button>
        </div>
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
          // 侧栏计数始终是总数，不跟搜索词走：侧栏回答"这里一共有多少"，
          // 页头计数才回答"当前过滤后剩多少"
          const count = loadError ? "—" : meta.count?.({ themes, recent });
          return (
            <SidebarNavItem
              key={page}
              icon={meta.icon}
              label={meta.label}
              count={count}
              active={currentPage === page}
              onClick={() => setCurrentPage(page)}
            />
          );
        })}
      </nav>

      {/* 常驻状态卡：用户在任何一个页面都能确认「现在到底用的是哪个」，
          不用回图库去找那个「使用中」徽章 */}
      <div className="px-3 pb-3">
        <CurrentCursorCard variant="full" />
      </div>
    </>
  );
}

/** 设置导航：返回 + 分组列表（点分组换内容页）+ 紧凑状态卡 */
function SettingsNav() {
  const settingsSection = useThemeStore((s) => s.settingsSection);
  const setSettingsSection = useThemeStore((s) => s.setSettingsSection);
  const backFromSettings = useThemeStore((s) => s.backFromSettings);

  return (
    <>
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
          return (
            <SidebarNavItem
              key={key}
              icon={meta.icon}
              label={meta.label}
              active={settingsSection === key}
              onClick={() => setSettingsSection(key)}
            />
          );
        })}
      </nav>

      <div className="px-3 pb-3">
        <CurrentCursorCard variant="compact" />
      </div>
    </>
  );
}
