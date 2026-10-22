//! 设置模块命令：行为设置读写、开机自启动、主题存储目录
//!
//! 分组口径见前端「设置 → 通用」：每个设置项都有命令层的对应入口，
//! 改完即生效——自启动写注册表、关闭行为即时同步托盘、主题目录走迁移命令。

use serde::Serialize;
use tauri::AppHandle;

use crate::utils::{autostart, paths, settings, settings::CloseBehavior, tray};

/// 给界面的设置快照：行为偏好 + 解析后的真实主题目录
#[derive(Debug, Serialize)]
pub struct SettingsSnapshot {
    pub close_behavior: String,
    /// 用户选定的主题存储目录（None = 默认）
    pub themes_dir: Option<String>,
    /// 实际生效的主题目录（默认时是 `<数据目录>\themes`）
    pub effective_themes_dir: String,
    pub auto_check_update: bool,
    pub shortcuts_enabled: bool,
}

/// 自启动状态
#[derive(Debug, Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
    /// 注册后命令指向的程序路径（移动安装目录会让它过期，界面要展示）
    pub exe_path: String,
}

fn snapshot(state: &settings::AppSettings) -> SettingsSnapshot {
    SettingsSnapshot {
        close_behavior: state.close_behavior.as_str().to_string(),
        themes_dir: state.themes_dir.clone(),
        effective_themes_dir: paths::themes_dir().to_string_lossy().into_owned(),
        auto_check_update: state.auto_check_update,
        shortcuts_enabled: state.shortcuts_enabled,
    }
}

/// 读取全部行为设置
#[tauri::command]
pub fn get_settings() -> Result<SettingsSnapshot, String> {
    Ok(snapshot(&settings::read()))
}

/// 局部更新行为设置（只传要改的字段），返回更新后的快照
///
/// 关闭行为变更要同步托盘的有无：切到「最小化到托盘」时托盘必须出现，
/// 切回「直接退出」时立即摘掉，不能等下次重启。
#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    close_behavior: Option<String>,
    auto_check_update: Option<bool>,
    shortcuts_enabled: Option<bool>,
) -> Result<SettingsSnapshot, String> {
    let mut state = settings::read();
    if let Some(raw) = close_behavior {
        state.close_behavior = CloseBehavior::parse(&raw)?;
    }
    if let Some(flag) = auto_check_update {
        state.auto_check_update = flag;
    }
    if let Some(flag) = shortcuts_enabled {
        state.shortcuts_enabled = flag;
    }
    settings::write(&state)?;
    tray::sync(&app);
    Ok(snapshot(&state))
}

/// 开机自启动状态
#[tauri::command]
pub fn get_autostart() -> Result<AutostartStatus, String> {
    let (enabled, exe_path) = autostart::status();
    Ok(AutostartStatus { enabled, exe_path })
}

/// 开启 / 关闭开机自启动，返回操作后的状态（以注册表回读为准）
#[tauri::command]
pub fn set_autostart(enable: bool) -> Result<AutostartStatus, String> {
    let (enabled, exe_path) = autostart::set(enable)?;
    Ok(AutostartStatus { enabled, exe_path })
}
