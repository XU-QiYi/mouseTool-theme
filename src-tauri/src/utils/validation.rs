//! IPC 输入校验：槽位白名单、光标文件来源、目标路径、主题 id 与目录一致性
//!
//! 前端传来的 `CursorTheme` 不能直接信任：槽位键可能拼错，`file_path` 可能指向
//! 数据目录之外，`dest_path` 可能落在不存在的目录。这里集中做一次校验，
//! 命令层只负责把错误原样交给用户。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::models::{CursorSlot, CursorTheme};
use crate::utils::{limits, paths, registry, theme_paths};

/// 光标文件允许的扩展名
pub fn is_cursor_extension(ext: &str) -> bool {
    matches!(ext.to_ascii_lowercase().as_str(), "cur" | "ani" | "ico")
}

fn extension_of(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
}

/// 15 个标准槽位白名单
pub fn is_known_slot(key: &str) -> bool {
    registry::SLOT_DEFS.iter().any(|(known, _, _)| *known == key)
}

/// 校验主题里的槽位：键名在 15 个标准槽位内、无重复、路径是光标文件
pub fn validate_theme_slots(theme: &CursorTheme) -> Result<(), String> {
    let mut seen: HashSet<&str> = HashSet::new();
    for slot in &theme.cursors {
        if !is_known_slot(&slot.registry_key) {
            return Err(format!(
                "主题包含未知槽位「{}」；只接受 15 个 Windows 标准槽位",
                slot.registry_key
            ));
        }
        if !seen.insert(slot.registry_key.as_str()) {
            return Err(format!("槽位「{}」重复出现", slot.registry_key));
        }
        if slot.file_path.trim().is_empty() {
            return Err(format!("槽位「{}」缺少光标文件路径", slot.registry_key));
        }
        match extension_of(&slot.file_path) {
            Some(ext) if is_cursor_extension(&ext) => {}
            _ => {
                return Err(format!(
                    "槽位「{}」不是 .cur / .ani / .ico 光标文件",
                    slot.registry_key
                ))
            }
        }
    }
    Ok(())
}

/// 光标文件允许的来源：当前主题目录与系统光标目录
fn allowed_cursor_roots() -> Vec<PathBuf> {
    let mut roots = vec![paths::themes_dir()];
    if let Ok(system_root) = std::env::var("SystemRoot") {
        roots.push(PathBuf::from(system_root).join("Cursors"));
    }
    roots
}

fn canonical_within(path: &Path, root: &Path) -> bool {
    let Ok(file) = fs::canonicalize(path) else {
        return false;
    };
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    file.starts_with(root)
}

/// 校验一个将要读取/应用/导出的光标文件
///
/// 返回规范化后的绝对路径；文件必须在主题目录或系统光标目录内，
/// 且不超过单文件上限。`apply_theme` / `export_theme` / 预览共用。
pub fn ensure_cursor_file(path: &str) -> Result<PathBuf, String> {
    check_cursor_file(path, true)
}

/// 系统方案的光标文件：Windows 允许「已保存方案」引用任意目录，不做根限制
///
/// 仍然要求存在、是光标文件且不超过体积上限；只用于 `is_built_in` 的主题，
/// 用户主题一律走 `ensure_cursor_file`。
pub fn ensure_readable_cursor_file(path: &str) -> Result<PathBuf, String> {
    check_cursor_file(path, false)
}

fn check_cursor_file(path: &str, require_containment: bool) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("光标文件路径为空".to_string());
    }
    match extension_of(trimmed) {
        Some(ext) if is_cursor_extension(&ext) => {}
        _ => return Err(format!("不是光标文件：{trimmed}")),
    }

    let file = fs::canonicalize(trimmed)
        .map_err(|err| format!("光标文件不存在或无法访问（{err}）：{trimmed}"))?;
    if !file.is_file() {
        return Err(format!("光标路径不是文件：{trimmed}"));
    }
    let size = fs::metadata(&file)
        .map_err(|err| format!("读不到光标文件信息（{err}）"))?
        .len();
    if size > limits::MAX_CURSOR_FILE_BYTES {
        return Err(format!(
            "光标文件超过 {}MB 上限：{trimmed}",
            limits::MAX_CURSOR_FILE_BYTES / 1024 / 1024
        ));
    }

    if require_containment
        && !allowed_cursor_roots()
            .iter()
            .any(|root| canonical_within(&file, root))
    {
        return Err(format!(
            "光标文件不在主题目录或系统光标目录内，已拒绝：{trimmed}"
        ));
    }
    Ok(file)
}

