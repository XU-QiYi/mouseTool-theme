use std::fs;

use uuid::Uuid;

use crate::models::{CursorSlot, CursorTheme, ThemesResult};
use crate::utils::{importer, paths, registry};

/// 聚合各数据源：单个来源失败只降级为 warning，不拖垮其余来源
///
/// 抽成纯函数是为了能单测"部分成功"契约——这是本模块的核心策略，
/// 没有测试的话，把 `Err` 改回 `?` 整体失败不会被任何测试拦住。
fn merge_sources(
    system: Result<Vec<CursorTheme>, String>,
    user: (Vec<CursorTheme>, Vec<String>),
) -> (Vec<CursorTheme>, Vec<String>) {
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

    (themes, warnings)
}

/// 路径比较口径：Windows 路径不区分大小写，正反斜杠等价
fn normalize_path(path: &str) -> String {
    path.trim().replace('/', "\\").to_lowercase()
}

/// 主题与注册表里当前生效的光标是否为同一套
///
/// 双向覆盖：主题定义的槽位都要能在注册表里对上，注册表里的非空槽位也要都能
/// 在主题里找到。只查单向会把「某主题是当前方案的子集」误判成正在使用。
fn theme_matches_current(theme: &CursorTheme, current: &[(String, String)]) -> bool {
    if current.is_empty() {
        return false;
    }

    let theme_slots: Vec<&CursorSlot> = theme
        .cursors
        .iter()
        .filter(|slot| !slot.file_path.trim().is_empty())
        .collect();

    if theme_slots.len() != current.len() {
        return false;
    }

    theme_slots.iter().all(|slot| {
        current.iter().any(|(key, path)| {
            *key == slot.registry_key && normalize_path(path) == normalize_path(&slot.file_path)
        })
    }) && current.iter().all(|(key, path)| {
        theme_slots.iter().any(|slot| {
            slot.registry_key == *key && normalize_path(&slot.file_path) == normalize_path(path)
        })
    })
}

/// 从主题列表里挑出注册表当前正在使用的那一个
///
/// 多套主题指向同一批文件时（同一方案的两份副本）按注册表方案名择一，
/// 名字都对不上就取列表里的第一个——文件路径完全一致时，选谁都不会错。
fn detect_active_theme(
    themes: &[CursorTheme],
    current: &[(String, String)],
    scheme_name: &str,
) -> Option<String> {
    let candidates: Vec<&CursorTheme> = themes
        .iter()
        .filter(|theme| theme_matches_current(theme, current))
        .collect();

    let chosen = candidates
        .iter()
        .find(|theme| theme.name == scheme_name)
        .or_else(|| candidates.first())?;

    Some(chosen.id.clone())
}

