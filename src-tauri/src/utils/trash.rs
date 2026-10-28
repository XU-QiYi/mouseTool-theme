//! 主题回收站：删除改为软删除，误删可从「设置 → 数据 → 回收站」恢复
//!
//! 存储：`%LOCALAPPDATA%\CursorStudio\trash\<条目 UUID>\`，内容是**原样搬过来**的
//! 主题目录（`theme.json` 仍是相对路径）加一个 `.trash.json` 快照。条目 ID 与
//! 主题 ID 分开：同一主题删两次、或删完又从备份恢复再删，都不会撞目录。
//!
//! 限额：最多保留 [`MAX_TRASH_ENTRIES`] 套或 [`MAX_TRASH_BYTES`]，超出后按删除
//! 时间从最早的开始清理——回收站是安全垫，不是第二份主题库。
//!
//! 跨盘：主题存储目录可以换到别的盘，`rename` 会报 `ERROR_NOT_SAME_DEVICE`；
//! 这时走「复制 → 校验文件数与字节数 → 删源」，复制失败清理半成品、源保持原样。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::CursorTheme;
use crate::utils::{cursor, limits, paths};

/// 条目快照文件名；以点开头，不与主题里的光标文件撞名
const META_FILE: &str = ".trash.json";
const MAX_META_BYTES: u64 = 64 * 1024;
/// 目录深度上限与导入限额同一口径（决策 18）
const MAX_MOVE_DEPTH: usize = 8;

pub const MAX_TRASH_ENTRIES: usize = 20;
pub const MAX_TRASH_BYTES: u64 = 512 * 1024 * 1024;

/// 回收站条目的磁盘快照
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrashMeta {
    /// 回收站条目 ID，同时是目录名
    id: String,
    /// 原主题 ID，恢复时作为主题目录名
    theme_id: String,
    /// 删除时的显示名快照：theme.json 之后损坏了也能说清是哪套
    name: String,
    /// 本地时区 `YYYY-MM-DD HH:MM`
    deleted_at: String,
    slot_count: usize,
    /// 删除时统计的主题目录字节数（不含本快照）
    bytes: u64,
}

/// 回收站列表的一条记录
#[derive(Debug, Serialize)]
pub struct TrashEntry {
    pub id: String,
    pub theme_id: String,
    pub name: String,
    pub deleted_at: String,
    pub slot_count: usize,
    pub bytes: u64,
    /// "ok" | "damaged"
    pub status: String,
    /// damaged 时的中文原因
    pub error: Option<String>,
}

/// `list_trash` 的返回值：条目 + 当前生效的限额
#[derive(Debug, Serialize)]
pub struct TrashListing {
    pub entries: Vec<TrashEntry>,
    pub max_entries: usize,
    pub max_bytes: u64,
}

/// 删除主题的结果：删进回收站本身成功，可能伴随原目录残留与自动清理
#[derive(Debug, Serialize)]
pub struct DeleteOutcome {
    /// 本次因超出上限而被自动清理的旧条目数
    pub auto_purged: usize,
    /// 非致命问题（典型：跨盘复制后原目录没能完全删除）
    pub warning: Option<String>,
}

/// 恢复主题的结果
#[derive(Debug, Serialize)]
pub struct RestoreOutcome {
    pub warning: Option<String>,
}

/// 清空回收站的结果：单个条目删不掉不应该让其余条目也留下
#[derive(Debug, Serialize)]
pub struct EmptyOutcome {
    pub removed: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Default, Clone, Copy)]
