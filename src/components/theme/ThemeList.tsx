import { useMemo } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeCard } from "@/components/theme/ThemeCard";
import { cn } from "@/lib/utils";
import { buildRecentItems, filterThemes, useThemeStore } from "@/stores/themeStore";

const EMPTY_TEXT: Record<string, string> = {
  library: "暂无主题，点击左侧「导入主题」",
  imported: "还没有导入过主题",
  recent: "最近没有使用记录",
};

export function ThemeList() {
  const searchQuery = useThemeStore((s) => s.searchQuery);
  const setSearchQuery = useThemeStore((s) => s.setSearchQuery);
  const selectedThemeId = useThemeStore((s) => s.selectedThemeId);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const recent = useThemeStore((s) => s.recent);
  const selectTheme = useThemeStore((s) => s.selectTheme);
  const currentPage = useThemeStore((s) => s.currentPage);
  const loading = useThemeStore((s) => s.loading);
  const themes = useThemeStore((s) => s.themes);

  const visibleThemes = useMemo(
    () => filterThemes(themes, currentPage, searchQuery),
    [themes, currentPage, searchQuery],
  );

  const recentItems = useMemo(
    () => (currentPage === "recent" ? buildRecentItems(themes, recent, searchQuery) : []),
    [currentPage, themes, recent, searchQuery],
  );
  // 主题被删掉后记录仍在：这些条目点不动，只报个数，不摆一排死卡片
  const availableRecent = recentItems.filter((item) => item.theme !== null);
  const deletedCount = recentItems.length - availableRecent.length;
  const emptyRecentText =
    recent.length > 0 && !searchQuery.trim() ? "最近记录里的主题已被删除" : EMPTY_TEXT.recent;

  return (
    <section className="flex h-full w-72 shrink-0 flex-col border-r">
      <div className="relative px-3 pt-3 pb-2">
        <Search className="absolute top-1/2 left-6 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
          placeholder="搜索主题…"
          className="pl-10"
        />
      </div>

      {/* 滚动条跟随系统：桌面端优先平台一致，与右侧详情区保持同一套滚动行为 */}
      <div className="flex-1 overflow-y-auto">
        {/* pt-2 不能省：卡片选中环是画在盒子外面的 box-shadow，
            贴着滚动容器上沿会被 overflow 裁掉，第一张卡看起来像没有上边框 */}
        <div className={cn("space-y-2 px-3 pt-2 pb-3", !loading && "enter-fade")}>
          {loading ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)
          ) : currentPage === "recent" ? (
            <>
              {availableRecent.map(({ entry, theme }) =>
                theme ? (
                  <ThemeCard
                    key={entry.theme_id}
                    theme={theme}
                    // 历史页看的是「什么时候用过」，不是「有几个光标」
                    meta={`上次使用 ${entry.applied_at}`}
                    active={theme.id === activeThemeId}
                    selected={theme.id === selectedThemeId}
                    onSelect={selectTheme}
                  />
                ) : null,
              )}
              {availableRecent.length === 0 && (
                <p className="mt-16 text-center text-sm text-muted-foreground">
                  {emptyRecentText}
                </p>
              )}
              {deletedCount > 0 && availableRecent.length > 0 && (
                <p className="px-1 pt-1 text-center text-2xs text-muted-foreground">
                  另有 {deletedCount} 条记录的主题已被删除
                </p>
              )}
            </>
          ) : visibleThemes.length > 0 ? (
            visibleThemes.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                active={theme.id === activeThemeId}
                selected={theme.id === selectedThemeId}
                onSelect={selectTheme}
              />
            ))
          ) : (
            <p className="mt-16 text-center text-sm text-muted-foreground">
              {EMPTY_TEXT[currentPage]}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
