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

use crate::utils::{limits, paths};

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
    /// 跟随系统深浅色自动切换主题（切换逻辑在前端，见 `lib/auto-switch.ts`）
    pub auto_switch_enabled: bool,
    /// 系统浅色时使用的主题 ID；`None` = 浅色时不切换
    pub auto_switch_light_id: Option<String>,
    /// 系统深色时使用的主题 ID；`None` = 深色时不切换
    pub auto_switch_dark_id: Option<String>,
    /// 光标守护：启动或检测到外部改写时自动恢复上次使用的主题（逻辑在前端，
    /// 见 `lib/cursor-guard.ts`；这里只存偏好）
    pub cursor_guard_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Exit,
            themes_dir: None,
            auto_check_update: true,
            shortcuts_enabled: true,
            auto_switch_enabled: false,
            auto_switch_light_id: None,
            auto_switch_dark_id: None,
            cursor_guard_enabled: false,
        }
    }
}

pub fn settings_file() -> Result<PathBuf, String> {
    Ok(paths::data_root()?.join("settings.json"))
}

/// 一次读取的结果：设置值 + 需要展示给用户的非致命问题
#[derive(Debug, Clone)]
pub struct SettingsLoad {
    pub settings: AppSettings,
    pub warnings: Vec<String>,
}

impl SettingsLoad {
    fn defaults() -> Self {
        Self {
            settings: AppSettings::default(),
            warnings: Vec::new(),
        }
    }
}

fn cache() -> &'static RwLock<Option<SettingsLoad>> {
    static CACHE: OnceLock<RwLock<Option<SettingsLoad>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

/// 从指定文件读设置：缺失退回默认；损坏先备份再退回默认，并给出可展示的警告
///
/// 损坏文件不能静默留在原位：下次启动还会走同一条失败路径，用户永远不知道
/// 自己的设置丢了。改名成带时间戳的 `.bak` 既保住现场，也让下一次写入从干净
/// 状态开始。
pub fn load_from(path: &Path) -> SettingsLoad {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return SettingsLoad::defaults(),
        Err(err) => {
            return SettingsLoad {
                settings: AppSettings::default(),
                warnings: vec![format!("读不到设置文件，已按默认设置运行（{err}）")],
            }
        }
    };
    if meta.len() > limits::MAX_STATE_FILE_BYTES {
        return corrupted(
            path,
            &format!(
                "文件 {} 字节，超过 {}KB 上限",
                meta.len(),
                limits::MAX_STATE_FILE_BYTES / 1024
            ),
        );
    }

    let raw = match limits::read_text_bounded(path, limits::MAX_STATE_FILE_BYTES) {
        Ok(raw) => raw,
        Err(err) => return corrupted(path, &err),
    };

    match serde_json::from_str::<AppSettings>(&raw) {
        Ok(settings) => SettingsLoad {
            settings,
            warnings: Vec::new(),
        },
        Err(err) => corrupted(path, &err.to_string()),
    }
}

/// 损坏 / 超限 / 读不出来：先备份现场，再按默认值运行
fn corrupted(path: &Path, reason: &str) -> SettingsLoad {
    let warning = match backup_corrupt(path) {
        Ok(backup) => format!(
            "设置文件已损坏或无法读取，已备份为 {}，本次按默认设置运行（{reason}）",
            backup.display()
        ),
        Err(backup_err) => format!(
            "设置文件已损坏或无法读取，自动备份失败（{backup_err}）；本次按默认设置运行，请手动检查 {}（{reason}）",
            path.display()
        ),
    };
    SettingsLoad {
        settings: AppSettings::default(),
        warnings: vec![warning],
    }
}

fn backup_corrupt(path: &Path) -> Result<PathBuf, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.json");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));

    let mut backup = parent.join(format!("{name}.corrupt-{stamp}.bak"));
    let mut index = 1;
    while backup.exists() {
        backup = parent.join(format!("{name}.corrupt-{stamp}-{index}.bak"));
        index += 1;
    }

    fs::rename(path, &backup)
        .map_err(|err| format!("重命名损坏的设置文件失败（{err}）"))?;
    Ok(backup)
}

/// 从指定文件读设置值（测试与不需要警告的调用点）
pub fn read_from(path: &Path) -> AppSettings {
    load_from(path).settings
}

/// 读当前设置与警告（带进程内缓存；`write` 会同步刷新缓存）
///
/// 数据根不可用时也返回默认值 + 警告：关闭行为、托盘这类启动路径不能因为
/// 读设置失败就崩掉；需要严格失败的界面命令会另走 `paths::data_root()`。
pub fn load() -> SettingsLoad {
    if let Ok(guard) = cache().read() {
        if let Some(loaded) = guard.as_ref() {
            return loaded.clone();
        }
    }

    let loaded = match settings_file() {
        Ok(path) => load_from(&path),
        Err(err) => SettingsLoad {
            settings: AppSettings::default(),
            warnings: vec![err],
        },
    };
    if let Ok(mut guard) = cache().write() {
        *guard = Some(loaded.clone());
    }
    loaded
}

