//! 主题存储目录：默认 `<数据目录>\themes`，用户可改（改时把现有主题搬过去）
//!
//! 解析的唯一来源仍是 `paths::themes_dir()`（它读这里的自定义值）；本模块负责
//! 「换目录」这件事本身，顺序固定：**校验 → 复制到暂存目录 → 校验内容 → 原子
//! 改名 → 重绑注册表 → 落盘设置 → 清理源目录**。
//!
//! 几条硬规矩：
//! - 目标先 canonicalize，拒绝 UNC、重解析点、数据目录内部（默认目录除外）、
//!   数据目录的祖先、与源目录互相嵌套、以及任何非空目录——非空目录里可能
//!   已有同名主题，覆盖就是删用户数据；
//! - 所有内容先写进目标同级的 `.cursorstudio-migrate-<uuid>` 暂存目录，逐文件
//!   哈希比对通过后才 `rename` 成目标目录，切换是原子的；
//! - `theme.json` 在暂存区里改写成相对路径，搬完后不再依赖旧根目录；
//! - 注册表重绑或设置写入失败都会回滚：删掉新目录、把注册表改回去，源目录与
//!   设置保持原样。只有全部成功后才删源目录，删不掉只降级为提示（数据还在）。

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Read;
use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf, Prefix};

use serde::Serialize;
use uuid::Uuid;

use crate::models::CursorTheme;
use crate::utils::{limits, paths, registry, settings, theme_paths};

/// 重解析点（符号链接 / 目录联接 / OneDrive 占位）的文件属性位
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// 迁移前的确认信息：界面拿它展示源、目标、主题数量与体积
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ThemesDirPlan {
    /// 当前生效的主题目录
    pub source: String,
    /// 目标目录（已 canonicalize）
    pub target: String,
    /// 目标就是默认目录（`<数据目录>\themes`）
    pub is_default: bool,
    /// 源目录里有 `theme.json` 的主题数
    pub theme_count: usize,
    /// 源目录里的文件总数（含非主题文件）
    pub file_count: usize,
    /// 源目录总体积（字节）
    pub total_bytes: u64,
    /// 扫描时发现的问题（缺 theme.json 的目录等），不阻断迁移
    pub warnings: Vec<String>,
}

/// 迁移进度：阶段键固定，界面据此显示文案与进度条
#[derive(Debug, Clone, Serialize)]
pub struct MoveProgress {
    /// copy / verify / switch / registry / settings / cleanup / done
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

impl MoveProgress {
    fn phase(phase: &str, message: &str) -> Self {
        Self {
            phase: phase.to_string(),
            current: 0,
            total: 0,
            message: message.to_string(),
        }
    }
}

/// 迁移完成后的结果：快照由命令层补，这里只报搬运本身的事实
#[derive(Debug, Clone, Serialize)]
pub struct ThemesDirChange {
    pub source: String,
    pub target: String,
    pub theme_count: usize,
    pub file_count: usize,
    pub total_bytes: u64,
    /// 注册表里被改写的槽位数（0 = 当前没有正在使用的用户主题）
    pub rebound_slots: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default)]
struct Scan {
    theme_count: usize,
    file_count: usize,
    total_bytes: u64,
    warnings: Vec<String>,
    /// 顶层主题目录名 → 解析成功的主题（损坏的 theme.json 不进这里）
    themes: HashMap<String, CursorTheme>,
}

struct Prepared {
    source: PathBuf,
    target: PathBuf,
    /// 写入 `settings.json` 的值；`None` = 默认目录
    settings_value: Option<String>,
    is_default: bool,
    /// 目标原本就存在且为空：回滚时要把它恢复成空目录
    target_existed_empty: bool,
    scan: Scan,
}

/// 大小写不敏感地比较两个路径是不是同一个
fn same_path(left: &Path, right: &Path) -> bool {
    let left = theme_paths::strip_verbatim(left);
    let right = theme_paths::strip_verbatim(right);
    let left_parts: Vec<Component> = left.components().collect();
    let right_parts: Vec<Component> = right.components().collect();
    left_parts.len() == right_parts.len()
        && left_parts.iter().zip(right_parts.iter()).all(|(a, b)| {
            a.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
        })
}

/// `child` 是否严格位于 `parent` 之下（大小写不敏感）
fn is_within(child: &Path, parent: &Path) -> bool {
    theme_paths::relative_to(child, parent).is_some()
}

fn is_unc(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _))
    )
}

