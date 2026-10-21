import { useEffect } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { ThemeDetail } from "@/components/theme/ThemeDetail";
import { ThemeList } from "@/components/theme/ThemeList";
import { Toaster } from "@/components/ui/toaster";
import { selectSelectedTheme, useThemeStore } from "@/stores/themeStore";
import "./App.css";

const EMPTY_HINT: Record<string, string> = {
  library: "在左侧选择一个主题查看详情",
  imported: "还没有导入过主题，点左上角「导入主题」添加",
  recent: "应用过的主题会按时间排在这里，点一条查看详情",
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
