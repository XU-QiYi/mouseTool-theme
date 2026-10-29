//! 历史记录：**事件流**存储，**最近主题**派生
//!
//! 两种语义必须分清：
//! - **事件流**：每次应用主题追加一条，不合并。它回答「什么时候用过什么」，
//!   同一天反复切同一套主题也应当留下痕迹；
//! - **最近主题**：从事件流按 `theme_id` 取最新一条（最多 50 个），给界面时间轴用。
//!
//! `history.json` 存事件流（v2），磁盘上限 200 条；界面拿到的 `recent` 永远是
//! 派生后的「最近主题」，两者不要混用。v1 的旧文件（按主题去重的清单）仍能读：
//! 每条旧记录当作一条事件，下次写入时升级为 v2。
//!
//! 读写都按「附属信息」对待：文件缺失或损坏只降级为提示，绝不阻断主题列表。

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::models::theme::{CursorTheme, HistoryEntry};
use crate::utils::{limits, paths};

/// 事件流最多保留多少条：这是历史，不是无限日志
const MAX_EVENTS: usize = 200;
/// 「最近主题」最多展示多少个（按主题去重后）
const MAX_RECENT_THEMES: usize = 50;
/// 当前文件格式版本
const VERSION: u32 = 2;
/// 能兼容读取的最旧版本（v1 = 按主题去重的旧清单）
const OLDEST_VERSION: u32 = 1;

/// v2：事件流
#[derive(Debug, Serialize, Deserialize)]
struct HistoryFile {
    version: u32,
    events: Vec<HistoryEntry>,
}

/// v1：按主题去重的旧清单（只用于兼容读取）
#[derive(Debug, Deserialize)]
struct LegacyHistoryFile {
    entries: Vec<HistoryEntry>,
}

#[derive(Debug, Deserialize)]
struct VersionProbe {
    version: u32,
}

/// 读取事件流的结果
pub struct EventsRead {
    /// 最新在前
    pub events: Vec<HistoryEntry>,
    pub warnings: Vec<String>,
    /// 文件版本高于当前支持时不可写：否则会把新版本的数据覆盖掉
    pub writable: bool,
}

impl EventsRead {
    fn empty() -> Self {
        Self {
            events: Vec::new(),
            warnings: Vec::new(),
            writable: true,
        }
    }
}

/// 本地时区、分钟精度：界面上只需要「哪天几点用的」
fn now() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn newest_first(events: &mut Vec<HistoryEntry>) {
    // 稳定排序：同一分钟内的多次应用保持写入时的先后
    events.sort_by(|a, b| b.applied_at.cmp(&a.applied_at));
    events.truncate(MAX_EVENTS);
}

fn parse_v1(entries: Vec<HistoryEntry>) -> Vec<HistoryEntry> {
    let mut events = entries;
    newest_first(&mut events);
    events
}

fn parse_v2(events: Vec<HistoryEntry>) -> Vec<HistoryEntry> {
    let mut events = events;
    newest_first(&mut events);
    events
}

/// 从指定文件读取事件流
///
/// - 文件不存在 = 第一次用，返回空且不算问题；
/// - v1 = 旧版按主题去重的清单，逐条当作事件兼容读入；
/// - 更高版本 = 不认识，忽略内容且**拒绝写入**，避免覆盖新版本的数据；
/// - 文件损坏 = 返回空 + 一条警告，下一次记录会重建文件。
pub fn read_events_from(path: &Path) -> EventsRead {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return EventsRead::empty(),
        Err(err) => {
            let mut read = EventsRead::empty();
            read.warnings
                .push(format!("读不到最近使用记录（{err}）"));
            // 读不出来时别急着覆盖：可能是文件被占用，原数据也许还在
            read.writable = false;
            return read;
        }
    };
    let size = match file.metadata() {
        Ok(meta) => meta.len(),
        Err(err) => {
            let mut read = EventsRead::empty();
            read.warnings
                .push(format!("读不到最近使用记录的信息（{err}）"));
            read.writable = false;
            return read;
        }
    };
    drop(file);
    if size > limits::MAX_STATE_FILE_BYTES {
        // 正常写入上限只有 200 条事件；超过 512KB 基本是坏文件 / 被塞了别的东西
        let mut read = EventsRead::empty();
        read.warnings.push(format!(
            "最近使用记录超过 {}KB 上限，已忽略并准备重建",
            limits::MAX_STATE_FILE_BYTES / 1024
        ));
        return read;
    }

    let raw = match limits::read_text_bounded(path, limits::MAX_STATE_FILE_BYTES) {
        Ok(raw) => raw,
        Err(err) => {
            let mut read = EventsRead::empty();
            read.warnings
                .push(format!("最近使用记录无法读取，已忽略（{err}）"));
            return read;
        }
    };

    let probe = match serde_json::from_str::<VersionProbe>(&raw) {
        Ok(probe) => probe,
        Err(err) => {
            let mut read = EventsRead::empty();
            read.warnings
                .push(format!("最近使用记录已损坏，已忽略（{err}）"));
            return read;
        }
    };

    match probe.version {
        VERSION => match serde_json::from_str::<HistoryFile>(&raw) {
            Ok(file) => EventsRead {
                events: parse_v2(file.events),
                warnings: Vec::new(),
                writable: true,
            },
            Err(err) => {
                let mut read = EventsRead::empty();
                read.warnings
                    .push(format!("最近使用记录已损坏，已忽略（{err}）"));
                read
            }
        },
        OLDEST_VERSION => match serde_json::from_str::<LegacyHistoryFile>(&raw) {
            Ok(file) => EventsRead {
                events: parse_v1(file.entries),
                warnings: Vec::new(),
                writable: true,
            },
            Err(err) => {
                let mut read = EventsRead::empty();
                read.warnings
                    .push(format!("旧版最近使用记录已损坏，已忽略（{err}）"));
                read
            }
        },
        other => EventsRead {
            events: Vec::new(),
            warnings: vec![format!(
                "最近使用记录的版本 {other} 高于当前支持的 {VERSION}，已忽略；请升级应用后再写入记录"
            )],
            writable: false,
        },
    }
}

