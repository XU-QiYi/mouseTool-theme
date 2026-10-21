import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderDown, History, Library, MousePointer2, Settings } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import { useThemeStore, type Page } from "@/stores/themeStore";

const NAV_ITEMS: { page: Page; label: string; icon: typeof Library }[] = [
  { page: "library", label: "主题图库", icon: Library },
  { page: "imported", label: "已导入", icon: FolderDown },
  { page: "recent", label: "最近使用", icon: History },
];

export function Sidebar() {
  const currentPage = useThemeStore((s) => s.currentPage);
  const setCurrentPage = useThemeStore((s) => s.setCurrentPage);
  const importTheme = useThemeStore((s) => s.importTheme);
  const [picking, setPicking] = useState(false);

  const handleImport = async () => {
    if (!inTauri) {
      // 浏览器里没有文件系统，静默 return 会让人以为按钮坏了，必须明说
      toast.info("开发模式无法导入", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
      return;
    }
    setPicking(true);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "主题包", extensions: ["zip"] }],
      });
      if (typeof selected === "string") {
        await importTheme(selected);
      }
    } catch (err) {
      console.error("选择文件失败：", err);
    } finally {
      setPicking(false);
    }
  };

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
        <Button className="w-full" onClick={handleImport} disabled={picking}>
          <FolderDown data-icon="inline-start" />
          {picking ? "选择中…" : "导入主题"}
        </Button>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map(({ page, label, icon: Icon }) => {
          const isCurrent = currentPage === page;
          return (
            <button
              key={page}
              type="button"
              onClick={() => setCurrentPage(page)}
              aria-current={isCurrent ? "page" : undefined}
              className={cn(
                // 复用 shadcn 按钮的变体，保证与上方「导入主题」同一套状态与焦点环
                buttonVariants({ variant: "ghost" }),
                "h-auto w-full justify-start gap-2.5 px-3 py-2",
                isCurrent
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          );
        })}
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