struct DirStats {
    files: u64,
    bytes: u64,
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn mtime_string(dir: &Path) -> String {
    fs::metadata(dir)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .map(|time| {
            chrono::DateTime::<chrono::Local>::from(time)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        })
        .unwrap_or_else(|| "未知".to_string())
}

fn canonical_id(raw: &str) -> Result<String, String> {
    let id = Uuid::parse_str(raw).map_err(|_| "非法的回收站条目 ID".to_string())?;
    if id.to_string() != raw {
        return Err("非法的回收站条目 ID".to_string());
    }
    Ok(id.to_string())
}

fn is_canonical_id(raw: &str) -> bool {
    canonical_id(raw).is_ok()
}

fn canonical_theme_id(raw: &str) -> Result<String, String> {
    let id = Uuid::parse_str(raw).map_err(|_| "回收站记录里的主题 ID 不合法".to_string())?;
    if id.to_string() != raw {
        return Err("回收站记录里的主题 ID 不合法".to_string());
    }
    Ok(id.to_string())
}

// ---------------------------------------------------------------------------
// 统计与复制
// ---------------------------------------------------------------------------

fn dir_stats(dir: &Path, depth: usize) -> Result<DirStats, String> {
    if depth > MAX_MOVE_DEPTH {
        return Err("主题目录层级过深，已停止统计".to_string());
    }
    let mut stats = DirStats::default();
    for entry in
        fs::read_dir(dir).map_err(|err| format!("读目录失败（{}：{err}）", dir.display()))?
    {
        let entry = entry.map_err(|err| format!("读取目录项失败（{err}）"))?;
        // 统计只为限额与展示服务：链接 / 目录联接不跟随，避免把外部内容算进来
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|err| format!("读文件信息失败（{err}）"))?;
        if meta.is_dir() {
            let inner = dir_stats(&entry.path(), depth + 1)?;
            stats.files += inner.files;
            stats.bytes += inner.bytes;
        } else if meta.is_file() {
            stats.files += 1;
            stats.bytes += meta.len();
        }
    }
    Ok(stats)
}

/// 跨盘移动的回退：逐文件复制，任何链接 / 目录联接都拒绝，宁可失败也不搬半套
fn copy_dir(from: &Path, to: &Path, depth: usize) -> Result<(), String> {
    if depth > MAX_MOVE_DEPTH {
        return Err("主题目录层级过深，已停止复制".to_string());
    }
    fs::create_dir_all(to).map_err(|err| format!("创建目录失败（{err}）"))?;
    for entry in fs::read_dir(from).map_err(|err| format!("读取目录失败（{err}）"))? {
        let entry = entry.map_err(|err| format!("读取目录项失败（{err}）"))?;
        if limits::is_reparse_entry(&entry) {
            return Err(format!(
                "主题目录里有链接或目录联接（{}），无法安全复制",
                entry.path().display()
            ));
        }
        let kind = entry
            .file_type()
            .map_err(|err| format!("读不到目录项类型（{err}）"))?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &dest, depth + 1)?;
        } else if kind.is_file() {
            let written =
                fs::copy(entry.path(), &dest).map_err(|err| format!("复制文件失败（{err}）"))?;
            let expected = entry
                .metadata()
                .map_err(|err| format!("读不到文件信息（{err}）"))?
                .len();
            if written != expected {
                return Err(format!(
                    "复制文件后校验不一致：{}（写入 {written} 字节，应为 {expected} 字节）",
                    entry.path().display()
                ));
            }
        }
    }
    Ok(())
}

/// Windows `ERROR_NOT_SAME_DEVICE`（17）；Unix `EXDEV`（18）便于本机之外的测试环境
fn is_cross_device(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(17) | Some(18))
}

/// 同盘用 rename（原子）；跨盘复制后校验并删源。
///
/// 返回的 `Some(warning)` 表示目标已就绪、但源目录没能清理干净，调用方要把
/// 这件事告诉用户，不能当作完全成功。
fn move_dir(from: &Path, to: &Path, target_label: &str) -> Result<Option<String>, String> {
    if to.exists() {
        return Err(format!(
            "目标位置已存在同名目录（{}），已取消移动",
            to.display()
        ));
    }

    match fs::rename(from, to) {
        Ok(()) => Ok(None),
        Err(err) if is_cross_device(&err) => {
            let source_stats = dir_stats(from, 0)?;
            if let Err(err) = copy_dir(from, to, 0) {
                let _ = fs::remove_dir_all(to);
                return Err(format!("复制主题目录失败（{err}）；原目录未改动"));
            }
            match dir_stats(to, 0) {
                Ok(copied) if copied.files == source_stats.files && copied.bytes == source_stats.bytes => {}
                Ok(copied) => {
                    let _ = fs::remove_dir_all(to);
                    return Err(format!(
                        "复制后校验不一致（源 {} 个文件 / {} 字节，目标 {} 个文件 / {} 字节），已取消移动",
                        source_stats.files, source_stats.bytes, copied.files, copied.bytes
                    ));
                }
                Err(err) => {
                    let _ = fs::remove_dir_all(to);
                    return Err(format!("复制后校验失败（{err}），已取消移动"));
                }
            }
            match fs::remove_dir_all(from) {
                Ok(()) => Ok(None),
                Err(err) => Ok(Some(format!(
                    "已复制到{target_label}，但原目录没能完全删除（{err}）；残留目录可以手动清理"
                ))),
            }
        }
        Err(err) => Err(format!(
            "移动主题目录失败（{err}）；它可能正被其它程序占用"
        )),
    }
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

fn write_meta(dir: &Path, meta: &TrashMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta)
        .map_err(|err| format!("序列化回收站记录失败（{err}）"))?;
    fs::write(dir.join(META_FILE), json).map_err(|err| format!("写入回收站记录失败（{err}）"))
}

