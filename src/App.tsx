import { useEffect } from "react";
import { History } from "lucide-react";

import { Sidebar } from "@/components/layout/Sidebar";
import { ThemeDetail } from "@/components/theme/ThemeDetail";
import { ThemeList } from "@/components/theme/ThemeList";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/toaster";
import { selectSelectedTheme, useThemeStore } from "@/stores/themeStore";
import "./App.css";

/** 唯一真正没做的页面；「已导入」只是过滤视图，不该再拿占位页糊住 */
function RecentPlaceholder() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-muted">
        <History className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-medium">最近使用</h2>
      <p className="max-w-xs text-sm text-muted-foreground">使用历史记录功能尚未实现</p>
      <Badge variant="outline" className="mt-1">
        功能开发中
      </Badge>
    </section>
  );
}

const EMPTY_HINT: Record<string, string> = {
  library: "在左侧选择一个主题查看详情",
  imported: "还没有导入过主题，点左上角「导入主题」添加",
};

function App() {
  const loadThemes = useThemeStore((s) => s.loadThemes);
  const currentPage = useThemeStore((s) => s.currentPage);
  const selectedTheme = useThemeStore(selectSelectedTheme);

  useEffect(() => {
    loadThemes();
  }, [loadThemes]);

  return (
    <>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <ThemeList />
        {/* 选中优先：详情区承载应用/导出/删除/改名，任何页面都不该被占位页顶掉 */}
        {selectedTheme ? (
          <ThemeDetail theme={selectedTheme} />
        ) : currentPage === "recent" ? (
          <RecentPlaceholder />
        ) : (
          <section className="flex flex-1 items-center justify-center px-8 text-center text-sm text-muted-foreground">
            {EMPTY_HINT[currentPage] ?? EMPTY_HINT.library}
          </section>
        )}
      </div>
      <Toaster />
    </>
  );
}

export default App;
