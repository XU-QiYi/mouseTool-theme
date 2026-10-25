//! 主题槽位路径的存储口径：磁盘上存相对路径，运行时统一解析成绝对路径
//!
//! `theme.json` 里写死绝对路径时，主题目录一旦搬家（换存储目录、从备份恢复到
//! 新根目录），所有槽位都会失效。现在磁盘只存 `cursors/arrow.cur` 这类相对
//! 主题目录的路径；`read_user_themes` 读出来时拼回绝对路径，注册表、预览与
//! 前端看到的仍是绝对路径。
//!
//! 旧版本写下的绝对路径继续能读；迁移、备份导出与恢复会把它改写成相对路径。
//! 绝对路径不在当前主题目录内时，先按路径里的主题 id 重新定位，再按文件名在
//! 主题内匹配，实在找不到才保留原样并给出提示。

use std::fs;
use std::path::{Component, Path, PathBuf};

use uuid::Uuid;

use crate::models::CursorTheme;
use crate::utils::limits;

/// 去掉 Windows canonicalize 产生的 `\\?\` 前缀（UNC 形式保持原样）
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        if !rest.starts_with("UNC\\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// 相对路径归一化成 `/` 分隔；绝对路径、盘符、`..` 一律拒绝
pub fn normalize_relative(raw: &str) -> Option<String> {
    let path = Path::new(raw.trim());
    if path.is_absolute() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// 是否为绝对路径（Windows 盘符或 UNC）
pub fn is_absolute(raw: &str) -> bool {
    Path::new(raw.trim()).is_absolute()
}

/// 把磁盘上的槽位路径解析成绝对路径；空字符串保持为空
///
/// 相对路径拼到主题目录；旧的绝对路径原样返回（兼容）。含 `..` 的怪相对路径
/// 解析为空，避免预览/应用被带到主题目录之外。
pub fn resolve(raw: &str, theme_dir: &Path) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(relative) = normalize_relative(trimmed) {
        return theme_dir.join(relative).to_string_lossy().into_owned();
    }
    if is_absolute(trimmed) {
        trimmed.to_string()
    } else {
        String::new()
    }
}

/// 就地把主题里的槽位路径解析成绝对路径
pub fn resolve_theme(theme: &mut CursorTheme, theme_dir: &Path) {
    for slot in &mut theme.cursors {
        slot.file_path = resolve(&slot.file_path, theme_dir);
    }
}

/// 递归收集主题目录内的文件，返回相对路径列表
fn collect_candidates(theme_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_into(theme_dir, theme_dir, &mut out);
    out
}

fn collect_into(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let path = entry.path();
        if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            collect_into(root, &path, out);
        } else if let Some(relative) = relative_to(&path, root) {
            out.push(PathBuf::from(relative));
        }
    }
}