fn has_reparse_point(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

/// 沿着路径逐段检查已存在的部分，任何一段是重解析点都拒绝
///
/// 不做这一步的话，canonicalize 会顺着链接跑到别处，校验看到的路径与用户
/// 选的根本不是同一个地方。
fn reject_reparse_chain(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if has_reparse_point(&current) {
            return Err(format!(
                "路径经过符号链接或目录联接（{}），可能指向别处。请换一个真实目录",
                current.display()
            ));
        }
    }
    Ok(())
}

/// 把目标路径 canonicalize：不存在的尾部保留，已存在的部分解析成真实路径
fn canonicalize_target(raw: &Path) -> Result<PathBuf, String> {
    if is_unc(raw) {
        return Err("不支持网络共享（UNC）路径，请选择本机磁盘上的目录".to_string());
    }
    if !raw.is_absolute() {
        return Err(format!("请选择完整的绝对路径（当前：{}）", raw.display()));
    }

    let mut existing = raw.to_path_buf();
    let mut tail: Vec<OsString> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            return Err(format!("目录路径无效（{}）", raw.display()));
        };
        tail.push(name.to_os_string());
        let Some(parent) = existing.parent() else {
            return Err(format!("目录路径无效（{}）", raw.display()));
        };
        existing = parent.to_path_buf();
    }
    if !existing.is_dir() {
        return Err(format!("路径里有一段不是文件夹：{}", existing.display()));
    }

    reject_reparse_chain(&existing)?;

    let base = existing
        .canonicalize()
        .map_err(|err| format!("无法解析目标路径（{err}）"))?;
    let mut resolved = theme_paths::strip_verbatim(&base);
    for part in tail.iter().rev() {
        resolved.push(part);
    }
    if is_unc(&resolved) {
        return Err("不支持网络共享（UNC）路径，请选择本机磁盘上的目录".to_string());
    }
    Ok(resolved)
}

fn has_entries(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(true)
}

/// 递归累计文件数量与体积
fn count_files(root: &Path, scan: &mut Scan) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                scan.warnings
                    .push(format!("读取目录项失败，已跳过（{err}）"));
                continue;
            }
        };
        if limits::is_reparse_entry(&entry) {
            scan.warnings
                .push(format!("已跳过链接或目录联接：{}", entry.path().display()));
            continue;
        }
        let path = entry.path();
        let is_dir = entry
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false);
        if is_dir {
            count_files(&path, scan);
        } else {
            scan.file_count += 1;
            if let Ok(meta) = entry.metadata() {
                scan.total_bytes += meta.len();
            }
        }
    }
}

/// 扫描源目录：主题数、文件数、体积与损坏提示
fn scan_source(root: &Path) -> Scan {
    let mut scan = Scan::default();
    if !root.exists() {
        return scan;
    }
    match fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) => {
                        scan.warnings
                            .push(format!("读取目录项失败，已跳过（{err}）"));
                        continue;
                    }
                };
                let path = entry.path();
                if limits::is_reparse_entry(&entry) {
                    scan.warnings
                        .push(format!("已跳过链接或目录联接：{}", path.display()));
                    continue;
                }
                if !entry
                    .file_type()
                    .map(|kind| kind.is_dir())
                    .unwrap_or(false)
                {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let json_path = path.join("theme.json");
                if limits::is_reparse_path(&json_path) {
                    scan.warnings.push(format!(
                        "主题 {name} 的 theme.json 是链接或目录联接，已跳过读取（迁移后该主题可能不完整）"
                    ));
                    continue;
                }
                if !json_path.is_file() {
                    scan.warnings
                        .push(format!("目录 {name} 没有 theme.json，会按原样搬过去"));
                    continue;
                }
                match limits::read_text_bounded(&json_path, limits::MAX_THEME_JSON_BYTES)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<CursorTheme>(&raw).ok())
                {
                    Some(theme) => {
                        scan.theme_count += 1;
                        scan.themes.insert(name, theme);
                    }
                    None => scan.warnings.push(format!(
                        "主题 {name} 的 theme.json 无法读取或已损坏，会按原样搬过去"
                    )),
                }
            }
        }
        Err(err) => scan
            .warnings
            .push(format!("原主题目录读不出来（{err}），迁移会创建一个空目录")),
    }
    count_files(root, &mut scan);
    scan
}

