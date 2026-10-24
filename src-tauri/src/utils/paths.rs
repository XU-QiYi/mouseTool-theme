use std::path::PathBuf;

/// 数据根目录名，全项目唯一来源
const APP_DIR_NAME: &str = "CursorStudio";

// 测试用线程内覆盖：cargo test 每个用例各占一个线程，互不影响；
// 绝不让单元测试读写真实的 %LOCALAPPDATA% 或用户设置。
#[cfg(test)]
thread_local! {
    static TEST_DATA_ROOT: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
    static TEST_THEMES_DIR: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// 唯一的根目录常量来源：`%LOCALAPPDATA%\CursorStudio`
///
/// 任何需要数据目录的地方都必须调用这里，禁止自行拼接路径。
pub fn data_root() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_DATA_ROOT.with(|slot| slot.borrow().clone()) {
        return path;
    }
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join(APP_DIR_NAME)
}

/// 用户主题目录：默认 `%LOCALAPPDATA%\CursorStudio\themes`
///
/// 用户可在「设置 → 通用」里改存储目录（`settings.json` 的 `themes_dir`），
/// 改动走 `utils/themes_dir::change`（带搬迁）；这里只负责解析生效值，
/// 于是所有 `theme_dir()` 调用点自动跟着走。
pub fn themes_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = TEST_THEMES_DIR.with(|slot| slot.borrow().clone()) {
        return path;
    }
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

/// 测试用：把数据根目录与主题目录重定向到临时目录，离开作用域自动还原
#[cfg(test)]
pub struct TestRootsGuard {
    previous_data: Option<PathBuf>,
    previous_themes: Option<PathBuf>,
}

#[cfg(test)]
impl Drop for TestRootsGuard {
    fn drop(&mut self) {
        let data = self.previous_data.take();
        let themes = self.previous_themes.take();
        TEST_DATA_ROOT.with(|slot| *slot.borrow_mut() = data);
        TEST_THEMES_DIR.with(|slot| *slot.borrow_mut() = themes);
    }
}

#[cfg(test)]
pub fn use_test_roots(data_root: PathBuf, themes_dir: PathBuf) -> TestRootsGuard {
    let previous_data = TEST_DATA_ROOT.with(|slot| slot.borrow_mut().replace(data_root));
    let previous_themes = TEST_THEMES_DIR.with(|slot| slot.borrow_mut().replace(themes_dir));
    TestRootsGuard {
        previous_data,
        previous_themes,
    }
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

    #[test]
    fn 测试覆盖只影响当前线程() {
        let sandbox = std::env::temp_dir().join("cursorstudio-paths-override");
        {
            let _guard = use_test_roots(sandbox.clone(), sandbox.join("themes"));
            assert_eq!(data_root(), sandbox);
            assert_eq!(themes_dir(), sandbox.join("themes"));
        }
        assert!(data_root().ends_with("CursorStudio"), "离开作用域应还原");
    }
}