/// 预览路径校验：不满足条件返回 `None`，由命令降级为空预览
pub fn preview_path_if_allowed(path: &str) -> Option<PathBuf> {
    let file = ensure_cursor_file(path).ok()?;
    let meta = fs::metadata(&file).ok()?;
    if meta.len() > limits::MAX_PREVIEW_BYTES {
        return None;
    }
    Some(file)
}

/// 主题目录内的词法包含判断（文件可能还不存在，不能 canonicalize）
pub fn path_within_theme_dir(path: &Path, theme_dir: &Path) -> bool {
    theme_paths::relative_to(path, theme_dir).is_some()
}

/// 用户主题的 id 必须等于目录名，且 theme.json 里的 id 也要一致
///
/// 系统方案只存在于注册表，没有目录，直接放行（但 id 必须带 `sys_` 前缀）。
pub fn ensure_theme_id_matches_dir(theme: &CursorTheme) -> Result<PathBuf, String> {
    if theme.is_built_in {
        if !theme.id.starts_with("sys_") {
            return Err("系统方案的 ID 必须以 sys_ 开头".to_string());
        }
        return Ok(PathBuf::new());
    }

    let id = Uuid::parse_str(&theme.id).map_err(|_| "非法的主题 ID".to_string())?;
    if id.to_string() != theme.id {
        return Err("主题 ID 必须是规范的小写 UUID".to_string());
    }

    let dir = paths::theme_dir(&theme.id);
    if !dir.is_dir() {
        return Err("主题目录已经不在了，可能要重新导入".to_string());
    }
    if dir.file_name().and_then(|name| name.to_str()) != Some(theme.id.as_str()) {
        return Err("主题 ID 与目录名不一致，已拒绝".to_string());
    }

    let json_path = dir.join("theme.json");
    let Ok(raw) = limits::read_text_bounded(&json_path, 1024 * 1024) else {
        return Err("读不到主题信息，无法确认主题目录".to_string());
    };
    let stored: serde_json::Value =
        serde_json::from_str(&raw).map_err(|err| format!("主题信息已损坏（{err}）"))?;
    if stored.get("id").and_then(|value| value.as_str()) != Some(theme.id.as_str()) {
        return Err("theme.json 里的 ID 与主题目录不一致，已拒绝".to_string());
    }

    Ok(dir)
}

/// 校验用户选择的保存路径：目录存在、扩展名正确、文件名非空
pub fn validate_dest_path(raw: &str, expected_ext: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("保存路径不能为空".to_string());
    }
    let dest = Path::new(trimmed);
    let parent = dest.parent().ok_or_else(|| "目标路径无效".to_string())?;
    if !parent.is_dir() {
        return Err(format!("目标文件夹不存在：{}", parent.display()));
    }
    let Some(name) = dest.file_name().and_then(|name| name.to_str()) else {
        return Err("目标文件名无效".to_string());
    };
    if name.is_empty() {
        return Err("目标文件名不能为空".to_string());
    }
    if name.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Err("目标文件名包含非法字符".to_string());
    }
    let ext = dest
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    if !ext.eq_ignore_ascii_case(expected_ext) {
        return Err(format!("保存文件必须以 .{expected_ext} 结尾"));
    }
    if dest.is_dir() {
        return Err("目标路径是一个目录，请选择文件名".to_string());
    }
    Ok(dest.to_path_buf())
}

/// 校验用户选择的来源文件：存在、是文件、扩展名正确
///
/// 导入主题与恢复备份共用；文件夹导入不走这里（由 importer 自己判断目录）。
pub fn validate_source_file(
    raw: &str,
    expected_ext: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{label}路径不能为空"));
    }
    let path = Path::new(trimmed);
    if !path.is_file() {
        return Err(format!("{label}不存在或不是文件：{trimmed}"));
    }
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    if !ext.eq_ignore_ascii_case(expected_ext) {
        return Err(format!("{label}必须是 .{expected_ext} 文件"));
    }
    Ok(path.to_path_buf())
}