/// 校验目标并整理成可执行的迁移计划
fn prepare(new_dir: Option<&str>, data_root: &Path, current: &Path) -> Result<Prepared, String> {
    let default_target = canonicalize_target(&data_root.join("themes"))?;

    let (target, settings_value, is_default) = match new_dir {
        None => (default_target.clone(), None, true),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("目录路径不能为空".to_string());
            }
            let target = canonicalize_target(Path::new(trimmed))?;
            if same_path(&target, &default_target) {
                (target, None, true)
            } else {
                let value = target.to_string_lossy().into_owned();
                (target, Some(value), false)
            }
        }
    };

    if same_path(current, &target) {
        return Err("当前已经使用这个主题目录，无需迁移".to_string());
    }
    if same_path(data_root, &target) || is_within(data_root, &target) {
        return Err(
            "不能把数据目录本身或它的上级目录设为主题目录：清理数据时会连主题一起删掉"
                .to_string(),
        );
    }
    // 默认目录就在数据目录内部，是唯一允许的内部位置
    if is_within(&target, data_root) && !same_path(&target, &default_target) {
        return Err(
            "不能把主题目录设在数据目录内部（默认目录除外）：备份与清理会把它当成数据一起处理"
                .to_string(),
        );
    }
    if target.parent().is_none() {
        return Err("不能选磁盘根目录作为主题目录，请新建一个专用文件夹".to_string());
    }
    if is_within(&target, current) || is_within(current, &target) {
        return Err("新旧目录不能互相嵌套，请换一个与当前目录平级的空文件夹".to_string());
    }
    if target.exists() && !target.is_dir() {
        return Err(format!("目标路径已经是一个文件：{}", target.display()));
    }

    let scan = scan_source(current);
    let target_existed_empty = if target.exists() {
        if has_entries(&target) {
            let clash = scan
                .themes
                .keys()
                .find(|name| target.join(name.as_str()).exists());
            return Err(match clash {
                Some(name) => format!(
                    "目标目录里已经有同名主题 {name}，为避免覆盖不会迁移，也不会删除任何文件。请换一个空文件夹"
                ),
                None => "目标目录不是空的：请选择一个空文件夹，避免把无关文件当主题搬走".to_string(),
            });
        }
        true
    } else {
        false
    };

    Ok(Prepared {
        source: current.to_path_buf(),
        target,
        settings_value,
        is_default,
        target_existed_empty,
        scan,
    })
}

/// 给界面预检：只校验与统计，不碰任何文件
pub fn preview(new_dir: Option<&str>) -> Result<ThemesDirPlan, String> {
    let prepared = prepare(
        new_dir,
        &paths::data_root()?,
        &paths::themes_dir()?,
    )?;
    Ok(ThemesDirPlan {
        source: prepared.source.to_string_lossy().into_owned(),
        target: prepared.target.to_string_lossy().into_owned(),
        is_default: prepared.is_default,
        theme_count: prepared.scan.theme_count,
        file_count: prepared.scan.file_count,
        total_bytes: prepared.scan.total_bytes,
        warnings: prepared.scan.warnings,
    })
}

fn copy_into(
    from: &Path,
    to: &Path,
    copied: &mut usize,
    total: usize,
    warnings: &mut Vec<String>,
    progress: &mut dyn FnMut(MoveProgress),
) -> Result<(), String> {
    let entries = fs::read_dir(from).map_err(|err| format!("读取原目录失败（{err}）"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("读取目录项失败（{err}）"))?;
        let src = entry.path();
        if limits::is_reparse_entry(&entry) {
            warnings.push(format!("已跳过链接或目录联接：{}", src.display()));
            continue;
        }
        let dest = to.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|err| format!("读不到目录项类型（{err}）"))?
            .is_dir()
        {
            fs::create_dir_all(&dest).map_err(|err| format!("创建目录失败（{err}）"))?;
            copy_into(&src, &dest, copied, total, warnings, progress)?;
        } else {
            fs::copy(&src, &dest).map_err(|err| {
                format!("复制文件 {} 失败（{err}）", src.display())
            })?;
            *copied += 1;
            progress(MoveProgress {
                phase: "copy".to_string(),
                current: *copied,
                total,
                message: format!("正在复制主题文件（{copied}/{total}）"),
            });
        }
    }
    Ok(())
}

fn copy_source(
    source: &Path,
    staging: &Path,
    total: usize,
    warnings: &mut Vec<String>,
    progress: &mut dyn FnMut(MoveProgress),
) -> Result<(), String> {
    paths::ensure_dir(staging)?;
    if !source.exists() {
        return Ok(());
    }
    let mut copied = 0usize;
    copy_into(source, staging, &mut copied, total, warnings, progress)
}

/// 把暂存区里每个主题的 `theme.json` 改写成相对路径
fn rewrite_staged(staging: &Path) -> Vec<String> {
    let mut warnings = Vec::new();
    let Ok(entries) = fs::read_dir(staging) else {
        return warnings;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || !dir.join("theme.json").is_file() {
            continue;
        }
        if let Err(err) = theme_paths::rewrite_theme_file(&dir) {
            let name = entry.file_name().to_string_lossy().into_owned();
            warnings.push(format!("主题 {name} 的路径没能改写（{err}），已按原样保留"));
        }
    }
    warnings
}

