use crate::models::CursorPreview;
use crate::utils::cursor;

/// 获取光标文件的预览数据；文件不存在或解析失败均返回空预览，不报错
#[tauri::command]
pub fn get_cursor_preview(file_path: String) -> CursorPreview {
    cursor::preview_file(&file_path)
}
