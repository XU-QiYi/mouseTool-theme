use std::fs;

use uuid::Uuid;

use crate::models::{CursorTheme, ThemesResult};
use crate::utils::{importer, paths, registry};

/// 聚合各数据源：单个来源失败只降级为 warning，不拖垮其余来源
///
/// 抽成纯函数是为了能单测"部分成功"契约——这是本模块的核心策略，
/// 没有测试的话，把 `Err` 改回 `?` 整体失败不会被任何测试拦住。
fn merge_sources(
    system: Result<Vec<CursorTheme>, String>,
    user: (Vec<CursorTheme>, Vec<String>),
) -> ThemesResult {
    let mut warnings = Vec::new();

    let mut themes = match system {
        Ok(schemes) => schemes,
        Err(err) => {
            warnings.push(format!("系统光标方案没能加载：{err}"));
            Vec::new()
        }
    };

    let (user_themes, user_warnings) = user;
    themes.extend(user_themes);
    warnings.extend(user_warnings);

    ThemesResult { themes, warnings }
}

/// 获取所有主题：系统注册表方案 + 已导入的用户主题
///
/// 两个来源独立容错：注册表读失败只降级为一条 warning，不整体失败——
/// 否则本来能显示的用户主题会跟着一起消失。
#[tauri::command]
pub fn get_all_themes() -> Result<ThemesResult, String> {
    Ok(merge_sources(
        registry::read_system_schemes(),
        importer::read_user_themes(),
    ))
}

/// 导入 zip 主题包，返回新主题
#[tauri::command]
pub fn import_theme(zip_path: String) -> Result<CursorTheme, String> {
    importer::import_zip(&zip_path)
}

/// 把主题应用到系统：写注册表后立即刷新，无需注销
#[tauri::command]
pub fn apply_theme(theme: CursorTheme) -> Result<(), String> {
    registry::write_cursors(&theme.cursors, &theme.name)?;
    registry::refresh_cursors()
}

/// 恢复系统默认光标
#[tauri::command]
pub fn restore_default() -> Result<(), String> {
    registry::clear_cursors()?;
    registry::refresh_cursors()
}

/// 删除一个已导入的主题（连同它的光标文件目录）
///
/// 只接受 UUID。theme_id 来自前端，必须校验格式——否则传入 `../` 之类的值
/// 会让 `theme_dir` 拼到数据目录之外，误删用户其它文件。
#[tauri::command]
pub fn delete_theme(theme_id: String) -> Result<(), String> {
    let id = Uuid::parse_str(&theme_id).map_err(|_| "非法的主题 ID".to_string())?;
    let dir = paths::theme_dir(&id.to_string());

    if !dir.exists() {
        return Err("这个主题已经不在了，可能要重新导入".to_string());
    }

    fs::remove_dir_all(&dir).map_err(|err| {
        format!("删不掉主题目录，它可能正被其它程序占用（{err}）")
    })?;
    Ok(())
}

/// 重命名已导入的主题
///
/// 只改 theme.json 里的显示名，目录名仍是 UUID（改目录会影响正在使用的
/// 光标路径）。`updated_at` 保持导入时间不变——界面上它承担的是「导入于」。
#[tauri::command]
pub fn rename_theme(theme_id: String, new_name: String) -> Result<CursorTheme, String> {
    let id = Uuid::parse_str(&theme_id).map_err(|_| "非法的主题 ID".to_string())?;
    let name = new_name.trim();

    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if name.chars().count() > 40 {
        return Err("名称最多 40 个字".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("名称不能包含换行或控制字符".to_string());
    }

    let json_path = paths::theme_dir(&id.to_string()).join("theme.json");
    if !json_path.exists() {
        return Err("找不到这个主题，它可能已被删除".to_string());
    }

    let raw = fs::read_to_string(&json_path).map_err(|err| format!("读不到主题信息（{err}）"))?;
    let mut theme: CursorTheme =
        serde_json::from_str(&raw).map_err(|err| format!("主题信息已损坏，无法改名（{err}）"))?;

    theme.name = name.to_string();

    let json =
        serde_json::to_string_pretty(&theme).map_err(|err| format!("保存主题信息失败（{err}）"))?;
    fs::write(&json_path, json).map_err(|err| format!("保存主题信息失败（{err}）"))?;

    Ok(theme)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_theme(id: &str) -> CursorTheme {
        CursorTheme {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            is_built_in: false,
            cursors: Vec::new(),
        }
    }

    /// 回归测试：注册表读失败时，用户主题不该跟着消失
    ///
    /// 修之前的行为是 `read_system_schemes()?` 一错全错，用户主题读都没读。
    #[test]
    fn 注册表失败时用户主题仍应返回() {
        let result = merge_sources(
            Err("无法打开注册表键".to_string()),
            (vec![fake_theme("user-1")], Vec::new()),
        );
        assert_eq!(result.themes.len(), 1, "用户主题必须保留");
        assert_eq!(result.themes[0].id, "user-1");
        assert_eq!(result.warnings.len(), 1, "失败来源要能被指认");
        assert!(result.warnings[0].contains("注册表"), "warning 要说清是哪个来源");
    }

    #[test]
    fn 各来源的警告应独立累积() {
        let result = merge_sources(
            Ok(vec![fake_theme("sys_a")]),
            (vec![fake_theme("user-1")], vec!["某个主题坏了".to_string()]),
        );
        assert_eq!(result.themes.len(), 2);
        assert_eq!(result.warnings.len(), 1, "用户来源的警告不能被吞掉");
    }
}