fn collect_files(root: &Path) -> Result<Vec<(String, PathBuf, u64)>, String> {
    let mut files = Vec::new();
    if root.exists() {
        collect_files_into(root, root, &mut files)?;
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn collect_files_into(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(String, PathBuf, u64)>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| format!("读取目录失败（{err}）"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("读取目录项失败（{err}）"))?;
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|err| format!("读不到目录项类型（{err}）"))?
            .is_dir()
        {
            collect_files_into(root, &path, out)?;
        } else {
            let relative = theme_paths::relative_to(&path, root)
                .ok_or_else(|| format!("无法计算相对路径：{}", path.display()))?;
            let size = entry
                .metadata()
                .map_err(|err| format!("读取文件信息失败（{err}）"))?
                .len();
            out.push((relative, path, size));
        }
    }
    Ok(())
}

/// FNV-1a 64：够用来发现复制过程中的损坏，且不需要新依赖
fn fnv1a(path: &Path) -> Result<u64, String> {
    let mut file =
        File::open(path).map_err(|err| format!("读取文件失败（{}：{err}）", path.display()))?;
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("读取文件失败（{}：{err}）", path.display()))?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    Ok(hash)
}

/// 校验暂存区与源目录内容一致，且所有槽位都能在新目录里找到文件
fn verify(source: &Path, staging: &Path, scan: &Scan) -> Result<(), String> {
    let source_files = collect_files(source)?;
    let staged_files = collect_files(staging)?;
    if source_files.len() != staged_files.len() {
        return Err(format!(
            "复制后文件数量不一致（原 {}，新 {}），已放弃切换",
            source_files.len(),
            staged_files.len()
        ));
    }
    let staged_map: HashMap<&str, &PathBuf> = staged_files
        .iter()
        .map(|(relative, path, _)| (relative.as_str(), path))
        .collect();

    for (relative, source_path, source_size) in &source_files {
        let Some(staged_path) = staged_map.get(relative.as_str()) else {
            return Err(format!("暂存目录缺少文件 {relative}，已放弃切换"));
        };

        let path = Path::new(relative);
        let top_dir = path
            .components()
            .next()
            .map(|component| component.as_os_str().to_string_lossy().into_owned());
        let is_theme_json = path
            .file_name()
            .map(|name| name.eq_ignore_ascii_case("theme.json"))
            .unwrap_or(false)
            && path.components().count() == 2;

        if is_theme_json {
            let theme_name = top_dir.unwrap_or_default();
            if let Some(original) = scan.themes.get(&theme_name) {
                let raw = limits::read_text_bounded(staged_path, limits::MAX_THEME_JSON_BYTES)
                    .map_err(|err| format!("读不到暂存主题信息（{err}）"))?;
                let stored: CursorTheme = serde_json::from_str(&raw)
                    .map_err(|err| format!("暂存主题信息解析失败（{err}）"))?;
                if stored.id != original.id {
                    return Err(format!("主题 {theme_name} 的 ID 在复制后不一致"));
                }
                let original_keys: Vec<&str> =
                    original.cursors.iter().map(|slot| slot.registry_key.as_str()).collect();
                let stored_keys: Vec<&str> =
                    stored.cursors.iter().map(|slot| slot.registry_key.as_str()).collect();
                if original_keys != stored_keys {
                    return Err(format!("主题 {theme_name} 的槽位在复制后不一致"));
                }
                for slot in &stored.cursors {
                    if slot.file_path.trim().is_empty() {
                        continue;
                    }
                    let Some(relative) = theme_paths::normalize_relative(&slot.file_path) else {
                        return Err(format!(
                            "主题 {theme_name} 的槽位 {} 仍有绝对路径，搬家后会失效",
                            slot.display_name
                        ));
                    };
                    let expected = staged_path
                        .parent()
                        .map(|dir| dir.join(&relative))
                        .unwrap_or_default();
                    if !expected.is_file() {
                        return Err(format!(
                            "主题 {theme_name} 的槽位 {} 指向的文件不存在（{relative}）",
                            slot.display_name
                        ));
                    }
                }
                continue;
            }
        }

        let staged_size = fs::metadata(staged_path)
            .map_err(|err| format!("读取暂存文件信息失败（{err}）"))?
            .len();
        if staged_size != *source_size {
            return Err(format!("文件 {relative} 复制后大小不一致，已放弃切换"));
        }
        if fnv1a(source_path)? != fnv1a(staged_path)? {
            return Err(format!("文件 {relative} 复制后内容校验失败，已放弃切换"));
        }
    }

    Ok(())
}

