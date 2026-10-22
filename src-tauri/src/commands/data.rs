//! 数据目录相关命令
//!
//! 「打开数据目录」是设置模块的锚点：备份、清理、报障自查都从这里出发。
//! 目录的唯一来源是 `utils/paths.rs::data_root()`，这里只做「取出路径 + 打开」，
//! 不做任何额外的路径拼接（硬约束 1）。

use tauri_plugin_opener::open_path;

use crate::utils::paths;

/// 数据目录的展示路径（`%LOCALAPPDATA%\CursorStudio`）
///
/// 只读不落盘：目录还不存在（一次都没导入过）也照实返回，
/// 「打开」这一步才负责创建。
#[tauri::command]
pub fn get_data_dir() -> Result<String, String> {
    Ok(paths::data_root().to_string_lossy().into_owned())
}

/// 在系统文件管理器中打开数据目录，返回实际打开的路径
///
/// 目录不存在就先创建：设置页是用户排查数据问题的入口，
/// 打开一个空目录远比「打开失败：路径不存在」有用。
#[tauri::command]
pub fn open_data_dir() -> Result<String, String> {
    let dir = paths::data_root();
    paths::ensure_dir(&dir)?;
    open_path(&dir, None::<&str>).map_err(|err| format!("打开数据目录失败（{err}）"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 数据目录命令返回根目录路径() {
        let dir = get_data_dir().expect("读取数据目录路径不应失败");
        assert!(dir.ends_with("CursorStudio"), "实际：{dir}");
    }
}