/// `path` 在 `base` 之下时返回相对路径（`/` 分隔，大小写不敏感比较）
pub fn relative_to(path: &Path, base: &Path) -> Option<String> {
    let path = strip_verbatim(path);
    let base = strip_verbatim(base);
    let path_parts: Vec<Component> = path.components().collect();
    let base_parts: Vec<Component> = base.components().collect();
    if path_parts.len() <= base_parts.len() {
        return None;
    }
    for (path_part, base_part) in path_parts.iter().zip(base_parts.iter()) {
        if !path_part
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&base_part.as_os_str().to_string_lossy())
        {
            return None;
        }
    }
    let mut parts = Vec::new();
    for component in &path_parts[base_parts.len()..] {
        match component {
            Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// 旧绝对路径里带主题 id 时，取 id 之后的相对部分
fn relative_after_theme_id(path: &Path, theme_id: &str) -> Option<String> {
    let parts: Vec<Component> = path.components().collect();
    let index = parts.iter().position(|component| {
        matches!(
            component,
            Component::Normal(name)
                if name.to_string_lossy().eq_ignore_ascii_case(theme_id)
        )
    })?;
    let mut out = Vec::new();
    for component in &parts[index + 1..] {
        match component {
            Component::Normal(name) => out.push(name.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join("/"))
    }
}

/// 绝对路径无法按目录/id 定位时，用文件名在主题内唯一匹配
fn match_by_file_name(path: &Path, candidates: &[PathBuf]) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    let mut matched = candidates
        .iter()
        .filter(|candidate| {
            candidate
                .file_name()
                .map(|file_name| file_name.to_string_lossy().to_lowercase() == name)
                .unwrap_or(false)
        });
    let first = matched.next()?;
    if matched.next().is_some() {
        return None;
    }
    normalize_relative(&first.to_string_lossy())
}

/// 单条槽位路径 → 磁盘存储写法
///
/// 返回 `(存储路径, 提示)`；提示只在无法改写成相对路径时出现。
fn storage_path(
    raw: &str,
    theme_id: &str,
    theme_dir: &Path,
    candidates: &[PathBuf],
) -> (String, Option<String>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (String::new(), None);
    }
    if let Some(relative) = normalize_relative(trimmed) {
        return (relative, None);
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        if let Some(relative) = relative_to(path, theme_dir) {
            return (relative, None);
        }
        if let Some(relative) = relative_after_theme_id(path, theme_id) {
            return (relative, None);
        }
        if let Some(relative) = match_by_file_name(path, candidates) {
            return (relative, None);
        }
        return (
            trimmed.to_string(),
            Some(format!("不在主题目录内，保留原绝对路径（{trimmed}）")),
        );
    }

    (
        trimmed.to_string(),
        Some(format!("不是有效的相对路径，保留原值（{trimmed}）")),
    )
}

/// 主题 → 可写入 `theme.json` 的副本（槽位路径相对化）
///
/// `extra_candidates` 用于备份恢复：目标目录还没落盘，只能拿 zip 里的文件
/// 列表来按文件名兜底。返回的提示交给调用方决定是否展示。
pub fn to_storage_with_candidates(
    theme: &CursorTheme,
    theme_dir: &Path,
    extra_candidates: Option<&[PathBuf]>,
) -> (CursorTheme, Vec<String>) {
    let mut candidates = collect_candidates(theme_dir);
    if let Some(extra) = extra_candidates {
        candidates.extend(extra.iter().cloned());
    }
    candidates.sort();
    candidates.dedup();

    let mut disk = theme.clone();
    let mut warnings = Vec::new();
    for slot in &mut disk.cursors {
        let (stored, warning) = storage_path(&slot.file_path, &theme.id, theme_dir, &candidates);
        if let Some(message) = warning {
            warnings.push(format!("{}：{message}", slot.display_name));
        }
        slot.file_path = stored;
    }
    (disk, warnings)
}

/// 主题 → 可写入 `theme.json` 的副本（槽位路径相对化）
pub fn to_storage(theme: &CursorTheme, theme_dir: &Path) -> (CursorTheme, Vec<String>) {
    to_storage_with_candidates(theme, theme_dir, None)
}

/// 把主题写到 `theme_dir/theme.json`，槽位路径落盘前统一相对化
pub fn write_theme_json(theme_dir: &Path, theme: &CursorTheme) -> Result<Vec<String>, String> {
    let (disk, warnings) = to_storage(theme, theme_dir);
    write_stored_theme(theme_dir, &disk)?;
    Ok(warnings)
}

/// 写入已经相对化好的主题副本（不再重复扫描文件）
///
/// 先写同目录临时文件再改名：中途崩溃只会留下 `.theme.json-*.tmp`，
/// 不会把用户唯一的一份 `theme.json` 截断成半个 JSON。
pub fn write_stored_theme(theme_dir: &Path, theme: &CursorTheme) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(theme).map_err(|err| format!("序列化主题失败：{err}"))?;
    let target = theme_dir.join("theme.json");
    let tmp = theme_dir.join(format!(".theme.json-{}.tmp", Uuid::new_v4()));
    if let Err(err) = fs::write(&tmp, json) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("写入 theme.json 失败：{err}"));
    }
    if let Err(err) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("保存 theme.json 失败：{err}"));
    }
    Ok(())
}

