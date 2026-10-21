pub mod commands;
pub mod models;
pub mod utils;

use commands::cursor::get_cursor_preview;
use commands::theme::{
    apply_theme, delete_theme, export_theme, get_all_themes, import_theme, rename_theme,
    restore_default,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            export_theme
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
