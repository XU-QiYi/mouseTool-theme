use crate::models::CursorPreview;
use crate::utils::{cursor, validation};

/// 获取光标文件的预览数据；文件不存在、越界或解析失败均返回空预览，不报错
///
/// 只接受主题目录与系统光标目录内、且不超过 8MB 的文件：预览是高频只读入口，
/// 不能让前端拿它去读任意路径。解码放到后台线程，避免一次读大图卡住界面。
#[tauri::command]
pub async fn get_cursor_preview(file_path: String) -> CursorPreview {
    tauri::async_runtime::spawn_blocking(move || preview(&file_path))
        .await
        .unwrap_or_default()
}

fn preview(file_path: &str) -> CursorPreview {
    match validation::preview_path_if_allowed(file_path) {
        Some(path) => cursor::preview_file(&path.to_string_lossy()),
        None => CursorPreview::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_support::{fixture_cur, TempDir};

    #[test]
    fn 主题目录外的路径返回空预览() {
        let preview = preview(r"C:\Windows\win.ini");
        assert!(preview.image.is_empty());
    }

    #[test]
    fn 允许目录内的光标能出预览() {
        let root = TempDir::new("preview-ok");
        let themes = root.join("themes");
        let theme_dir = themes.join("8f0f0f0f-0000-4000-8000-000000000000");
        std::fs::create_dir_all(&theme_dir).expect("建主题目录");
        let file = theme_dir.join("arrow.cur");
        std::fs::write(&file, fixture_cur()).expect("写光标");
        let _guard = crate::utils::paths::use_test_roots(root.path().to_path_buf(), themes);

        let preview = preview(&file.to_string_lossy());
        assert!(!preview.image.is_empty(), "允许目录内的光标应能预览");
    }
}
