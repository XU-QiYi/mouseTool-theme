import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { PAGE_META, type PageMeta } from "@/lib/pages";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 页头：标题 + 这一页要做什么 + 该页独有的工具 + 计数
 *
 * 内容全部来自 `lib/pages.ts` 的 `PAGE_META` —— 加页面时不用改这个组件；
 * 例外是设置页：进入后侧栏按分组切换，页头跟着分组走（`settings-sections.ts`），
 * 进哪组看哪页，标题不再固定是「设置」。
 */
export function PageHeader() {
  const currentPage = useThemeStore((s) => s.currentPage);
  const settingsSection = useThemeStore((s) => s.settingsSection);
  const themes = useThemeStore((s) => s.themes);
  const recent = useThemeStore((s) => s.recent);
  const loadError = useThemeStore((s) => s.loadError);
  const searchQuery = useThemeStore((s) => s.searchQuery);
  const setSearchQuery = useThemeStore((s) => s.setSearchQuery);

  // 显式标注成 PageMeta：字面量收窄后，没写 search 的那一页会让 meta.search 报错
  const meta: PageMeta = PAGE_META[currentPage];
  const sectionMeta = currentPage === "settings" ? SETTINGS_SECTIONS[settingsSection] : null;
  const count = meta.count?.({ themes, recent });
  // 读取失败时说"0 个方案"是假信息：不是没有，是没读到
  const countLabel = loadError ? "—" : count !== undefined ? `${count} ${meta.unit}` : null;

  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b px-6 py-4">
      <div className="min-w-0">
        <h1 className="truncate text-xl leading-tight font-medium">
          {sectionMeta?.title ?? meta.title}
        </h1>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {sectionMeta?.hint ?? meta.hint}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {meta.search && (
          <div className="relative w-52">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              placeholder={meta.search}
              aria-label={meta.search}
              className="h-8 pl-7.5 text-xs"
            />
          </div>
        )}
        {countLabel && (
          <span className="text-xs text-muted-foreground tabular-nums">{countLabel}</span>
        )}
      </div>
    </header>
  );
}
