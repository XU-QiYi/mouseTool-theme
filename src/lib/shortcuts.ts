/**
 * 应用内快捷键清单 —— 界面展示与按键处理共用一份定义
 *
 * 全部带 Ctrl 修饰，不与输入框抢按键；作用域是应用内（不是全局热键），
 * 应用失焦时自然不触发。
 */
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
