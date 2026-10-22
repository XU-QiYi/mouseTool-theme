import { useMemo } from "react";
import type { ReactNode } from "react";
import { LayoutGrid, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/layout/EmptyState";
import { GalleryCard } from "@/components/theme/GalleryCard";
import { useImportTheme } from "@/hooks/useImportTheme";
import { filterByName, splitBySource } from "@/lib/themes";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 主题图库：逛
 *
 * 用「分组网格」而不是列表：这一页的任务是挑，卡片要大、封面要能看清；
 * 系统方案与我的主题各成一段，两类东西不再混在同一列里分不出来。
 */
export function GalleryView() {
  const themes = useThemeStore((s) => s.themes);
  const query = useThemeStore((s) => s.searchQuery);
  const setSearchQuery = useThemeStore((s) => s.setSearchQuery);
  const loading = useThemeStore((s) => s.loading);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const selectedId = useThemeStore((s) => s.selection.gallery);
  const selectTheme = useThemeStore((s) => s.selectTheme);
  const { picking, pick } = useImportTheme();

  // 派生数据必须是纯函数 + useMemo：写进 selector 会每次返回新对象，
  // useSyncExternalStore 判定快照变化 → 无限重渲染白屏
  const groups = useMemo(() => splitBySource(filterByName(themes, query)), [themes, query]);
  const matched = groups.builtIn.length + groups.mine.length;

  if (loading) {
    return (
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (themes.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={LayoutGrid}
          title="还没有可用的主题"
          description="导入一个 .zip 主题包，或在系统设置里保存一套光标方案，方案会出现在这里"
          action={
            <Button onClick={pick} disabled={picking}>
              {picking ? "选择中…" : "导入主题"}
            </Button>
          }
        />
      </div>
    );
  }

  if (matched === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState
          icon={SearchX}
          title={`没有匹配「${query.trim()}」的方案`}
          description="换个关键词试试，或者清除搜索看全部方案"
          action={
            <Button variant="outline" onClick={() => setSearchQuery("")}>
              清除搜索
            </Button>
          }
        />
      </div>
    );
  }

  const renderCards = (list: typeof themes) =>
    list.map((theme) => (
      <GalleryCard
        key={theme.id}
        theme={theme}
        active={theme.id === activeThemeId}
        selected={theme.id === selectedId}
        onSelect={selectTheme}
      />
    ));

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {groups.builtIn.length > 0 && (
        <Section title="系统方案" count={groups.builtIn.length}>
          {renderCards(groups.builtIn)}
        </Section>
      )}
      {groups.mine.length > 0 && (
        <Section title="我的主题" count={groups.mine.length}>
          {renderCards(groups.mine)}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mb-7 last:mb-0">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-xs font-medium">{title}</h2>
        <span className="text-2xs text-muted-foreground tabular-nums">{count} 个</span>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
        {children}
      </div>
    </section>
  );
}
