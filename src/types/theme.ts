/** 与 Rust 端 `models::CursorSlot` 字段一一对应 */
export interface CursorSlot {
  registry_key: string;
  display_name: string;
  english_name: string;
  file_path: string;
  file_type: string;
}

/** 与 Rust 端 `models::CursorTheme` 字段一一对应 */
export interface CursorTheme {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  is_built_in: boolean;
  cursors: CursorSlot[];
}

/** 与 Rust 端 `models::ThemesResult` 字段一一对应 */
export interface ThemesResult {
  /** 能读到的主题（系统方案 + 用户主题），部分来源失败时仍返回其余部分 */
  themes: CursorTheme[];
  /** 非致命问题的中文描述，对应没能加载的数据源 */
  warnings: string[];
  /**
   * 注册表里当前生效的主题 ID，由后端比对光标路径得出
   *
   * null = 识别不出（系统默认光标，或用户手工改过设置）。
   * 不要指望从本地存储恢复它：重启后注册表才是事实来源。
   */
  active_theme_id: string | null;
}
