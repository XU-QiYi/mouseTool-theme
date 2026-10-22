//! 应用行为设置（`settings.json`）
//!
//! 落在数据根目录（`%LOCALAPPDATA%\CursorStudio\settings.json`），与 `history.json`
//! 同级。**哪些设置存这里：Rust 也要读的行为**——关闭行为（关窗拦截在 Rust 侧）、
//! 主题存储目录（`paths::themes_dir` 要读）、以及两个开关的持久化。
//!
//! 三个持久化来源各管各的，不做大一统配置文件：
//! - `settings.json`（这里）：行为类设置，Rust + 前端共用；
//! - `localStorage`：纯界面偏好（外观三态），首帧落色需要同步读，见 `lib/theme-mode.ts`；
//! - `HKCU\...\Run`：开机自启动的真相在注册表，界面只是读写它。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};

use crate::utils::paths;

/// 关闭主窗口时的行为
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CloseBehavior {
    /// 关窗口即退出进程（默认）
    #[default]
    Exit,
    /// 关窗口缩到托盘，进程继续跑，托盘里能叫回窗口或退出
    Tray,
}

impl CloseBehavior {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exit => "exit",
            Self::Tray => "tray",
        }
    }

    /// 前端传来的字符串 → 枚举；不给静默默认，传错了要说出来
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw {
            "exit" => Ok(Self::Exit),
            "tray" => Ok(Self::Tray),
            other => Err(format!("不认识的关闭行为「{other}」（应为 exit 或 tray）")),
        }
    }
}

/// `settings.json` 的完整结构；缺字段走 `Default`，旧文件加新字段不用迁移
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub close_behavior: CloseBehavior,
    /// 主题存储目录；`None` = 默认 `<数据目录>\themes`
    pub themes_dir: Option<String>,
    /// 启动时自动检查新版本（检查逻辑在前端，这里只存偏好）
    pub auto_check_update: bool,
    /// 是否启用应用内快捷键
    pub shortcuts_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Exit,
            themes_dir: None,
            auto_check_update: true,
            shortcuts_enabled: true,
        }
    }
}

pub fn settings_file() -> PathBuf {
    paths::data_root().join("settings.json")
}

fn cache() -> &'static RwLock<Option<AppSettings>> {
    static CACHE: OnceLock<RwLock<Option<AppSettings>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

/// 从指定文件读设置：缺失或损坏都退回默认，不打断使用
pub fn read_from(path: &Path) -> AppSettings {
    let Ok(raw) = fs::read_to_string(path) else {
        return AppSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_else(|err| {
        eprintln!("[settings] settings.json 解析失败，按默认值继续（{err}）");
        AppSettings::default()
    })
}

/// 读当前设置（带进程内缓存；`write` 会同步刷新缓存）
pub fn read() -> AppSettings {
    if let Ok(guard) = cache().read() {
        if let Some(settings) = guard.as_ref() {
            return settings.clone();
        }
    }
    let loaded = read_from(&settings_file());
    if let Ok(mut guard) = cache().write() {
        *guard = Some(loaded.clone());
    }
    loaded
}

/// 写到指定文件：先写临时文件再改名，避免写一半断电留下半个 JSON
pub fn write_to(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        paths::ensure_dir(parent)?;
    }
    let payload =
        serde_json::to_string_pretty(settings).map_err(|err| format!("整理设置失败（{err}）"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, payload).map_err(|err| format!("写入设置失败（{err}）"))?;
    fs::rename(&tmp, path).map_err(|err| format!("保存设置失败（{err}）"))
}

/// 写入并刷新缓存
pub fn write(settings: &AppSettings) -> Result<(), String> {
    write_to(&settings_file(), settings)?;
    if let Ok(mut guard) = cache().write() {
        *guard = Some(settings.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("cursorstudio-settings-test-{name}.json"))
    }

    #[test]
    fn 缺失与坏文件都退回默认值() {
        let missing = temp_file("missing");
        let _ = fs::remove_file(&missing);
        assert_eq!(
            read_from(&missing).close_behavior,
            CloseBehavior::Exit,
            "文件不存在应是默认设置"
        );

        let broken = temp_file("broken");
        fs::write(&broken, "{ 不是 json").expect("写坏文件");
        let settings = read_from(&broken);
        assert_eq!(settings.close_behavior, CloseBehavior::Exit);
        assert!(settings.auto_check_update, "默认开启自动检查");
        let _ = fs::remove_file(&broken);
    }

    #[test]
    fn 写读往返与旧文件缺字段兼容() {
        let file = temp_file("roundtrip");
        let mut settings = AppSettings::default();
        settings.close_behavior = CloseBehavior::Tray;
        settings.themes_dir = Some("D:\\Cursors".to_string());
        write_to(&file, &settings).expect("写入设置");

        let loaded = read_from(&file);
        assert_eq!(loaded.close_behavior, CloseBehavior::Tray);
        assert_eq!(loaded.themes_dir.as_deref(), Some("D:\\Cursors"));
        assert!(loaded.shortcuts_enabled);

        // 旧版本文件只有部分字段：缺的走默认，不整份拒读
        fs::write(&file, r#"{"close_behavior":"tray"}"#).expect("写旧格式");
        let loaded = read_from(&file);
        assert_eq!(loaded.close_behavior, CloseBehavior::Tray);
        assert!(loaded.auto_check_update, "缺字段应补默认 true");
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn 关闭行为的字符串解析只认两个值() {
        assert_eq!(CloseBehavior::parse("exit").unwrap(), CloseBehavior::Exit);
        assert_eq!(CloseBehavior::parse("tray").unwrap(), CloseBehavior::Tray);
        assert!(CloseBehavior::parse("minimize").is_err());
        assert_eq!(CloseBehavior::Tray.as_str(), "tray");
    }
}
