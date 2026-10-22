//! 「最近使用」历史
//!
//! 独立的一个小 JSON，不塞进 `theme.json`：历史描述的是「界面上点过什么」，
//! 同一份记录横跨所有主题，跟着某个主题走会随删除一起消失。
//!
//! 读写都按「附属信息」对待：文件缺失或损坏只降级为提示，绝不阻断主题列表。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::models::theme::{CursorTheme, HistoryEntry};
use crate::utils::paths;

/// 最多保留多少条：这是「最近」清单，不是流水账，无限增长没有意义
const MAX_ENTRIES: usize = 50;
/// 文件格式版本，将来改结构时用来判断还能不能读
const VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct HistoryFile {
    version: u32,
    entries: Vec<HistoryEntry>,
}

/// 本地时区、分钟精度：界面上只需要「哪天几点用的」
fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// 从指定文件读取历史
///
/// - 文件不存在 = 第一次用，返回空且不算问题；
/// - 文件损坏 = 返回空 + 一条警告，让界面能说明「记录读不出来」，
///   而不是把一个附属文件的错误升级成整页失败。
pub fn read_from(path: &Path) -> (Vec<HistoryEntry>, Vec<String>) {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return (Vec::new(), Vec::new()),
        Err(err) => return (Vec::new(), vec![format!("读不到最近使用记录（{err}）")]),
    };

    match serde_json::from_str::<HistoryFile>(&raw) {
        Ok(file) if file.version == VERSION => (file.entries, Vec::new()),
        Ok(file) => (
            Vec::new(),
            vec![format!("最近使用记录的版本不认识（{}），已忽略", file.version)],
        ),
        Err(err) => (
            Vec::new(),
            vec![format!("最近使用记录已损坏，已忽略（{err}）")],
        ),
    }
}

/// 记一次「使用了这个主题」，返回更新后的历史（最新在前）
///
/// 同一主题只保留一条：重复应用是「又用了一次」，不该堆出一排重复项。
pub fn record_to(path: &Path, theme: &CursorTheme) -> Result<Vec<HistoryEntry>, String> {
    let (mut entries, _) = read_from(path);

    entries.retain(|entry| entry.theme_id != theme.id);
    entries.insert(
        0,
        HistoryEntry {
            theme_id: theme.id.clone(),
            name: theme.name.clone(),
            is_built_in: theme.is_built_in,
            applied_at: now(),
        },
    );
    entries.truncate(MAX_ENTRIES);

    write_to(path, &entries)?;
    Ok(entries)
}

/// 原子写：先写临时文件再改名，避免写到一半断电留下半个 JSON
fn write_to(path: &Path, entries: &[HistoryEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        paths::ensure_dir(parent)?;
    }

    let payload = serde_json::to_string_pretty(&HistoryFile {
        version: VERSION,
        entries: entries.to_vec(),
    })
    .map_err(|err| format!("整理最近使用记录失败（{err}）"))?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, payload).map_err(|err| format!("写入最近使用记录失败（{err}）"))?;
    fs::rename(&tmp, path).map_err(|err| {
        // 改名失败别把临时文件留在磁盘上
        let _ = fs::remove_file(&tmp);
        format!("保存最近使用记录失败（{err}）")
    })
}

/// 默认位置（`%LOCALAPPDATA%\CursorStudio\history.json`）
pub fn read_history() -> (Vec<HistoryEntry>, Vec<String>) {
    read_from(&paths::history_file())
}

/// 解析备份包里的 `history.json`（格式与主文件相同）
pub fn parse_entries(raw: &str) -> Result<Vec<HistoryEntry>, String> {
    serde_json::from_str::<HistoryFile>(raw)
        .map(|file| file.entries)
        .map_err(|err| format!("备份里的最近使用记录读不出来（{err}）"))
}

/// 把备份里的记录并进指定文件：**本地优先**，只补回本地没有的主题记录
///
/// 返回补回条数。合并而非覆盖——恢复备份不该顺手抹掉用户之后的新记录。
pub fn merge_into(path: &Path, incoming: &[HistoryEntry]) -> Result<usize, String> {
    let (mut entries, _) = read_from(path);
    let mut added = 0usize;
    for entry in incoming {
        if entries.iter().any(|e| e.theme_id == entry.theme_id) {
            continue;
        }
        entries.push(entry.clone());
        added += 1;
    }
    if added > 0 {
        // 「最新在前」的口径：备份条目带时间戳，按字符串比较即时间序
        entries.sort_by(|a, b| b.applied_at.cmp(&a.applied_at));
        entries.truncate(MAX_ENTRIES);
        write_to(path, &entries)?;
    }
    Ok(added)
}

/// 记到默认位置
pub fn record(theme: &CursorTheme) -> Result<Vec<HistoryEntry>, String> {
    record_to(&paths::history_file(), theme)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("cursorstudio-history-{name}.json"))
    }

    fn theme(id: &str, name: &str) -> CursorTheme {
        CursorTheme {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            is_built_in: false,
            cursors: Vec::new(),
        }
    }

    #[test]
    fn 没有记录文件时返回空且不报警() {
        let path = temp_path("missing");
        let _ = fs::remove_file(&path);

        let (entries, warnings) = read_from(&path);
        assert!(entries.is_empty());
        assert!(warnings.is_empty(), "第一次用不该报警：{warnings:?}");
    }

    #[test]
    fn 记录损坏时只降级为警告() {
        let path = temp_path("broken");
        fs::write(&path, "{ 这不是 json").expect("写坏文件");

        let (entries, warnings) = read_from(&path);
        assert!(entries.is_empty());
        assert_eq!(warnings.len(), 1, "应给出一条可展示的警告");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 重复应用同一主题只留一条并排到最前() {
        let path = temp_path("dedupe");
        let _ = fs::remove_file(&path);

        record_to(&path, &theme("a", "A")).expect("记 A");
        record_to(&path, &theme("b", "B")).expect("记 B");
        let entries = record_to(&path, &theme("a", "A")).expect("再记 A");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].theme_id, "a");
        assert_eq!(entries[1].theme_id, "b");
        // 返回值必须与落盘结果一致，否则界面与下次启动会不一致
        assert_eq!(read_from(&path).0.len(), 2);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 最多保留五十条且新的在前() {
        let path = temp_path("cap");
        let _ = fs::remove_file(&path);

        for i in 0..60 {
            record_to(&path, &theme(&format!("t{i}"), "T")).expect("记录");
        }

        let entries = read_from(&path).0;
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].theme_id, "t59", "最新的应排在最前");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 目录不存在时会自动创建() {
        let dir = std::env::temp_dir().join("cursorstudio-history-dir");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("history.json");

        record_to(&path, &theme("x", "X")).expect("应自动建目录");
        assert!(path.exists());
        fs::remove_dir_all(&dir).ok();
    }
}