/// 原子切换：目标只可能是空目录，先移除再改名，失败时尽量把空目录恢复
fn switch_staging(staging: &Path, target: &Path, existed_empty: bool) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir(target)
            .map_err(|err| format!("清空目标目录失败（{err}）"))?;
    }
    if let Err(err) = fs::rename(staging, target) {
        if existed_empty {
            let _ = paths::ensure_dir(target);
        }
        return Err(format!("切换到新目录失败（{err}）"));
    }
    Ok(())
}

fn rollback_target(target: &Path, restore_empty: bool) -> Result<(), String> {
    let removed = if target.exists() {
        fs::remove_dir_all(target)
    } else {
        Ok(())
    };
    if restore_empty {
        let _ = paths::ensure_dir(target);
    }
    removed.map_err(|err| format!("清理新目录失败（{err}）"))
}

/// 迁移中途失败：反向重绑注册表并清理目标目录，把没能恢复的部分拼进错误文案
fn rollback_and_report(
    rebind: &mut dyn FnMut(&Path, &Path) -> Result<usize, String>,
    source: &Path,
    target: &Path,
    restore_empty: bool,
    mut message: String,
) -> String {
    if rebind(target, source).is_err() {
        message.push_str("。注意：注册表可能仍有部分槽位指向新目录，请重新应用一次主题");
    }
    if let Err(err) = rollback_target(target, restore_empty) {
        message.push_str(&format!("；清理新目录也失败（{err}）"));
    }
    message
}

/// 执行迁移；设置与注册表通过闭包注入，测试可以模拟写入失败
pub fn change_with(
    new_dir: Option<&str>,
    data_root: &Path,
    current: &Path,
    commit_settings: &mut dyn FnMut(Option<&str>) -> Result<(), String>,
    rebind: &mut dyn FnMut(&Path, &Path) -> Result<usize, String>,
    on_progress: &mut dyn FnMut(MoveProgress),
) -> Result<ThemesDirChange, String> {
    let prepared = prepare(new_dir, data_root, current)?;
    let source = prepared.source.clone();
    let target = prepared.target.clone();
    let parent = target
        .parent()
        .ok_or_else(|| "目标目录没有上级目录".to_string())?;
    paths::ensure_dir(parent)?;

    let staging = parent.join(format!(".cursorstudio-migrate-{}", Uuid::new_v4()));
    let _ = fs::remove_dir_all(&staging);

    // 1. 复制到暂存目录 + 2. 改写 theme.json 为相对路径
    let mut warnings = prepared.scan.warnings.clone();
    let copied = (|| -> Result<Vec<String>, String> {
        copy_source(
            &source,
            &staging,
            prepared.scan.file_count,
            &mut warnings,
            on_progress,
        )?;
        Ok(rewrite_staged(&staging))
    })();
    let rewrite_warnings = match copied {
        Ok(warnings) => warnings,
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("{err}；原目录与设置均未改动"));
        }
    };
    warnings.extend(rewrite_warnings);

    // 3. 内容校验
    on_progress(MoveProgress {
        phase: "verify".to_string(),
        current: 0,
        total: prepared.scan.theme_count,
        message: "正在校验复制结果…".to_string(),
    });
    if let Err(err) = verify(&source, &staging, &prepared.scan) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("{err}；原目录与设置均未改动"));
    }

    // 4. 原子切换
    on_progress(MoveProgress::phase("switch", "正在切换到新目录…"));
    if let Err(err) = switch_staging(&staging, &target, prepared.target_existed_empty) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("{err}；原目录与设置均未改动"));
    }

    // 5. 重绑注册表里仍指向旧目录的槽位
    on_progress(MoveProgress::phase(
        "registry",
        "正在重新绑定正在使用的主题…",
    ));
    let rebound_slots = match rebind(&source, &target) {
        Ok(count) => count,
        Err(err) => {
            return Err(rollback_and_report(
                rebind,
                &source,
                &target,
                prepared.target_existed_empty,
                format!("重新绑定正在使用的主题失败（{err}）；已回滚，原目录未改动"),
            ));
        }
    };

    // 6. 落盘设置；失败则把注册表与文件都回滚
    on_progress(MoveProgress::phase("settings", "正在保存设置…"));
    if let Err(err) = commit_settings(prepared.settings_value.as_deref()) {
        return Err(rollback_and_report(
            rebind,
            &source,
            &target,
            prepared.target_existed_empty,
            format!("保存设置失败（{err}）；已回滚，原目录与设置均未改动"),
        ));
    }

    // 7. 清理源目录：设置已经指向新目录，删不掉不影响使用，只提示
    on_progress(MoveProgress::phase("cleanup", "正在清理原目录…"));
    if source.exists() {
        if let Err(err) = fs::remove_dir_all(&source) {
            warnings.push(format!(
                "新目录已生效，但原目录没删干净（{err}）。可稍后手动删除 {}",
                source.display()
            ));
        }
    }

    on_progress(MoveProgress::phase("done", "迁移完成"));
    Ok(ThemesDirChange {
        source: source.to_string_lossy().into_owned(),
        target: target.to_string_lossy().into_owned(),
        theme_count: prepared.scan.theme_count,
        file_count: prepared.scan.file_count,
        total_bytes: prepared.scan.total_bytes,
        rebound_slots,
        warnings,
    })
}

