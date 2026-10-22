import { useEffect } from "react";
import type { ComponentType } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { PageHeader } from "@/components/layout/PageHeader";
import { DataWarning } from "@/components/layout/DataWarning";
import { DropOverlay } from "@/components/layout/DropOverlay";
import { LoadErrorState } from "@/components/layout/LoadErrorState";
import { InspectorResizer } from "@/components/layout/InspectorResizer";
import { ThemeInspector } from "@/components/theme/ThemeInspector";
import { GalleryView } from "@/components/views/GalleryView";
import { MyThemesView } from "@/components/views/MyThemesView";
import { RecentView } from "@/components/views/RecentView";
import { Toaster } from "@/components/ui/toaster";
import { useDragDropImport } from "@/hooks/useDragDropImport";
import { useInspectorWidth } from "@/hooks/useInspectorWidth";
import { PAGE_META, type Page } from "@/lib/pages";
import { selectSelectedTheme, useThemeStore } from "@/stores/themeStore";
import "./App.css";

/**
 * 页面 → 视图组件
 *
 * `Record<Page, …>` 逼着每个页面都有视图：新增页面时忘了写这一行会编译报错，
 * 而不是运行时中间区域一片空白。检查器开关同理，来自 `PAGE_META[page].hasInspector`，
 * 不再是 `currentPage !== "recent"` 这种漏一个页面就默认塞进去的判断。
 */
const VIEWS: Record<Page, ComponentType> = {
  gallery: GalleryView,
  mine: MyThemesView,
  recent: RecentView,
};

function App() {
  const loadThemes = useThemeStore((s) => s.loadThemes);
  const currentPage = useThemeStore((s) => s.currentPage);
  const selectedTheme = useThemeStore(selectSelectedTheme);
  const loadError = useThemeStore((s) => s.loadError);
  const [inspectorWidth, resizeInspector] = useInspectorWidth();
  const { dragActive } = useDragDropImport();

  useEffect(() => {
    loadThemes();
  }, [loadThemes]);

  const meta = PAGE_META[currentPage];
  const View = VIEWS[currentPage];

  return (
    <>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          <PageHeader />
          <DataWarning />

          {/* key 让换页时整块淡入：换的是内容，不是换了个标题 */}
          <div key={currentPage} className="enter-fade flex min-h-0 flex-1">
            {loadError ? (
              // 整次读取失败：连检查器一起让位。此时三页都没有数据，
              // 继续显示空状态会让用户以为"主题真的没了"
              <LoadErrorState message={loadError} onRetry={loadThemes} />
            ) : (
              <>
                <div data-view={currentPage} className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <View />
                </div>

                {meta.hasInspector && (
                  <>
                    <InspectorResizer width={inspectorWidth} onChange={resizeInspector} />
                    <ThemeInspector theme={selectedTheme} width={inspectorWidth} />
                  </>
                )}
              </>
            )}
          </div>
        </main>
      </div>
      <DropOverlay active={dragActive} />
      <Toaster />
    </>
  );
}

export default App;
