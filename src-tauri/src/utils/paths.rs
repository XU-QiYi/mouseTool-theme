use std::path::PathBuf;

/// 数据根目录名，全项目唯一来源
const APP_DIR_NAME: &str = "CursorStudio";

/// 唯一的根目录常量来源：`%LOCALAPPDATA%\CursorStudio`
///
/// 任何需要数据目录的地方都必须调用这里，禁止自行拼接路径。
pub fn data_root() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join(APP_DIR_NAME)
}

/// 用户主题目录：`%LOCALAPPDATA%\CursorStudio\themes`
pub fn themes_dir() -> PathBuf {
    data_root().join("themes")
}

/// 单个主题目录：`...\themes\<theme-id>`
pub fn theme_dir(theme_id: &str) -> PathBuf {
    themes_dir().join(theme_id)
}

/// 确保目录存在
pub fn ensure_dir(path: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|err| format!("创建目录 {} 失败：{err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 根目录应基于_LOCALAPPDATA() {
        let root = data_root();
        assert!(root.ends_with("CursorStudio"), "实际：{}", root.display());
        assert!(themes_dir().ends_with("themes"));
    }
}