/// 获取所有主题：系统注册表方案 + 已导入的用户主题
///
/// 两个来源独立容错：注册表读失败只降级为一条 warning，不整体失败——
/// 否则本来能显示的用户主题会跟着一起消失。
///
/// 顺带反推「当前正在使用哪个主题」：界面不能靠内存记住这件事，
/// 否则重开窗口后会把已应用的主题当成可用主题，允许再点一次「应用」。
#[tauri::command]
pub fn get_all_themes() -> Result<ThemesResult, String> {
    let (themes, mut warnings) = merge_sources(
        registry::read_system_schemes(),
        importer::read_user_themes(),
    );

    let active_theme_id = match registry::read_current_slots() {
        Ok(current) => detect_active_theme(&themes, &current, &registry::read_scheme_name()),
        Err(err) => {
            // 识别不出就当作「没有正在使用的主题」：少标一个「使用中」可以接受，
            // 标错了会让人以为已经应用成功
            warnings.push(format!("无法识别当前正在使用的主题：{err}"));
            None
        }
    };

    Ok(ThemesResult {
        themes,
        warnings,
        active_theme_id,
    })
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
        let (themes, warnings) = merge_sources(
            Err("无法打开注册表键".to_string()),
            (vec![fake_theme("user-1")], Vec::new()),
        );
        assert_eq!(themes.len(), 1, "用户主题必须保留");
        assert_eq!(themes[0].id, "user-1");
        assert_eq!(warnings.len(), 1, "失败来源要能被指认");
        assert!(warnings[0].contains("注册表"), "warning 要说清是哪个来源");
    }

    #[test]
    fn 各来源的警告应独立累积() {
        let (themes, warnings) = merge_sources(
            Ok(vec![fake_theme("sys_a")]),
            (vec![fake_theme("user-1")], vec!["某个主题坏了".to_string()]),
        );
        assert_eq!(themes.len(), 2);
        assert_eq!(warnings.len(), 1, "用户来源的警告不能被吞掉");
    }

    fn theme_with_slots(id: &str, name: &str, slots: &[(&str, &str)]) -> CursorTheme {
        CursorTheme {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            is_built_in: false,
            cursors: slots
                .iter()
                .map(|(key, path)| CursorSlot {
                    registry_key: (*key).to_string(),
                    display_name: String::new(),
                    english_name: String::new(),
                    file_path: (*path).to_string(),
                    file_type: "cur".to_string(),
                })
                .collect(),
        }
    }

    fn current(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, path)| ((*key).to_string(), (*path).to_string()))
            .collect()
    }

    #[test]
    fn 大小写与斜杠差异不影响识别() {
        let theme = theme_with_slots("a", "A", &[("Arrow", r"C:\Cursors\Arrow.cur")]);
        let slots = current(&[("Arrow", "c:/cursors/ARROW.cur")]);

        assert_eq!(
            detect_active_theme(&[theme], &slots, "").as_deref(),
            Some("a"),
            "注册表大小写与斜杠写法不该让人以为主题没被应用"
        );
    }

    #[test]
    fn 槽位集合不同就不算同一套() {
        let theme = theme_with_slots(
            "a",
            "A",
            &[("Arrow", r"C:\A\arrow.cur"), ("Hand", r"C:\A\hand.cur")],
        );

        // 子集：少了 Hand，说明系统里还有别的光标，不是这套主题
        let subset = current(&[("Arrow", r"C:\A\arrow.cur")]);
        assert!(detect_active_theme(&[theme.clone()], &subset, "").is_none());

        // 超集：多出 Wait，同上
        let superset = current(&[
            ("Arrow", r"C:\A\arrow.cur"),
            ("Hand", r"C:\A\hand.cur"),
            ("Wait", r"C:\A\wait.cur"),
        ]);
        assert!(detect_active_theme(&[theme], &superset, "").is_none());
    }

    #[test]
    fn 槽位路径不同就不算同一套() {
        let theme = theme_with_slots("a", "A", &[("Arrow", r"C:\A\arrow.cur")]);
        let slots = current(&[("Arrow", r"C:\B\arrow.cur")]);
        assert!(detect_active_theme(&[theme], &slots, "").is_none());
    }

    #[test]
    fn 系统默认光标下没有正在使用的主题() {
        let theme = theme_with_slots("a", "A", &[("Arrow", r"C:\A\arrow.cur")]);
        assert!(
            detect_active_theme(&[theme], &[], "").is_none(),
            "槽位全空 = 系统默认，不该标记任何主题"
        );
    }

    #[test]
    fn 文件相同的时候按方案名择一() {
        let slots = current(&[("Arrow", r"C:\A\arrow.cur")]);
        let themes = vec![
            theme_with_slots("copy-1", "副本一", &[("Arrow", r"C:\A\arrow.cur")]),
            theme_with_slots("copy-2", "副本二", &[("Arrow", r"C:\A\arrow.cur")]),
        ];

        assert_eq!(
            detect_active_theme(&themes, &slots, "副本二").as_deref(),
            Some("copy-2")
        );

        // 方案名对不上（例如改名后注册表还是旧名）时退化为第一个，不能返回 None
        assert_eq!(
            detect_active_theme(&themes, &slots, "改过的新名字").as_deref(),
            Some("copy-1")
        );
    }

    /// 安全测试：theme_id 是字符串拼接进路径的，未校验时传 `../` 会越出数据目录
    #[test]
    fn 非法主题_id_不能穿出数据目录() {
        for bad in ["../evil", "..\\evil", "a/b", "", "not-a-uuid"] {
            let err = delete_theme(bad.to_string()).unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 应被拒绝，实际：{err}");

            let err = rename_theme(bad.to_string(), "x".to_string()).unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 改名也应被拒绝，实际：{err}");
        }
    }

    /// 名称校验发生在碰文件系统之前，所以不需要真实目录
    #[test]
    fn 改名的名称校验() {
        let id = Uuid::new_v4().to_string();

        let err = rename_theme(id.clone(), "   ".to_string()).unwrap_err();
        assert!(err.contains("不能为空"), "实际：{err}");

        let err = rename_theme(id.clone(), "字".repeat(41)).unwrap_err();
        assert!(err.contains("40"), "实际：{err}");

        let err = rename_theme(id, "a\nb".to_string()).unwrap_err();
        assert!(err.contains("控制字符"), "实际：{err}");
    }

    #[test]
    fn 改名应去掉首尾空格且不动导入时间() {
        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id);
        paths::ensure_dir(&dir).expect("建临时主题目录");
        let theme = fake_theme(&id);
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).unwrap(),
        )
        .expect("写入初始 theme.json");

        let outcome = rename_theme(id.clone(), "  新名字  ".to_string());

        let saved: CursorTheme = serde_json::from_str(
            &fs::read_to_string(dir.join("theme.json")).expect("读回 theme.json"),
        )
        .expect("解析 theme.json");

        fs::remove_dir_all(&dir).ok();

        let renamed = outcome.expect("改名应成功");
        assert_eq!(renamed.name, "新名字", "首尾空格应被去掉");
        assert_eq!(saved.name, "新名字", "改名结果必须落盘");
        assert_eq!(saved.updated_at, "", "改名不应改动导入时间");
    }
}