/// 从事件流派生「最近主题」：同一主题只留最新一条，最多 50 个
///
/// 事件流本身不去重；界面要的是「上次用的是哪个」，所以在这里收口。
pub fn recent_from_events(events: &[HistoryEntry]) -> Vec<HistoryEntry> {
    let mut seen: HashSet<&str> = HashSet::new();
    events
        .iter()
        .filter(|entry| seen.insert(entry.theme_id.as_str()))
        .take(MAX_RECENT_THEMES)
        .cloned()
        .collect()
}

/// 记一次「使用了这个主题」：事件流追加一条，返回派生后的最近主题
pub fn record_to(path: &Path, theme: &CursorTheme) -> Result<Vec<HistoryEntry>, String> {
    let read = read_events_from(path);
    if !read.writable {
        let reason = read
            .warnings
            .first()
            .cloned()
            .unwrap_or_else(|| "记录文件暂不可写".to_string());
        return Err(format!("没有写入最近使用记录（{reason}）"));
    }

    let mut events = read.events;
    events.insert(
        0,
        HistoryEntry {
            theme_id: theme.id.clone(),
            name: theme.name.clone(),
            is_built_in: theme.is_built_in,
            applied_at: now(),
        },
    );
    events.truncate(MAX_EVENTS);

    write_to(path, &events)?;
    Ok(recent_from_events(&events))
}

