pub mod commands;
pub mod models;
pub mod utils;

use commands::cursor::get_cursor_preview;
use commands::data::{get_data_dir, open_data_dir};
use commands::system::{
    get_windows_version, get_zip_menu_registered, open_mouse_panel, set_zip_menu,
    take_pending_import,
};
use commands::theme::{
    apply_theme, delete_theme, export_theme, get_all_themes, import_theme, rename_theme,
    restore_default,
};
use utils::integration;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 单实例 + 右键菜单 `--import` 转交：已有实例时这里可能直接退出进程
    integration::handle_launch();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_all_themes,
            get_cursor_preview,
            apply_theme,
            restore_default,
            import_theme,
            delete_theme,
            rename_theme,
            export_theme,
            get_data_dir,
            open_data_dir,
            get_windows_version,
            open_mouse_panel,
            get_zip_menu_registered,
            set_zip_menu,
            take_pending_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
