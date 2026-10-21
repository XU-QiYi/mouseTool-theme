use crate::models::CursorTheme;
use crate::utils::{importer, registry};

/// 获取所有主题：系统注册表方案 + 已导入的用户主题
#[tauri::command]
pub fn get_all_themes() -> Result<Vec<CursorTheme>, String> {
    let mut themes = registry::read_system_schemes()?;
    themes.extend(importer::read_user_themes());
    Ok(themes)
}

/// 导入 zip 主题包，返回新主题
#[tauri::command]
pub fn import_theme(zip_path: String) -> Result<CursorTheme, String> {
    importer::import_zip(&zip_path)
}

/// 把主题应用到系统：写注册表后立即刷新，无需注销
#[tauri::command]
pub fn apply_theme(theme: CursorTheme) -> Result<(), String> {
    registry::write_cursors(&theme.cursors, &theme.name)?;
    registry::refresh_cursors()
}

/// 恢复系统默认光标
#[tauri::command]
pub fn restore_default() -> Result<(), String> {
    registry::clear_cursors()?;
    registry::refresh_cursors()
}
