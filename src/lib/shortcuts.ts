/**
 * 应用内快捷键清单 —— 界面展示与按键处理共用一份定义
 *
 * 全部带 Ctrl 修饰，不与输入框抢按键；作用域是应用内（不是全局热键），
 * 应用失焦时自然不触发。
 */
import { pickAndImportZip } from "@/lib/import-zip";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThemeStore } from "@/stores/themeStore";

export interface ShortcutDef {
  id: string;
  /** 展示用的按键串 */
  keys: string;
  /** 这套键干什么 */
  label: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "page-gallery", keys: "Ctrl+1", label: "切换到「主题图库」" },
  { id: "page-mine", keys: "Ctrl+2", label: "切换到「我的主题」" },
  { id: "page-recent", keys: "Ctrl+3", label: "切换到「最近使用」" },
  { id: "page-settings", keys: "Ctrl+4", label: "切换到「设置」" },
  { id: "import", keys: "Ctrl+O", label: "导入主题（打开文件选择框）" },
  { id: "search", keys: "Ctrl+F", label: "聚焦搜索框（有搜索的页面）" },
];

/**
 * 注册应用内快捷键，返回注销函数
 *
 * 只响应 Ctrl 组合、不带 Alt/Meta，不与输入框抢纯按键；Ctrl+F 只拦
 * 「有搜索框」的页面，没有搜索的页面放行给 WebView 自带的查找。
 * 开关存在设置里（`shortcuts_enabled`），关了立即停用。
 */
export function initShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;

    // 设置还没读到时按默认（启用）处理，别让快捷键在启动瞬间集体失灵
    const settings = useSettingsStore.getState().settings;
    if (settings && !settings.shortcuts_enabled) return;

    switch (event.code) {
      case "Digit1":
        event.preventDefault();
        useThemeStore.getState().setCurrentPage("gallery");
        break;
      case "Digit2":
        event.preventDefault();
        useThemeStore.getState().setCurrentPage("mine");
        break;
      case "Digit3":
        event.preventDefault();
        useThemeStore.getState().setCurrentPage("recent");
        break;
      case "Digit4":
        event.preventDefault();
        useThemeStore.getState().setCurrentPage("settings");
        break;
      case "KeyO":
        event.preventDefault();
        // 导入中再按不重复拉起对话框：正在导入时按钮也是禁用的
        if (!useThemeStore.getState().importing) {
          void pickAndImportZip();
        }
        break;
      case "KeyF": {
        const search = document.querySelector<HTMLInputElement>(
          'input[placeholder^="搜索"]',
        );
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
        break;
      }
      default:
        break;
    }
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
