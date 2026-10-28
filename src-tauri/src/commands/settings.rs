//! 设置模块命令：行为设置读写、开机自启动、主题存储目录
//!
//! 分组口径见前端「设置 → 通用」：每个设置项都有命令层的对应入口，
//! 改完即生效——自启动写注册表、关闭行为即时同步托盘、主题目录走迁移命令。

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::utils::{
    autostart, ops, paths, settings, settings::CloseBehavior, themes_dir, tray,
};
use crate::utils::themes_dir::{ThemesDirChange, ThemesDirPlan};

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
    /// 跟随系统深浅色自动切换主题；映射存主题 ID，`None` = 对应深浅色不切换
    pub auto_switch_enabled: bool,
    pub auto_switch_light_id: Option<String>,
    pub auto_switch_dark_id: Option<String>,
    /// 光标守护：启动或检测到外部改写时自动恢复上次使用的主题
    pub cursor_guard_enabled: bool,
    /// 读取设置时的非致命问题（典型：文件损坏已自动备份）
    pub warnings: Vec<String>,
}

/// 自启动状态
#[derive(Debug, Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
    /// 注册表里实际登记的程序路径（程序移动后会过期，界面要展示）
    /// 未开启时为空串
    pub exe_path: String,
}

fn snapshot(loaded: &settings::SettingsLoad) -> Result<SettingsSnapshot, String> {
    Ok(SettingsSnapshot {
        close_behavior: loaded.settings.close_behavior.as_str().to_string(),
        themes_dir: loaded.settings.themes_dir.clone(),
        effective_themes_dir: paths::themes_dir()?.to_string_lossy().into_owned(),
        auto_check_update: loaded.settings.auto_check_update,
        shortcuts_enabled: loaded.settings.shortcuts_enabled,
        auto_switch_enabled: loaded.settings.auto_switch_enabled,
        auto_switch_light_id: loaded.settings.auto_switch_light_id.clone(),
        auto_switch_dark_id: loaded.settings.auto_switch_dark_id.clone(),
        cursor_guard_enabled: loaded.settings.cursor_guard_enabled,
        warnings: loaded.warnings.clone(),
    })
}

/// 读取全部行为设置
#[tauri::command]
pub async fn get_settings() -> Result<SettingsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| snapshot(&settings::load()))
        .await
        .map_err(|err| format!("读取设置任务异常退出（{err}）"))?
}

/// 局部更新行为设置（只传要改的字段），返回更新后的快照
///
/// 关闭行为变更要同步托盘的有无：切到「最小化到托盘」时托盘必须出现，
/// 切回「直接退出」时立即摘掉，不能等下次重启。
///
/// 主题 ID 参数用**空串表示清空**（serde_json 分不清「没传」和「传了 null」，
/// 与补丁语义冲突；前端把「不切换」编成空串）。
// Tauri 命令的补丁字段必须是一个个可选的顶层参数；收成结构体会改掉 IPC 形状，
// 让「只传要改的字段」在 JS 侧变形。字段随设置项增长，保持扁平
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    close_behavior: Option<String>,
    auto_check_update: Option<bool>,
    shortcuts_enabled: Option<bool>,
    auto_switch_enabled: Option<bool>,
    auto_switch_light_id: Option<String>,
    auto_switch_dark_id: Option<String>,
    cursor_guard_enabled: Option<bool>,
) -> Result<SettingsSnapshot, String> {
    let updated = tauri::async_runtime::spawn_blocking(move || {
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
        if let Some(flag) = auto_switch_enabled {
            state.auto_switch_enabled = flag;
        }
        if let Some(raw) = auto_switch_light_id {
            state.auto_switch_light_id = normalize_theme_id(raw);
        }
        if let Some(raw) = auto_switch_dark_id {
            state.auto_switch_dark_id = normalize_theme_id(raw);
        }
        if let Some(flag) = cursor_guard_enabled {
            state.cursor_guard_enabled = flag;
        }
        settings::write(&state)?;
        snapshot(&settings::load())
    })
    .await
    .map_err(|err| format!("保存设置任务异常退出（{err}）"))??;

    tray::sync(&app);
    Ok(updated)
}

/// 空串 = 用户选了「不切换」；非空按原样存，首尾空白不宽容（ID 本身不含空白）
fn normalize_theme_id(raw: String) -> Option<String> {
    if raw.is_empty() { None } else { Some(raw) }
}

/// 开机自启动状态
#[tauri::command]
pub async fn get_autostart() -> Result<AutostartStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (enabled, exe_path) = autostart::status();
        Ok(AutostartStatus { enabled, exe_path })
    })
    .await
    .map_err(|err| format!("读取自启动状态任务异常退出（{err}）"))?
}

/// 开启 / 关闭开机自启动，返回操作后的状态（以注册表回读为准）
#[tauri::command]
pub async fn set_autostart(enable: bool) -> Result<AutostartStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (enabled, exe_path) = autostart::set(enable)?;
        Ok(AutostartStatus { enabled, exe_path })
    })
    .await
    .map_err(|err| format!("设置自启动任务异常退出（{err}）"))?
}

/// 更换主题存储目录的结果：设置快照 + 搬运报告
#[derive(Debug, Serialize)]
pub struct ThemesDirChangeResult {
    pub settings: SettingsSnapshot,
    pub report: ThemesDirChange,
}

/// 迁移前的预检：校验目标并统计源目录，不碰任何文件
///
/// 确认对话框用它展示源、目标、主题数量与体积；校验不过在这里就给出人话，
/// 用户不会点了「开始迁移」才发现目录选错。
#[tauri::command]
pub async fn preview_themes_dir(path: Option<String>) -> Result<ThemesDirPlan, String> {
    tauri::async_runtime::spawn_blocking(move || themes_dir::preview(path.as_deref()))
        .await
        .map_err(|err| format!("预检任务异常退出（{err}）"))?
}

/// 更换主题存储目录（`None` = 回默认），现有主题一起搬过去
///
/// 复制、校验、切换都在后台线程执行，进度通过 `themes-dir-progress` 事件推给
/// 界面；命令返回时要么全部成功，要么已回滚到原目录。迁移与导入 / 备份恢复
/// 共用一把重操作锁，避免同时搬运同一批文件。
#[tauri::command]
pub async fn set_themes_dir(
    app: AppHandle,
    path: Option<String>,
) -> Result<ThemesDirChangeResult, String> {
    let report = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("迁移主题目录")?;
        let emitter = app.clone();
        themes_dir::change(path, move |progress| {
            let _ = emitter.emit("themes-dir-progress", progress);
        })
    })
    .await
    .map_err(|err| format!("迁移任务异常退出（{err}）"))??;

    Ok(ThemesDirChangeResult {
        settings: snapshot(&settings::load())?,
        report,
    })
}
