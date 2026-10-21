import { useEffect } from "react";
import { FolderDown, History } from "lucide-react";

import { Sidebar } from "@/components/layout/Sidebar";
import { ThemeDetail } from "@/components/theme/ThemeDetail";
import { ThemeList } from "@/components/theme/ThemeList";
import { Badge } from "@/components/ui/badge";
import { selectSelectedTheme, useThemeStore, type Page } from "@/stores/themeStore";
import "./App.css";

type UnfinishedPage = Exclude<Page, "library">;

/** 尚未实现页面的占位信息 */
const PLACEHOLDER: Record<
  UnfinishedPage,
  { title: string; desc: string; icon: typeof FolderDown }
> = {
  imported: {
    title: "已导入的主题",
    desc: "导入 ZIP 主题包功能将在阶段 6 实现",
    icon: FolderDown,
  },
  recent: {
    title: "最近使用",
    desc: "使用历史记录功能尚未实现",
    icon: History,
  },
};

function PlaceholderPage({ page }: { page: UnfinishedPage }) {
  const { title, desc, icon: Icon } = PLACEHOLDER[page];

  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-muted">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-medium">{title}</h2>
      <p className="max-w-xs text-sm text-muted-foreground">{desc}</p>
      <Badge variant="outline" className="mt-1">
        功能开发中
      </Badge>
    </section>
  );
}

function App() {
  const loadThemes = useThemeStore((s) => s.loadThemes);
  const currentPage = useThemeStore((s) => s.currentPage);
  const selectedTheme = useThemeStore(selectSelectedTheme);

  useEffect(() => {
    loadThemes();
  }, [loadThemes]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <ThemeList />
      {currentPage !== "library" ? (
        <PlaceholderPage page={currentPage} />
      ) : selectedTheme ? (
        <ThemeDetail theme={selectedTheme} />
      ) : (
        <section className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          在左侧选择一个主题查看详情
        </section>
      )}
    </div>
  );
}

export default App;