fn read_meta(dir: &Path) -> Result<TrashMeta, String> {
    let raw = limits::read_text_bounded(&dir.join(META_FILE), MAX_META_BYTES)?;
    serde_json::from_str(&raw).map_err(|err| format!("回收站记录不是有效 JSON（{err}）"))
}

/// 恢复前要过的主题信息校验；列表也用它，保证「可恢复」不是嘴上说说
fn validate_theme_json(dir: &Path, theme_id: &str) -> Result<(), String> {
    let raw = limits::read_text_bounded(
        &dir.join("theme.json"),
        limits::MAX_THEME_JSON_BYTES,
    )
    .map_err(|err| format!("主题信息读不出来（{err}）"))?;
    let theme: CursorTheme =
        serde_json::from_str(&raw).map_err(|err| format!("主题信息不是有效 JSON（{err}）"))?;
    if theme.id != theme_id {
        return Err("theme.json 里的主题 ID 与记录不一致".to_string());
    }
    if theme.is_built_in {
        return Err("主题信息自称系统方案".to_string());
    }
    if theme.cursors.is_empty() {
        return Err("主题信息里没有光标槽位".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 移入 / 列出
// ---------------------------------------------------------------------------

/// 把一个用户主题移入回收站（调用方已完成「不是系统方案、不是使用中」的复核）
pub fn move_into_trash(
    theme_id: &str,
    theme_name: &str,
    slot_count: usize,
) -> Result<DeleteOutcome, String> {
    // 命令层已校验；这里再挡一次，避免将来有别的调用点直接拼路径
    let theme_id = canonical_id(theme_id).map_err(|_| "非法的主题 ID".to_string())?;
    let source = paths::theme_dir(&theme_id)?;
    if !source.is_dir() {
        return Err("这个主题已经不在了，可能要重新导入".to_string());
    }
    if limits::is_reparse_path(&source) {
        return Err("主题目录是链接或目录联接，已拒绝删除".to_string());
    }

    let root = paths::trash_dir()?;
    paths::ensure_dir(&root)?;

    let entry_id = Uuid::new_v4().to_string();
    let target = root.join(&entry_id);
    // 体积只用于限额与展示：统计失败（个别文件读不到）不能反过来挡住删除
    let stats = dir_stats(&source, 0).unwrap_or_default();

    let move_warning = move_dir(&source, &target, "回收站")?;
    let meta = TrashMeta {
        id: entry_id,
        theme_id,
        name: theme_name.to_string(),
        deleted_at: now_string(),
        slot_count,
        bytes: stats.bytes,
    };

    if let Err(err) = write_meta(&target, &meta) {
        // 没有快照的条目无法恢复：把主题搬回原处，保证这次删除等于没发生
        return match move_dir(&target, &source, "主题目录") {
            Ok(_) => Err(format!("写入回收站记录失败，已把主题放回原处（{err}）")),
            Err(back_err) => Err(format!(
                "写入回收站记录失败（{err}），主题也没能放回原处（{back_err}）；请检查数据目录"
            )),
        };
    }

    // 预览缓存里可能还抱着刚移走的文件，及时释放
    cursor::invalidate_dir(&source);

    let mut warning = move_warning;
    let auto_purged = enforce_limits(&root, MAX_TRASH_ENTRIES, MAX_TRASH_BYTES, &mut warning);
    Ok(DeleteOutcome {
        auto_purged,
        warning,
    })
}

fn damaged_entry(id: &str, dir: &Path, meta: Option<TrashMeta>, reason: String) -> TrashEntry {
    let stats = dir_stats(dir, 0).unwrap_or_default();
    // 快照里的体积是删除时的读数；没有快照才回退到现场统计
    let bytes = meta.as_ref().map(|meta| meta.bytes).unwrap_or(stats.bytes);
    let name = meta
        .as_ref()
        .map(|meta| meta.name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "损坏的回收站条目".to_string());
    let deleted_at = meta
        .as_ref()
        .map(|meta| meta.deleted_at.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| mtime_string(dir));
    TrashEntry {
        id: id.to_string(),
        theme_id: meta
            .as_ref()
            .map(|meta| meta.theme_id.clone())
            .filter(|value| is_canonical_id(value))
            .unwrap_or_default(),
        name,
        deleted_at,
        slot_count: meta.map(|meta| meta.slot_count).unwrap_or(0),
        bytes,
        status: "damaged".to_string(),
        error: Some(reason),
    }
}

fn read_entry(id: &str, dir: &Path) -> TrashEntry {
    match read_meta(dir) {
        Ok(meta) if meta.id == id && is_canonical_id(&meta.theme_id) => {
            if let Err(err) = validate_theme_json(dir, &meta.theme_id) {
                return damaged_entry(id, dir, Some(meta), err);
            }
            TrashEntry {
                id: id.to_string(),
                theme_id: meta.theme_id,
                name: {
                    let name = meta.name.trim();
                    if name.is_empty() {
                        "未命名主题".to_string()
                    } else {
                        name.to_string()
                    }
                },
                deleted_at: meta.deleted_at,
                slot_count: meta.slot_count,
                bytes: meta.bytes,
                status: "ok".to_string(),
                error: None,
            }
        }
        Ok(meta) => damaged_entry(
            id,
            dir,
            Some(meta),
            "回收站记录与目录不一致，无法恢复".to_string(),
        ),
        Err(err) => damaged_entry(id, dir, None, err),
    }
}

fn list_in(root: &Path) -> Result<Vec<TrashEntry>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(root).map_err(|err| format!("读回收站目录失败（{err}）"))? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                eprintln!("[list_trash] 读取目录项失败，已跳过（{err}）");
                continue;
            }
        };
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        // 只管理自己创建的 UUID 目录；其它目录不是回收站条目，不碰
        if !is_canonical_id(&dir_name) {
            continue;
        }
        entries.push(read_entry(&dir_name, &dir));
    }
    // 删除时间倒序；同分钟按条目 ID 稳定排序
    entries.sort_by(|a, b| {
        b.deleted_at
            .cmp(&a.deleted_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(entries)
}

pub fn list() -> Result<TrashListing, String> {
    Ok(TrashListing {
        entries: list_in(&paths::trash_dir()?)?,
        max_entries: MAX_TRASH_ENTRIES,
        max_bytes: MAX_TRASH_BYTES,
    })
}

// ---------------------------------------------------------------------------
// 恢复 / 彻底删除 / 清空
// ---------------------------------------------------------------------------

fn entry_dir(entry_id: &str) -> Result<PathBuf, String> {
    let id = canonical_id(entry_id)?;
    Ok(paths::trash_dir()?.join(id))
}

/// 从回收站恢复一套主题：重新校验快照、主题信息与目标是否已被占用
pub fn restore(entry_id: &str) -> Result<RestoreOutcome, String> {
    let dir = entry_dir(entry_id)?;
    if !dir.is_dir() {
        return Err("回收站里没有这个条目，可能已被清理".to_string());
    }
    if limits::is_reparse_path(&dir) {
        return Err("回收站条目是链接或目录联接，已拒绝恢复".to_string());
    }

    let meta = read_meta(&dir).map_err(|err| format!("回收站记录已损坏，无法恢复（{err}）"))?;
    if meta.id != canonical_id(entry_id)? {
        return Err("回收站记录与目录不一致，已拒绝恢复".to_string());
    }
    let theme_id = canonical_theme_id(&meta.theme_id)?;

    validate_theme_json(&dir, &theme_id)
        .map_err(|err| format!("{err}，无法恢复"))?;

    let themes_root = paths::themes_dir()?;
    paths::ensure_dir(&themes_root)?;
    let target = themes_root.join(&theme_id);
    if target.exists() {
        return Err(
            "主题目录里已经有同 ID 的主题（可能从备份恢复过），请先处理那一份再恢复"
                .to_string(),
        );
    }

    let mut warning = move_dir(&dir, &target, "主题目录")?;
    // 快照不属于主题内容；删不掉不影响使用，但要说出来
    if let Err(err) = fs::remove_file(target.join(META_FILE)) {
        let note = format!("主题已恢复，但回收站记录文件没能删除（{err}）");
        warning = Some(match warning {
            Some(prev) => format!("{prev}；{note}"),
            None => note,
        });
    }
    cursor::invalidate_dir(&dir);

    Ok(RestoreOutcome { warning })
}

/// 彻底删除一个回收站条目
pub fn purge(entry_id: &str) -> Result<(), String> {
    let dir = entry_dir(entry_id)?;
    if !dir.is_dir() {
        return Err("回收站里没有这个条目，可能已被清理".to_string());
    }
    if limits::is_reparse_path(&dir) {
        return Err("回收站条目是链接或目录联接，已拒绝删除".to_string());
    }
    fs::remove_dir_all(&dir).map_err(|err| format!("彻底删除失败（{err}）；它可能正被其它程序占用"))?;
    cursor::invalidate_dir(&dir);
    Ok(())
}

/// 清空回收站：逐个删，单个失败只记录原因，不影响其余条目
pub fn empty() -> Result<EmptyOutcome, String> {
    let root = paths::trash_dir()?;
    if !root.is_dir() {
        return Ok(EmptyOutcome {
            removed: 0,
            failed: Vec::new(),
        });
    }

    let mut removed = 0;
    let mut failed = Vec::new();
    for entry in fs::read_dir(&root).map_err(|err| format!("读回收站目录失败（{err}）"))? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                failed.push(format!("读取目录项失败（{err}）"));
                continue;
            }
        };
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        if !is_canonical_id(&dir_name) {
            continue;
        }
        match fs::remove_dir_all(&dir) {
            Ok(()) => {
                removed += 1;
                cursor::invalidate_dir(&dir);
            }
            Err(err) => failed.push(format!("{dir_name}：{err}")),
        }
    }

    Ok(EmptyOutcome { removed, failed })
}

