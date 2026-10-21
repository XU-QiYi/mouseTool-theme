import { FolderDown, History, Library, MousePointer2, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useThemeStore, type Page } from "@/stores/themeStore";

const NAV_ITEMS: { page: Page; label: string; icon: typeof Library }[] = [
  { page: "library", label: "主题图库", icon: Library },
  { page: "imported", label: "已导入", icon: FolderDown },
  { page: "recent", label: "最近使用", icon: History },
];

export function Sidebar() {
  const currentPage = useThemeStore((s) => s.currentPage);
  const setCurrentPage = useThemeStore((s) => s.setCurrentPage);

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pt-5 pb-4">
        <MousePointer2 className="size-5" />
        <div>
          <h1 className="text-sm font-medium leading-tight">鼠标主题工具</h1>
          <p className="text-xs text-muted-foreground">v0.1.0</p>
        </div>
      </div>

      <div className="px-3 pb-3">
        <Button className="w-full" disabled>
          <FolderDown data-icon="inline-start" />
          导入主题
        </Button>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map(({ page, label, icon: Icon }) => (
          <button
            key={page}
            type="button"
            onClick={() => setCurrentPage(page)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
              currentPage === page
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
            }`}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </nav>

      <Separator />

      <div className="p-3">
        <Button variant="ghost" className="w-full justify-start text-muted-foreground" disabled>
          <Settings data-icon="inline-start" />
          设置
        </Button>
      </div>
    </aside>
  );
}