/// 读当前设置值（带进程内缓存；`write` 会同步刷新缓存）
pub fn read() -> AppSettings {
    load().settings
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
///
/// 缓存里已有的警告（例如损坏文件已备份）保留到本次进程结束：写入成功
/// 不代表用户已经看到过那条提示，立刻清掉会让同一次会话里的界面失去上下文。
pub fn write(settings: &AppSettings) -> Result<(), String> {
    write_to(&settings_file()?, settings)?;
    let warnings = cache()
        .read()
        .ok()
        .and_then(|guard| guard.as_ref().map(|loaded| loaded.warnings.clone()))
        .unwrap_or_default();
    if let Ok(mut guard) = cache().write() {
        *guard = Some(SettingsLoad {
            settings: settings.clone(),
            warnings,
        });
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
    fn 缺失文件退回默认值且不产生警告() {
        let missing = temp_file("missing");
        let _ = fs::remove_file(&missing);

        let loaded = load_from(&missing);
        assert_eq!(loaded.settings.close_behavior, CloseBehavior::Exit);
        assert!(loaded.warnings.is_empty(), "第一次运行不该报警");
    }

    #[test]
    fn 坏文件先备份再退回默认并给出警告() {
        let dir = std::env::temp_dir().join("cursorstudio-settings-corrupt");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        let broken = dir.join("settings.json");
        fs::write(&broken, "{ 不是 json").expect("写坏文件");

        let loaded = load_from(&broken);
        assert_eq!(loaded.settings.close_behavior, CloseBehavior::Exit);
        assert!(loaded.settings.auto_check_update, "默认开启自动检查");
        assert_eq!(loaded.warnings.len(), 1, "损坏要能被界面说明");
        assert!(
            loaded.warnings[0].contains("已备份"),
            "警告要说清备份去了哪里：{}",
            loaded.warnings[0]
        );
        assert!(!broken.exists(), "损坏文件应被移走，避免反复触发");

        let backups: Vec<_> = fs::read_dir(&dir)
            .expect("读临时目录")
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.corrupt-")
            })
            .collect();
        assert_eq!(backups.len(), 1, "应留下一个带时间戳的备份");
        assert_eq!(
            fs::read_to_string(backups[0].path()).expect("读备份"),
            "{ 不是 json",
            "备份必须保住原始内容"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 超过上限的设置文件按损坏备份() {
        let dir = std::env::temp_dir().join(format!(
            "cursorstudio-settings-oversized-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("settings.json");
        let raw = format!(
            r#"{{"themes_dir":"{}"}}"#,
            "a".repeat(limits::MAX_STATE_FILE_BYTES as usize + 1)
        );
        fs::write(&path, raw).expect("写超大设置");

        let loaded = load_from(&path);
        assert_eq!(loaded.settings.close_behavior, CloseBehavior::Exit);
        assert!(
            loaded.warnings[0].contains("上限"),
            "警告要说清尺寸超限：{}",
            loaded.warnings[0]
        );
        assert!(!path.exists(), "超限文件也要先移走");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn 写读往返与旧文件缺字段兼容() {
        let file = temp_file("roundtrip");
        let settings = AppSettings {
            close_behavior: CloseBehavior::Tray,
            themes_dir: Some("D:\\Cursors".to_string()),
            auto_switch_enabled: true,
            auto_switch_light_id: Some("sys_windows_default".to_string()),
            auto_switch_dark_id: Some("11111111-1111-4111-8111-111111111111".to_string()),
            cursor_guard_enabled: true,
            ..AppSettings::default()
        };
        write_to(&file, &settings).expect("写入设置");

        let loaded = read_from(&file);
        assert_eq!(loaded.close_behavior, CloseBehavior::Tray);
        assert_eq!(loaded.themes_dir.as_deref(), Some("D:\\Cursors"));
        assert!(loaded.shortcuts_enabled);
        assert!(loaded.auto_switch_enabled);
        assert_eq!(loaded.auto_switch_light_id.as_deref(), Some("sys_windows_default"));
        assert_eq!(
            loaded.auto_switch_dark_id.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert!(loaded.cursor_guard_enabled);

        // 旧版本文件只有部分字段：缺的走默认，不整份拒读
        fs::write(&file, r#"{"close_behavior":"tray"}"#).expect("写旧格式");
        let loaded = read_from(&file);
        assert_eq!(loaded.close_behavior, CloseBehavior::Tray);
        assert!(loaded.auto_check_update, "缺字段应补默认 true");
        assert!(!loaded.auto_switch_enabled, "自动切换默认关闭，不能凭空替用户切换");
        assert!(loaded.auto_switch_light_id.is_none());
        assert!(loaded.auto_switch_dark_id.is_none());
        assert!(
            !loaded.cursor_guard_enabled,
            "光标守护默认关闭，不能凭空替用户抢回光标"
        );
        let _ = fs::remove_file(&file);
    }

    #[test]
    fn 光标守护默认关闭且写读往返() {
        let file = temp_file("cursor-guard");
        assert!(
            !AppSettings::default().cursor_guard_enabled,
            "默认必须是关：不能凭空替用户抢回光标"
        );

        let settings = AppSettings {
            cursor_guard_enabled: true,
            ..AppSettings::default()
        };
        write_to(&file, &settings).expect("写入设置");
        assert!(read_from(&file).cursor_guard_enabled, "开启状态必须落盘可读");
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