/// 读入磁盘上的 `theme.json`，把旧绝对路径改写成相对路径后写回
///
/// 主题目录已经在目标位置时使用（迁移后的收尾）。文件解析失败返回 Err，
/// 由调用方决定是原样保留还是中止。
pub fn rewrite_theme_file(theme_dir: &Path) -> Result<Vec<String>, String> {
    let raw = limits::read_text_bounded(
        &theme_dir.join("theme.json"),
        limits::MAX_THEME_JSON_BYTES,
    )
    .map_err(|err| format!("读不到 theme.json（{err}）"))?;
    let theme: CursorTheme =
        serde_json::from_str(&raw).map_err(|err| format!("theme.json 解析失败（{err}）"))?;
    write_theme_json(theme_dir, &theme)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CursorSlot;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cursorstudio-theme-paths-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn theme_with_path(id: &str, path: &str) -> CursorTheme {
        CursorTheme {
            id: id.to_string(),
            name: "测试".to_string(),
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            is_built_in: false,
            cursors: vec![CursorSlot {
                registry_key: "Arrow".to_string(),
                display_name: "正常选择".to_string(),
                english_name: "Normal Select".to_string(),
                file_path: path.to_string(),
                file_type: "cur".to_string(),
            }],
        }
    }

    #[test]
    fn 相对路径解析到主题目录() {
        let root = temp_root("resolve");
        let resolved = resolve("cursors/arrow.cur", &root);
        assert_eq!(Path::new(&resolved), root.join("cursors/arrow.cur"));
        assert_eq!(resolve("", &root), "");
        assert_eq!(resolve("../evil.cur", &root), "", "越界相对路径不解析");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 旧绝对路径兼容且写入时变相对() {
        let root = temp_root("legacy");
        let theme_dir = root.join("11111111-1111-4111-8111-111111111111");
        fs::create_dir_all(theme_dir.join("cursors")).expect("建主题目录");
        fs::write(theme_dir.join("cursors").join("arrow.cur"), "x").expect("写光标");

        let absolute = theme_dir.join("cursors").join("arrow.cur");
        let theme = theme_with_path("11111111-1111-4111-8111-111111111111", &absolute.to_string_lossy());
        let (disk, warnings) = to_storage(&theme, &theme_dir);

        assert_eq!(disk.cursors[0].file_path, "cursors/arrow.cur");
        assert!(warnings.is_empty(), "旧的目录内绝对路径应能无提示改写");

        let resolved = resolve(&disk.cursors[0].file_path, &theme_dir);
        assert_eq!(Path::new(&resolved), absolute);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 旧绝对路径可按主题_id_重定位() {
        let root = temp_root("remap");
        let new_dir = root.join("newroot").join("11111111-1111-4111-8111-111111111111");
        fs::create_dir_all(new_dir.join("cursors")).expect("建新主题目录");
        fs::write(new_dir.join("cursors").join("arrow.cur"), "x").expect("写光标");

        let old_path = format!(
            r"C:\Users\old\AppData\Local\CursorStudio\themes\11111111-1111-4111-8111-111111111111\cursors\arrow.cur"
        );
        let theme = theme_with_path("11111111-1111-4111-8111-111111111111", &old_path);
        let (disk, warnings) = to_storage(&theme, &new_dir);

        assert_eq!(disk.cursors[0].file_path, "cursors/arrow.cur");
        assert!(warnings.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 旧绝对路径可按文件名兜底() {
        let root = temp_root("filename");
        let theme_dir = root.join("11111111-1111-4111-8111-111111111111");
        fs::create_dir_all(theme_dir.join("cursors")).expect("建主题目录");
        fs::write(theme_dir.join("cursors").join("arrow.cur"), "x").expect("写光标");

        let theme = theme_with_path(
            "11111111-1111-4111-8111-111111111111",
            r"D:\somewhere\else\arrow.cur",
        );
        let (disk, warnings) = to_storage(&theme, &theme_dir);

        assert_eq!(disk.cursors[0].file_path, "cursors/arrow.cur");
        assert!(warnings.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 重写_theme_json_落相对路径() {
        let root = temp_root("rewrite");
        let theme_dir = root.join("11111111-1111-4111-8111-111111111111");
        fs::create_dir_all(theme_dir.join("cursors")).expect("建主题目录");
        fs::write(theme_dir.join("cursors").join("arrow.cur"), "x").expect("写光标");
        let absolute = theme_dir.join("cursors").join("arrow.cur");
        let theme = theme_with_path("11111111-1111-4111-8111-111111111111", &absolute.to_string_lossy());
        fs::write(
            theme_dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).unwrap(),
        )
        .expect("写 theme.json");

        rewrite_theme_file(&theme_dir).expect("重写");

        let raw = fs::read_to_string(theme_dir.join("theme.json")).expect("读回");
        let saved: CursorTheme = serde_json::from_str(&raw).expect("解析");
        assert_eq!(saved.cursors[0].file_path, "cursors/arrow.cur");

        let _ = fs::remove_dir_all(&root);
    }
}