/// 改名 / 导入共用的名称校验
pub fn validate_theme_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if name.chars().count() > 40 {
        return Err("名称最多 40 个字".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("名称不能包含换行或控制字符".to_string());
    }
    Ok(name.to_string())
}

/// 读盘后的槽位清洗：未知键、重复键、越出主题目录的路径都丢弃并给出提示
pub fn sanitize_loaded_slots(theme: &mut CursorTheme, theme_dir: &Path) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut kept = Vec::new();

    for slot in theme.cursors.drain(..) {
        if !is_known_slot(&slot.registry_key) {
            warnings.push(format!(
                "主题《{}》包含未知槽位「{}」，已忽略",
                theme.name, slot.registry_key
            ));
            continue;
        }
        if !seen.insert(slot.registry_key.clone()) {
            warnings.push(format!(
                "主题《{}》的槽位「{}」重复，已忽略后一条",
                theme.name, slot.registry_key
            ));
            continue;
        }
        if slot.file_path.trim().is_empty() {
            continue;
        }
        if !path_within_theme_dir(Path::new(&slot.file_path), theme_dir) {
            warnings.push(format!(
                "主题《{}》的槽位「{}」路径越出主题目录，已忽略",
                theme.name, slot.registry_key
            ));
            continue;
        }
        let file_type = extension_of(&slot.file_path).unwrap_or(slot.file_type);
        kept.push(CursorSlot {
            registry_key: slot.registry_key,
            display_name: slot.display_name,
            english_name: slot.english_name,
            file_path: slot.file_path,
            file_type,
        });
    }

    theme.cursors = kept;
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(key: &str, path: &str) -> CursorSlot {
        CursorSlot {
            registry_key: key.to_string(),
            display_name: String::new(),
            english_name: String::new(),
            file_path: path.to_string(),
            file_type: "cur".to_string(),
        }
    }

    fn theme(slots: Vec<CursorSlot>) -> CursorTheme {
        CursorTheme {
            id: "x".to_string(),
            name: "x".to_string(),
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            is_built_in: true,
            cursors: slots,
        }
    }

    #[test]
    fn 槽位白名单拒绝未知键与重复键() {
        assert!(validate_theme_slots(&theme(vec![slot("Cross", "a.cur")])).is_err());
        assert!(validate_theme_slots(&theme(vec![slot("Arrow", "a.cur"), slot("Arrow", "b.cur")])).is_err());
        assert!(validate_theme_slots(&theme(vec![slot("Arrow", "a.png")])).is_err());
        assert!(validate_theme_slots(&theme(vec![slot("Arrow", "a.cur")])).is_ok());
    }

    #[test]
    fn 保存路径必须是存在的目录加_zip_后缀() {
        let dir = std::env::temp_dir();
        let ok = dir.join("cursorstudio-dest-test.zip");
        assert!(validate_dest_path(ok.to_str().unwrap(), "zip").is_ok());
        let bad = dir.join("cursorstudio-dest-test.txt");
        assert!(validate_dest_path(bad.to_str().unwrap(), "zip").is_err());
        assert!(validate_dest_path(r"C:\不存在的目录\x.zip", "zip").is_err());
    }

    #[test]
    fn 名称校验() {
        assert_eq!(validate_theme_name("  新名字 ").unwrap(), "新名字");
        assert!(validate_theme_name("  ").is_err());
        assert!(validate_theme_name(&"字".repeat(41)).is_err());
        assert!(validate_theme_name("a\nb").is_err());
    }

    #[test]
    fn 词法包含拒绝父目录() {
        let base = Path::new(r"C:\data\themes\abc");
        assert!(path_within_theme_dir(Path::new(r"C:\data\themes\abc\cursors\a.cur"), base));
        assert!(!path_within_theme_dir(Path::new(r"C:\data\themes\abc\..\evil.cur"), base));
        assert!(!path_within_theme_dir(Path::new(r"C:\data\other\a.cur"), base));
    }
}