// ---------------------------------------------------------------------------
// 限额
// ---------------------------------------------------------------------------

/// 超出条数或字节上限时，从最早删的条目开始清理。
///
/// 返回实际清掉的条数；失败只追加到 `warning`，不让本次删除失败——主题已经
/// 安全落进回收站，自动清理只是回收空间。
fn enforce_limits(
    root: &Path,
    max_entries: usize,
    max_bytes: u64,
    warning: &mut Option<String>,
) -> usize {
    let mut entries = match list_in(root) {
        Ok(entries) => entries,
        Err(err) => {
            append_warning(warning, format!("回收站限额检查失败，暂未自动清理（{err}）"));
            return 0;
        }
    };
    if entries.len() <= max_entries && entries.iter().map(|entry| entry.bytes).sum::<u64>() <= max_bytes
    {
        return 0;
    }

    entries.sort_by(|a, b| a.deleted_at.cmp(&b.deleted_at));
    let mut remaining = entries.len();
    let mut total: u64 = entries.iter().map(|entry| entry.bytes).sum();
    let mut removed = 0;

    for entry in entries {
        if remaining <= max_entries && total <= max_bytes {
            break;
        }
        let path = root.join(&entry.id);
        match fs::remove_dir_all(&path) {
            Ok(()) => {
                remaining -= 1;
                total = total.saturating_sub(entry.bytes);
                removed += 1;
                cursor::invalidate_dir(&path);
            }
            Err(err) => {
                append_warning(
                    warning,
                    format!("自动清理回收站条目「{}」失败（{err}）", entry.name),
                );
            }
        }
    }

    removed
}

