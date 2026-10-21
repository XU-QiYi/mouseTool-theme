use crate::models::CursorTheme;
use crate::utils::registry;

/// 获取所有光标主题（当前阶段只含系统注册表方案）
#[tauri::command]
pub fn get_all_themes() -> Result<Vec<CursorTheme>, String> {
    registry::read_system_schemes()
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
