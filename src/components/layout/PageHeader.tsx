import { SearchField } from "@/components/ui/search-field";
import { PAGE_META, type PageMeta } from "@/lib/pages";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 页头：标题 + 这一页要做什么 + 该页独有的工具 + 计数
 *
 * 内容全部来自 `lib/pages.ts` 的 `PAGE_META` —— 加页面时不用改这个组件；
 * 例外是设置页：进入后侧栏按分组切换，页头跟着分组走（`settings-sections.ts`），
 * 进哪组看哪页，标题不再固定是「设置」。
 *
 * 计数三个态：搜索词非空显示「匹配 X / 共 Y」，空词显示总数，
 * 读取失败显示「—」——说"0 个主题"是假信息：不是没有，是没读到。
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

  const count = meta.count?.({ themes, recent, query: searchQuery });
  const total = meta.count?.({ themes, recent });
  let countLabel: string | null = null;
  if (loadError) {
    countLabel = "—";
  } else if (count !== undefined) {
    const unit = meta.unit ?? "";
    countLabel =
      searchQuery.trim() !== "" && total !== undefined
        ? `匹配 ${count} / 共 ${total} ${unit}`
        : `${count} ${unit}`;
  }

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
          <SearchField
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={meta.search}
          />
        )}
        {countLabel && (
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
            {countLabel}
          </span>
        )}
      </div>
    </header>
  );
}