/// 原子写：先写临时文件再改名，避免写到一半断电留下半个 JSON
fn write_to(path: &Path, events: &[HistoryEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        paths::ensure_dir(parent)?;
    }

    let payload = serde_json::to_string_pretty(&HistoryFile {
        version: VERSION,
        events: events.to_vec(),
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

/// 默认位置的事件流 → 派生的最近主题 + 警告
pub fn read_history() -> (Vec<HistoryEntry>, Vec<String>) {
    let path = match paths::history_file() {
        Ok(path) => path,
        Err(err) => return (Vec::new(), vec![err]),
    };
    let read = read_events_from(&path);
    (recent_from_events(&read.events), read.warnings)
}

/// 解析备份包里的 `history.json`（v1 / v2 都认），返回事件流
pub fn parse_events(raw: &str) -> Result<Vec<HistoryEntry>, String> {
    let probe: VersionProbe = serde_json::from_str(raw)
        .map_err(|err| format!("备份里的最近使用记录读不出来（{err}）"))?;
    match probe.version {
        VERSION => serde_json::from_str::<HistoryFile>(raw)
            .map(|file| parse_v2(file.events))
            .map_err(|err| format!("备份里的最近使用记录读不出来（{err}）")),
        OLDEST_VERSION => serde_json::from_str::<LegacyHistoryFile>(raw)
            .map(|file| parse_v1(file.entries))
            .map_err(|err| format!("备份里的旧版最近使用记录读不出来（{err}）")),
        other => Err(format!(
            "备份里的使用记录版本 {other} 不认识（当前支持 {OLDEST_VERSION}–{VERSION}）"
        )),
    }
}

/// 把备份里的事件并进指定文件：按「主题 + 时间」去重，只补回本地没有的事件
///
/// 返回补回条数。合并而非覆盖——恢复备份不该顺手抹掉用户之后的新记录。
/// 旧版按主题去重的语义已经废弃：同一主题在不同时间的使用是不同事件。
pub fn merge_into(path: &Path, incoming: &[HistoryEntry]) -> Result<usize, String> {
    let read = read_events_from(path);
    if !read.writable {
        let reason = read
            .warnings
            .first()
            .cloned()
            .unwrap_or_else(|| "记录文件暂不可写".to_string());
        return Err(format!("没有合并最近使用记录（{reason}）"));
    }

    let mut events = read.events;
    let mut seen: HashSet<(String, String)> = events
        .iter()
        .map(|entry| (entry.theme_id.clone(), entry.applied_at.clone()))
        .collect();

    let mut added = 0usize;
    for entry in incoming {
        if seen.insert((entry.theme_id.clone(), entry.applied_at.clone())) {
            events.push(entry.clone());
            added += 1;
        }
    }
    if added > 0 {
        newest_first(&mut events);
        write_to(path, &events)?;
    }
    Ok(added)
}

/// 记到默认位置
pub fn record(theme: &CursorTheme) -> Result<Vec<HistoryEntry>, String> {
    record_to(&paths::history_file()?, theme)
}

/// 清空事件流：返回清掉的条数（决策 34）
///
/// 文件本来就不存在时直接返回 0，不凭空创建——「清空」不该是一次写入。
/// 只降级为只读的记录文件（版本过高 / 损坏）不允许清空覆盖原文件。
pub fn clear(path: &Path) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    let read = read_events_from(path);
    if !read.writable {
        let reason = read
            .warnings
            .first()
            .cloned()
            .unwrap_or_else(|| "记录文件暂不可写".to_string());
        return Err(format!("没有清空最近使用记录（{reason}）"));
    }
    let count = read.events.len();
    write_to(path, &[])?;
    Ok(count)
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

    fn event(id: &str, at: &str) -> HistoryEntry {
        HistoryEntry {
            theme_id: id.to_string(),
            name: id.to_string(),
            is_built_in: false,
            applied_at: at.to_string(),
        }
    }

    #[test]
    fn 没有记录文件时返回空且不报警() {
        let path = temp_path("missing");
        let _ = fs::remove_file(&path);

        let read = read_events_from(&path);
        assert!(read.events.is_empty());
        assert!(read.warnings.is_empty(), "第一次用不该报警：{:?}", read.warnings);
        assert!(read.writable);
    }

    #[test]
    fn 记录损坏时只降级为警告() {
        let path = temp_path("broken");
        fs::write(&path, "{ 这不是 json").expect("写坏文件");

        let read = read_events_from(&path);
        assert!(read.events.is_empty());
        assert_eq!(read.warnings.len(), 1, "应给出一条可展示的警告");
        assert!(read.writable, "损坏文件允许下一次记录重建");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 事件流每次都追加而不是按主题去重() {
        let path = temp_path("events");
        let _ = fs::remove_file(&path);

        record_to(&path, &theme("a", "A")).expect("记 A");
        record_to(&path, &theme("b", "B")).expect("记 B");
        let recent = record_to(&path, &theme("a", "A")).expect("再记 A");

        let events = read_events_from(&path).events;
        assert_eq!(events.len(), 3, "同一主题应用三次就是三条事件");
        assert_eq!(events[0].theme_id, "a", "最新事件在最前");

        // 界面要的「最近主题」仍然去重：A 只出现一次且在最前
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].theme_id, "a");
        assert_eq!(recent[1].theme_id, "b");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 事件流有上限且最近主题另有上限() {
        let path = temp_path("cap");
        let _ = fs::remove_file(&path);

        for i in 0..(MAX_EVENTS + 10) {
            record_to(&path, &theme(&format!("t{i}"), "T")).expect("记录");
        }

        let events = read_events_from(&path).events;
        assert_eq!(events.len(), MAX_EVENTS, "事件流不能无限增长");
        assert_eq!(events[0].theme_id, format!("t{}", MAX_EVENTS + 9));

        // 最近主题按主题去重后最多 50 个
        let many = (0..(MAX_RECENT_THEMES + 5))
            .map(|i| event(&format!("x{i}"), "2026-10-25 12:00"))
            .collect::<Vec<_>>();
        assert_eq!(recent_from_events(&many).len(), MAX_RECENT_THEMES);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn v1_旧清单按事件兼容读入() {
        let path = temp_path("legacy");
        let raw = serde_json::json!({
            "version": 1,
            "entries": [
                { "theme_id": "b", "name": "B", "is_built_in": false, "applied_at": "2026-10-24 09:00" },
                { "theme_id": "a", "name": "A", "is_built_in": false, "applied_at": "2026-10-25 10:00" }
            ]
        });
        fs::write(&path, raw.to_string()).expect("写 v1 文件");

        let read = read_events_from(&path);
        assert!(read.warnings.is_empty(), "旧版本是正常升级，不该报警");
        assert_eq!(read.events.len(), 2);
        assert_eq!(read.events[0].theme_id, "a", "读入后仍按时间最新在前");

        // 再记一次会写成 v2，旧记录不丢
        record_to(&path, &theme("c", "C")).expect("记录");
        let raw = fs::read_to_string(&path).expect("读回");
        assert!(raw.contains("\"version\": 2"), "下一次写入应升级格式");
        assert!(raw.contains("\"events\""), "v2 使用 events 字段");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 超过上限的记录文件按损坏处理并允许重建() {
        let path = temp_path("oversized");
        fs::write(
            &path,
            "x".repeat(limits::MAX_STATE_FILE_BYTES as usize + 1),
        )
        .expect("写超大记录");

        let read = read_events_from(&path);
        assert!(read.events.is_empty());
        assert!(read.writable, "超限文件应允许下一次记录重建");
        assert!(
            read.warnings[0].contains("上限"),
            "警告要说明尺寸超限：{:?}",
            read.warnings
        );

        let recent = record_to(&path, &theme("a", "A")).expect("重建应成功");
        assert_eq!(recent.len(), 1);
        assert!(fs::read_to_string(&path)
            .expect("读回")
            .contains("\"version\": 2"));
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 更高版本只读不写防止覆盖() {
        let path = temp_path("future");
        fs::write(&path, r#"{"version": 99, "events": []}"#).expect("写未来版本");

        let read = read_events_from(&path);
        assert!(read.events.is_empty());
        assert!(!read.writable, "不认识的新版本不能被覆盖");
        assert_eq!(read.warnings.len(), 1);

        let err = record_to(&path, &theme("a", "A")).unwrap_err();
        assert!(err.contains("没有写入"), "实际：{err}");
        assert!(
            fs::read_to_string(&path).expect("原文件应保留").contains("\"version\": 99"),
            "拒绝写入时必须保住原文件"
        );
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

    #[test]
    fn 合并按事件去重并保留本地更新记录() {
        let path = temp_path("merge");
        let _ = fs::remove_file(&path);

        let local = event("local", "2026-10-25 12:00");
        fs::write(
            &path,
            serde_json::json!({ "version": 2, "events": [local.clone()] }).to_string(),
        )
        .expect("写本地事件");
        let older = event("local", "2026-10-20 08:00");
        let same = event("other", "2026-10-21 09:00");

        let added = merge_into(&path, &[local.clone(), older.clone(), same.clone()]).expect("合并");
        assert_eq!(added, 2, "同主题不同时间是不同事件，只跳过完全相同的");
        assert_eq!(merge_into(&path, &[older, same]).expect("重复合并"), 0);

        let events = read_events_from(&path).events;
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].applied_at, "2026-10-25 12:00", "最新的本地事件仍在最前");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 备份里的历史支持两种版本() {
        let v2 = r#"{"version":2,"events":[{"theme_id":"a","name":"A","is_built_in":false,"applied_at":"2026-10-25 10:00"}]}"#;
        assert_eq!(parse_events(v2).expect("v2").len(), 1);

        let v1 = r#"{"version":1,"entries":[{"theme_id":"b","name":"B","is_built_in":false,"applied_at":"2026-10-24 09:00"}]}"#;
        assert_eq!(parse_events(v1).expect("v1").len(), 1);

        let future = r#"{"version":99,"events":[]}"#;
        assert!(parse_events(future).unwrap_err().contains("不认识"));
    }

    #[test]
    fn 清空事件流并返回条数() {
        let path = temp_path("clear-events");
        let _ = fs::remove_file(&path);

        record_to(&path, &theme("a", "A")).expect("写入第一条");
        record_to(&path, &theme("b", "B")).expect("写入第二条");

        let cleared = clear(&path).expect("清空不应失败");
        assert_eq!(cleared, 2, "返回清掉的条数");
        let read = read_events_from(&path);
        assert!(read.events.is_empty(), "清空后事件流应为空");
        assert!(read.writable, "清空后的文件仍可写");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn 清空不存在的记录文件不创建文件() {
        let path = temp_path("clear-missing");
        let _ = fs::remove_file(&path);

        let cleared = clear(&path).expect("文件不存在时清空不算失败");
        assert_eq!(cleared, 0);
        assert!(!path.exists(), "不应凭空创建 history.json");
    }
}
