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
