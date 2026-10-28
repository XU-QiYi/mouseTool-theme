pub mod commands;
pub mod models;
pub mod utils;

use commands::backup::{delete_backup, export_backup, import_backup, list_backups};
use commands::cursor::get_cursor_preview;
use commands::data::{get_data_dir, open_data_dir};
use commands::settings::{
    get_autostart, get_settings, preview_themes_dir, set_autostart, set_themes_dir, update_settings,
};
use commands::system::{
    get_windows_version, get_zip_menu_registered, open_mouse_panel, set_zip_menu,
    take_pending_import,
};
use commands::theme::{
    apply_theme, delete_theme, export_theme, get_active_state, get_all_themes, import_theme,
    rename_theme, restore_default,
};
use commands::trash::{delete_from_trash, empty_trash, list_trash, restore_from_trash};
use utils::settings::{self, CloseBehavior};
use utils::{integration, tray};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 单实例 + 右键菜单 `--import` 转交：已有实例时这里可能直接退出进程
    integration::handle_launch();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 托盘按设置决定有无：关闭行为是「最小化到托盘」才有图标
            tray::sync(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭行为 = 最小化到托盘：拦下关闭，藏窗继续跑（托盘能叫回来）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main"
                    && settings::read().close_behavior == CloseBehavior::Tray
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_all_themes,
            get_active_state,
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
            take_pending_import,
            get_settings,
            update_settings,
            get_autostart,
            set_autostart,
            preview_themes_dir,
            set_themes_dir,
            export_backup,
            import_backup,
            list_backups,
            delete_backup,
            list_trash,
            restore_from_trash,
            delete_from_trash,
            empty_trash
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