/// 更换主题存储目录并落盘设置；`None` = 回默认
pub fn change(
    new_dir: Option<String>,
    mut on_progress: impl FnMut(MoveProgress),
) -> Result<ThemesDirChange, String> {
    let data_root = paths::data_root()?;
    let current = paths::themes_dir()?;
    let mut commit_settings = |value: Option<&str>| -> Result<(), String> {
        let mut state = settings::read();
        state.themes_dir = value.map(str::to_string);
        settings::write(&state)
    };
    let mut rebind = |from: &Path, to: &Path| registry::relocate_cursor_paths(from, to);
    change_with(
        new_dir.as_deref(),
        &data_root,
        &current,
        &mut commit_settings,
        &mut rebind,
        &mut on_progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cursorstudio-themes-dir-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        // GitHub 的 Windows runner 上 TEMP 是 8.3 短路径（RUNNER~1），本机是长路径；
        // 这些用例要对路径字符串作比较，与生产的 canonicalize_target 同口径：
        // canonicalize 解析真实路径后 strip_verbatim 剥掉 \\?\ 前缀
        theme_paths::strip_verbatim(&dir.canonicalize().expect("canonicalize 临时目录"))
    }

    fn write_theme(root: &Path, id: &str, absolute_paths: bool) -> PathBuf {
        let theme_dir = root.join(id);
        let cursors = theme_dir.join("cursors");
        fs::create_dir_all(&cursors).expect("建主题目录");
        fs::write(cursors.join("arrow.cur"), b"cursor-data").expect("写光标");
        let file_path = if absolute_paths {
            cursors.join("arrow.cur").to_string_lossy().into_owned()
        } else {
            "cursors/arrow.cur".to_string()
        };
        let theme = CursorTheme {
            id: id.to_string(),
            name: format!("主题 {id}"),
            description: String::new(),
            created_at: "2026-01-01 00:00".to_string(),
            updated_at: "2026-01-01 00:00".to_string(),
            is_built_in: false,
            cursors: vec![crate::models::CursorSlot {
                registry_key: "Arrow".to_string(),
                display_name: "正常选择".to_string(),
                english_name: "Normal Select".to_string(),
                file_path,
                file_type: "cur".to_string(),
            }],
        };
        fs::write(
            theme_dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).expect("序列化主题"),
        )
        .expect("写 theme.json");
        theme_dir
    }

    #[test]
    fn 目标解析拒绝数据目录内部除默认外与上层() {
        let root = temp_root("validate");
        let data_root = root.join("CursorStudio");
        let current = data_root.join("themes");
        fs::create_dir_all(&current).expect("建当前目录");

        // 默认目录允许（当前目录不同时）
        let prepared = prepare(None, &data_root, &root.join("other")).expect("默认目录应允许");
        assert!(prepared.is_default);

        assert!(prepare(Some(data_root.to_str().unwrap()), &data_root, &current).is_err());
        assert!(prepare(
            Some(root.join("CursorStudio").to_str().unwrap()),
            &data_root,
            &current
        )
        .is_err());
        assert!(prepare(
            Some(root.to_str().unwrap()),
            &data_root,
            &current
        )
        .is_err(), "数据目录的祖先也应拒绝");
        assert!(
            prepare(
                Some(data_root.join("custom").to_str().unwrap()),
                &data_root,
                &current
            )
            .is_err(),
            "数据目录内部（非默认）应拒绝"
        );

        let outside = root.join("Cursors");
        assert!(prepare(Some(outside.to_str().unwrap()), &data_root, &current).is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 非空目标拒绝且不删除任何文件() {
        let root = temp_root("nonempty");
        let data_root = root.join("CursorStudio");
        let source = data_root.join("themes");
        let target = root.join("target");

        let id = "11111111-1111-4111-8111-111111111111";
        write_theme(&source, id, true);
        write_theme(&target, id, true);
        let marker = target.join(id).join("keep.txt");
        fs::write(&marker, "不要删我").expect("写标记文件");

        let err = prepare(Some(target.to_str().unwrap()), &data_root, &source)
            .err()
            .expect("同名主题应拒绝");
        assert!(err.contains("同名主题"), "实际：{err}");
        assert!(marker.exists(), "拒绝时不能删除目标里的任何文件");
        assert!(source.join(id).join("theme.json").exists(), "源目录也不能动");

        let _ = fs::remove_dir_all(&root);
    }

    /// 设置写入失败：文件、设置、注册表都要回到原样
    #[test]
    fn 设置写入失败时回滚且源目录完好() {
        let root = temp_root("settings-fail");
        let data_root = root.join("CursorStudio");
        let source = data_root.join("themes");
        let target = root.join("target");
        let id = "22222222-2222-4222-8222-222222222222";
        write_theme(&source, id, true);

        let mut committed: Option<Option<String>> = None;
        let mut rebound: Vec<(PathBuf, PathBuf)> = Vec::new();

        let mut commit = |value: Option<&str>| -> Result<(), String> {
            committed = Some(value.map(str::to_string));
            Err("模拟设置写入失败".to_string())
        };
        let mut rebind = |from: &Path, to: &Path| {
            rebound.push((from.to_path_buf(), to.to_path_buf()));
            Ok(1)
        };
        let mut progress = |_: MoveProgress| {};

        let err = change_with(
            Some(target.to_str().unwrap()),
            &data_root,
            &source,
            &mut commit,
            &mut rebind,
            &mut progress,
        )
        .unwrap_err();

        assert!(err.contains("保存设置失败"), "实际：{err}");
        assert!(source.join(id).join("theme.json").exists(), "源主题必须完好");
        assert!(!target.exists(), "回滚后不能留下新目录");
        assert_eq!(committed, Some(Some(target.to_string_lossy().into_owned())));
        assert_eq!(rebound.len(), 2, "先正向绑定，失败后要反向绑定");
        assert_eq!(rebound[0].0, source);
        assert_eq!(rebound[1].0, target);

        let _ = fs::remove_dir_all(&root);
    }

    /// 注册表重绑失败：文件与设置都要回到原样，且不再继续写设置
    #[test]
    fn 重绑注册表失败时回滚且源目录完好() {
        let root = temp_root("rebind-fail");
        let data_root = root.join("CursorStudio");
        let source = data_root.join("themes");
        let target = root.join("target");
        let id = "44444444-4444-4444-8444-444444444444";
        write_theme(&source, id, true);

        let mut committed = false;
        let mut calls = 0usize;
        let mut commit = |_: Option<&str>| -> Result<(), String> {
            committed = true;
            Ok(())
        };
        let mut rebind = |_: &Path, _: &Path| -> Result<usize, String> {
            calls += 1;
            if calls == 1 {
                Err("模拟重绑失败".to_string())
            } else {
                Ok(1)
            }
        };
        let mut progress = |_: MoveProgress| {};

        let err = change_with(
            Some(target.to_str().unwrap()),
            &data_root,
            &source,
            &mut commit,
            &mut rebind,
            &mut progress,
        )
        .unwrap_err();

        assert!(err.contains("重新绑定正在使用的主题失败"), "实际：{err}");
        assert!(source.join(id).join("theme.json").exists(), "源主题必须完好");
        assert!(!target.exists(), "回滚后不能留下新目录");
        assert!(!committed, "注册表失败后不应继续写设置");
        assert_eq!(calls, 2, "先正向绑定失败，再反向绑定一次");

        let _ = fs::remove_dir_all(&root);
    }

    /// 成功路径：相对化、原子切换、源目录清理、注册表重绑
    #[test]
    fn 迁移成功后槽位变相对且源目录清理() {
        let root = temp_root("success");
        let data_root = root.join("CursorStudio");
        let source = data_root.join("themes");
        let target = root.join("target");
        let id = "33333333-3333-4333-8333-333333333333";
        write_theme(&source, id, true);

        let mut stored: Option<Option<String>> = None;
        let mut rebound = 0usize;
        let mut commit = |value: Option<&str>| -> Result<(), String> {
            stored = Some(value.map(str::to_string));
            Ok(())
        };
        let mut rebind = |_: &Path, _: &Path| {
            rebound += 1;
            Ok(1)
        };
        let mut progress = |_: MoveProgress| {};

        let report = change_with(
            Some(target.to_str().unwrap()),
            &data_root,
            &source,
            &mut commit,
            &mut rebind,
            &mut progress,
        )
        .expect("迁移应成功");

        assert_eq!(report.theme_count, 1);
        assert_eq!(report.file_count, 2);
        assert_eq!(report.rebound_slots, 1);
        assert_eq!(rebound, 1);
        assert_eq!(stored, Some(Some(target.to_string_lossy().into_owned())));
        assert!(!source.exists(), "源目录应被清理");
        assert!(target.join(id).join("cursors").join("arrow.cur").is_file());

        let raw = fs::read_to_string(target.join(id).join("theme.json")).expect("读主题信息");
        let theme: CursorTheme = serde_json::from_str(&raw).expect("解析主题");
        assert_eq!(theme.cursors[0].file_path, "cursors/arrow.cur");

        let _ = fs::remove_dir_all(&root);
    }

    /// 空目标（用户新建的文件夹）可以迁移
    #[test]
    fn 空目标目录可以迁移() {
        let root = temp_root("empty-target");
        let data_root = root.join("CursorStudio");
        let source = data_root.join("themes");
        let target = root.join("empty");
        fs::create_dir_all(&target).expect("建空目标");
        let id = "44444444-4444-4444-8444-444444444444";
        write_theme(&source, id, false);

        let mut commit = |_: Option<&str>| Ok(());
        let mut rebind = |_: &Path, _: &Path| Ok(0usize);

        change_with(
            Some(target.to_str().unwrap()),
            &data_root,
            &source,
            &mut commit,
            &mut rebind,
            &mut |_| {},
        )
        .expect("空目标应允许");

        assert!(target.join(id).join("theme.json").is_file());
        assert!(!source.exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// 旧绝对路径在搬家后必须指向新目录（而不是继续指向旧根）
    #[test]
    fn 旧绝对路径搬家后指向新根() {
        let root = temp_root("legacy-rebind");
        let data_root = root.join("CursorStudio");
        let source = data_root.join("themes");
        let target = root.join("target");
        let id = "55555555-5555-4555-8555-555555555555";
        write_theme(&source, id, true);

        let mut commit = |_: Option<&str>| Ok(());
        let mut rebind = |_: &Path, _: &Path| Ok(0usize);

        change_with(
            Some(target.to_str().unwrap()),
            &data_root,
            &source,
            &mut commit,
            &mut rebind,
            &mut |_| {},
        )
        .expect("迁移应成功");

        let raw = fs::read_to_string(target.join(id).join("theme.json")).expect("读主题信息");
        let theme: CursorTheme = serde_json::from_str(&raw).expect("解析主题");
        let resolved = theme_paths::resolve(&theme.cursors[0].file_path, &target.join(id));
        assert_eq!(
            Path::new(&resolved),
            target.join(id).join("cursors").join("arrow.cur")
        );
        assert!(Path::new(&resolved).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 互为子目录的目标被拒绝() {
        let root = temp_root("nested");
        let data_root = root.join("CursorStudio");
        let source = data_root.join("themes");
        fs::create_dir_all(&source).expect("建源目录");

        assert!(prepare(Some(source.join("sub").to_str().unwrap()), &data_root, &source).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 预览统计主题与文件() {
        let root = temp_root("preview");
        let data_root = root.join("CursorStudio");
        let source = data_root.join("themes");
        let target = root.join("target");
        write_theme(&source, "66666666-6666-4666-8666-666666666666", true);

        let plan = preview_with(&data_root, &source, Some(target.to_str().unwrap()))
            .expect("预检应成功");
        assert_eq!(plan.theme_count, 1);
        assert_eq!(plan.file_count, 2);
        assert!(plan.total_bytes > 0);
        assert_eq!(plan.target, target.to_string_lossy());
        assert!(plan.warnings.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    /// 测试用预检入口（生产入口固定读真实数据目录）
    fn preview_with(
        data_root: &Path,
        current: &Path,
        new_dir: Option<&str>,
    ) -> Result<ThemesDirPlan, String> {
        let prepared = prepare(new_dir, data_root, current)?;
        Ok(ThemesDirPlan {
            source: prepared.source.to_string_lossy().into_owned(),
            target: prepared.target.to_string_lossy().into_owned(),
            is_default: prepared.is_default,
            theme_count: prepared.scan.theme_count,
            file_count: prepared.scan.file_count,
            total_bytes: prepared.scan.total_bytes,
            warnings: prepared.scan.warnings,
        })
    }
}
