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

/// 用户主题目录：默认 `%LOCALAPPDATA%\CursorStudio\themes`
///
/// 用户可在「设置 → 通用」里改存储目录（`settings.json` 的 `themes_dir`），
/// 改动走 `utils/themes_dir::change`（带搬迁）；这里只负责解析生效值，
/// 于是所有 `theme_dir()` 调用点自动跟着走。
pub fn themes_dir() -> PathBuf {
    if let Some(raw) = crate::utils::settings::read()
        .themes_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return PathBuf::from(raw);
    }
    data_root().join("themes")
}

/// 单个主题目录：`...\themes\<theme-id>`
pub fn theme_dir(theme_id: &str) -> PathBuf {
    themes_dir().join(theme_id)
}

/// 最近使用记录：`%LOCALAPPDATA%\CursorStudio\history.json`
///
/// 刻意独立于 `themes/`：历史描述的是「界面上点过什么」，
/// 不属于任何一个主题目录，删主题时也不该跟着被删。
pub fn history_file() -> PathBuf {
    data_root().join("history.json")
}

/// 右键菜单 `--import` 的转交文件：`...\CursorStudio\pending_import.json`
///
/// 第二个实例把待导入路径写在这里就退出，由活着的实例在启动/聚焦时领取。
pub fn pending_import_file() -> PathBuf {
    data_root().join("pending_import.json")
}

/// 确保目录存在
pub fn ensure_dir(path: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|err| format!("创建目录 {} 失败：{err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(non_snake_case)] // 函数名里的 LOCALAPPDATA 是环境变量原名，不改成小写
    fn 根目录应基于_LOCALAPPDATA() {
        let root = data_root();
        assert!(root.ends_with("CursorStudio"), "实际：{}", root.display());
        assert!(themes_dir().ends_with("themes"));
    }
}