fn append_warning(warning: &mut Option<String>, message: String) {
    *warning = Some(match warning.take() {
        Some(prev) => format!("{prev}；{message}"),
        None => message,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CursorSlot;
    use crate::utils::test_support::{fixture_cur, TempDir};

    fn seed_theme(id: &str, name: &str) -> PathBuf {
        let dir = paths::theme_dir(id).expect("解析主题目录");
        fs::create_dir_all(dir.join("cursors")).expect("建主题目录");
        fs::write(dir.join("cursors").join("arrow.cur"), fixture_cur()).expect("写光标文件");
        let theme = CursorTheme {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            created_at: "2026-10-01 10:00".to_string(),
            updated_at: "2026-10-01 10:00".to_string(),
            is_built_in: false,
            cursors: vec![CursorSlot {
                registry_key: "Arrow".to_string(),
                display_name: "正常选择".to_string(),
                english_name: "Normal Select".to_string(),
                file_path: "cursors/arrow.cur".to_string(),
                file_type: "cur".to_string(),
            }],
        };
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).expect("序列化主题"),
        )
        .expect("写 theme.json");
        dir
    }

    fn seed_entry(root: &Path, deleted_at: &str, name: &str, bytes: u64) -> String {
        let id = Uuid::new_v4().to_string();
        let dir = root.join(&id);
        fs::create_dir_all(&dir).expect("建回收站条目");
        let meta = TrashMeta {
            id: id.clone(),
            theme_id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            deleted_at: deleted_at.to_string(),
            slot_count: 1,
            bytes,
        };
        fs::write(
            dir.join(META_FILE),
            serde_json::to_string(&meta).expect("序列化快照"),
        )
        .expect("写快照");
        id
    }

    #[test]
    fn 移入回收站后可以恢复() {
        let root = TempDir::new("trash-roundtrip");
        let _guard = root.isolate_paths();

        let id = Uuid::new_v4().to_string();
        let dir = seed_theme(&id, "回收测试");
        let outcome = move_into_trash(&id, "回收测试", 1).expect("移入回收站");
        assert_eq!(outcome.auto_purged, 0);
        assert!(outcome.warning.is_none());
        assert!(!dir.exists(), "原主题目录应已移走");

        let listing = list().expect("列出回收站");
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "回收测试");
        assert_eq!(listing.entries[0].theme_id, id);
        assert_eq!(listing.entries[0].slot_count, 1);
        assert!(listing.entries[0].bytes > 0);
        assert_eq!(listing.entries[0].status, "ok");

        let restored = restore(&listing.entries[0].id).expect("恢复主题");
        assert!(restored.warning.is_none());
        assert!(dir.join("theme.json").is_file(), "theme.json 应恢复");
        assert!(dir.join("cursors").join("arrow.cur").is_file(), "光标文件应恢复");
        assert!(!dir.join(META_FILE).exists(), "快照不应留在主题目录里");
        assert!(list().expect("再次列出").entries.is_empty(), "恢复后回收站应为空");
    }

    #[test]
    fn 恢复时目标已存在会拒绝且条目保留() {
        let root = TempDir::new("trash-target-exists");
        let _guard = root.isolate_paths();

        let id = Uuid::new_v4().to_string();
        let dir = seed_theme(&id, "同名主题");
        move_into_trash(&id, "同名主题", 1).expect("移入回收站");
        let entry_id = list().expect("列出").entries[0].id.clone();

        fs::create_dir_all(&dir).expect("重建同名目录");
        let err = restore(&entry_id).unwrap_err();
        assert!(err.contains("已经有同 ID"), "实际：{err}");
        assert_eq!(list().expect("条目应保留").entries.len(), 1);
    }

    #[test]
    fn 非法条目_id_不能越出回收站() {
        let root = TempDir::new("trash-bad-id");
        let _guard = root.isolate_paths();

        for bad in ["../evil", "..\\evil", "a/b", "", "not-a-uuid"] {
            let err = restore(bad).unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 恢复应被拒绝，实际：{err}");

            let err = purge(bad).unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 删除应被拒绝，实际：{err}");

            let err = move_into_trash(bad, "坏 ID", 0).unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 移入回收站应被拒绝，实际：{err}");
        }
    }

    #[test]
    fn 快照损坏时仍会列出但拒绝恢复() {
        let root = TempDir::new("trash-damaged");
        let _guard = root.isolate_paths();

        let id = Uuid::new_v4().to_string();
        seed_theme(&id, "会坏掉的快照");
        move_into_trash(&id, "会坏掉的快照", 1).expect("移入回收站");
        let entry_id = list().expect("列出").entries[0].id.clone();

        let entry_dir = paths::trash_dir().expect("回收站目录").join(&entry_id);
        fs::remove_file(entry_dir.join(META_FILE)).expect("删掉快照");

        let listing = list().expect("列出损坏条目");
        assert_eq!(listing.entries.len(), 1, "损坏条目不能从列表里消失");
        assert_eq!(listing.entries[0].status, "damaged");
        assert!(listing.entries[0].error.is_some());

        let err = restore(&entry_id).unwrap_err();
        assert!(err.contains("损坏"), "实际：{err}");
        purge(&entry_id).expect("损坏条目仍可彻底删除");
        assert!(list().expect("列出").entries.is_empty());
    }

    #[test]
    fn 主题信息损坏时标记为不可恢复() {
        let root = TempDir::new("trash-broken-theme");
        let _guard = root.isolate_paths();

        let id = Uuid::new_v4().to_string();
        seed_theme(&id, "主题信息会坏");
        move_into_trash(&id, "主题信息会坏", 1).expect("移入回收站");
        let entry_id = list().expect("列出").entries[0].id.clone();
        let entry_dir = paths::trash_dir().expect("回收站目录").join(&entry_id);
        fs::write(entry_dir.join("theme.json"), "{}").expect("写坏主题信息");

        let listing = list().expect("列出");
        let entry = &listing.entries[0];
        assert_eq!(entry.status, "damaged");
        assert!(
            entry.error.as_deref().is_some_and(|err| err.contains("主题信息")),
            "原因要说清主题信息坏了：{:?}",
            entry.error
        );

        let err = restore(&entry_id).unwrap_err();
        assert!(err.contains("无法恢复"), "实际：{err}");
        purge(&entry_id).expect("坏条目仍可彻底删除");
    }

    #[test]
    fn 超过条数上限自动清理最早的() {
        let root = TempDir::new("trash-limit-count");
        let _guard = root.isolate_paths();
        let trash_root = paths::trash_dir().expect("回收站目录");
        fs::create_dir_all(&trash_root).expect("建回收站");
        let oldest = seed_entry(&trash_root, "2026-10-01 08:00", "最早", 10);
        seed_entry(&trash_root, "2026-10-02 08:00", "中间", 10);
        seed_entry(&trash_root, "2026-10-03 08:00", "最新", 10);

        let mut warning = None;
        let removed = enforce_limits(&trash_root, 2, MAX_TRASH_BYTES, &mut warning);
        assert_eq!(removed, 1);
        assert!(warning.is_none());
        let entries = list_in(&trash_root).expect("列出");
        assert_eq!(entries.len(), 2);
        assert!(
            entries.iter().all(|entry| entry.id != oldest),
            "应清掉最早删的那一条"
        );
    }

    #[test]
    fn 超过体积上限也会清理最早的() {
        let root = TempDir::new("trash-limit-bytes");
        let _guard = root.isolate_paths();
        let trash_root = paths::trash_dir().expect("回收站目录");
        fs::create_dir_all(&trash_root).expect("建回收站");
        seed_entry(&trash_root, "2026-10-01 08:00", "最早", 100);
        seed_entry(&trash_root, "2026-10-02 08:00", "最新", 100);

        let mut warning = None;
        let removed = enforce_limits(&trash_root, MAX_TRASH_ENTRIES, 150, &mut warning);
        assert_eq!(removed, 1);
        let entries = list_in(&trash_root).expect("列出");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "最新");
    }

    #[test]
    fn 回收站只管理规范_uuid_目录() {
        let root = TempDir::new("trash-stray");
        let _guard = root.isolate_paths();
        let trash_root = paths::trash_dir().expect("回收站目录");
        fs::create_dir_all(trash_root.join("not-a-uuid")).expect("建杂项目录");
        let entry_id = seed_entry(&trash_root, "2026-10-01 08:00", "正常条目", 10);

        let entries = list_in(&trash_root).expect("列出");
        assert_eq!(entries.len(), 1, "非 UUID 目录不应被当成回收站条目");
        assert_eq!(entries[0].id, entry_id);

        let outcome = empty().expect("清空");
        assert_eq!(outcome.removed, 1);
        assert!(
            trash_root.join("not-a-uuid").is_dir(),
            "非本应用创建的目录不能删"
        );
    }

    #[test]
    fn 清空回收站会删除全部条目() {
        let root = TempDir::new("trash-empty");
        let _guard = root.isolate_paths();
        let trash_root = paths::trash_dir().expect("回收站目录");
        fs::create_dir_all(&trash_root).expect("建回收站");
        seed_entry(&trash_root, "2026-10-01 08:00", "甲", 10);
        seed_entry(&trash_root, "2026-10-02 08:00", "乙", 10);

        let outcome = empty().expect("清空回收站");
        assert_eq!(outcome.removed, 2);
        assert!(outcome.failed.is_empty());
        assert!(list().expect("列出").entries.is_empty());
    }
}
