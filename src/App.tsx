import { useEffect, useRef } from "react";
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
import { SettingsView } from "@/components/views/SettingsView";
import { ImportCenterDialog } from "@/components/import/ImportCenterDialog";
import { Toaster } from "@/components/ui/toaster";
import { useDragDropImport } from "@/hooks/useDragDropImport";
import { useInspectorWidth } from "@/hooks/useInspectorWidth";
import { PAGE_META, type Page, type PageMeta } from "@/lib/pages";
import { initAutoSwitch } from "@/lib/auto-switch";
import { initCursorGuard } from "@/lib/cursor-guard";
import { initShortcuts } from "@/lib/shortcuts";
import { toast } from "@/lib/toast";
import { checkForUpdates } from "@/lib/update-check";
import { inTauri } from "@/services/theme";
import { selectSelectedTheme, useThemeStore } from "@/stores/themeStore";
import { useSettingsStore } from "@/stores/settingsStore";
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
  settings: SettingsView,
};

function App() {
  const loadThemes = useThemeStore((s) => s.loadThemes);
  const currentPage = useThemeStore((s) => s.currentPage);
  const selectedTheme = useThemeStore(selectSelectedTheme);
  const loadError = useThemeStore((s) => s.loadError);
  const pickupPendingImport = useThemeStore((s) => s.pickupPendingImport);
  const refreshActive = useThemeStore((s) => s.refreshActive);
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const [inspectorWidth, resizeInspector] = useInspectorWidth();
  const { dragActive } = useDragDropImport();
  const updateChecked = useRef(false);

  useEffect(() => {
    loadThemes();
    loadSettings();
  }, [loadThemes, loadSettings]);

  // 应用内快捷键（Ctrl+1~4 切页 / Ctrl+O 导入 / Ctrl+F 搜索）：
  // 注册一次，卸载时注销；开关在「设置 → 快捷键」
  useEffect(() => initShortcuts(), []);

  // 跟随系统深浅色自动切换主题（「设置 → 通用」可配）：系统翻转 / 窗口聚焦 /
  // 设置与主题列表变更三类时机评估一次；还原默认会挂起，见 lib/auto-switch.ts
  useEffect(() => initAutoSwitch(), []);

  // 光标守护（「设置 → 通用」可配，默认关闭）：启动检查 + 聚焦发现外部改写后
  // 自动恢复上次使用的主题；不轮询，见 lib/cursor-guard.ts
  useEffect(() => initCursorGuard(), []);

  // 启动时自动检查更新（「设置 → 通用」可关）：只在发现新版本时提示，
  // 检查失败静默——启动不是报错的场合。每次启动最多查一次
  useEffect(() => {
    if (updateChecked.current || !settings) return;
    updateChecked.current = true;
    if (!inTauri || !settings.auto_check_update) return;
    let alive = true;
    void checkForUpdates().then((outcome) => {
      if (alive && outcome.status === "update-available") {
        toast.info(outcome.message, "在「设置 → 关于」里点「检查更新」前往下载");
      }
    });
    return () => {
      alive = false;
    };
  }, [settings]);

  // 右键菜单 / 二次启动转交的待导入路径：启动时领一次，
  // 之后每次窗口聚焦再领（第二个实例写完文件会拉起本窗口）。
  // 聚焦同时轻量重查「当前使用」：系统指针样式页随时可能整体改写注册表，
  // 不重查状态卡会带着旧的「正在使用」骗人（决策 24，2026-10-26 真机实验）
  useEffect(() => {
    const pick = () => {
      void pickupPendingImport();
      void refreshActive();
    };
    pick();
    window.addEventListener("focus", pick);
    return () => window.removeEventListener("focus", pick);
  }, [pickupPendingImport, refreshActive]);

  // 显式标注成 PageMeta：字面量收窄后，dependsOnThemes 这类可选字段访问不过编译
  const meta: PageMeta = PAGE_META[currentPage];
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
            {loadError && meta.dependsOnThemes !== false ? (
              // 整次读取失败：连检查器一起让位。此时三页都没有数据，
              // 继续显示空状态会让用户以为"主题真的没了"。
              // 例外是设置页（dependsOnThemes: false）——「打开数据目录」
              // 恰恰是加载失败时的排查入口，不能被错误态顶掉
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
      <ImportCenterDialog />
      <Toaster />
    </>
  );
}

export default App;
