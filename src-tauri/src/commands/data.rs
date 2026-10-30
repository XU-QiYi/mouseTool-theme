//! 数据目录相关命令
//!
//! 「打开数据目录」是设置模块的锚点：备份、清理、报障自查都从这里出发。
//! 目录的唯一来源是 `utils/paths.rs::data_root()`，这里只做「取出路径 + 打开」，
//! 不做任何额外的路径拼接（硬约束 1）。
//!
//! 「存储占用统计」与「清空使用记录」（决策 34）也在这里：都是数据管理面板
//! 的只读 / 轻量维护动作，不碰主题与注册表。

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri_plugin_opener::open_path;

use crate::utils::{history, limits, log, paths};

/// 数据目录的展示路径（`%LOCALAPPDATA%\CursorStudio`）
///
/// 只读不落盘：目录还不存在（一次都没导入过）也照实返回，
/// 「打开」这一步才负责创建。纯路径计算，不占后台线程。
#[tauri::command]
pub fn get_data_dir() -> Result<String, String> {
    Ok(paths::data_root()?.to_string_lossy().into_owned())
}

/// 在系统文件管理器中打开数据目录，返回实际打开的路径
///
/// 目录不存在就先创建：设置页是用户排查数据问题的入口，
/// 打开一个空目录远比「打开失败：路径不存在」有用。
#[tauri::command]
pub async fn open_data_dir() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = paths::data_root()?;
        paths::ensure_dir(&dir)?;
        open_path(&dir, None::<&str>).map_err(|err| format!("打开数据目录失败（{err}）"))?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| format!("打开数据目录任务异常退出（{err}）"))?
}

/// 打开日志目录（决策 46）：排障时让用户直接把 `logs\mousetool.log` 发上来
#[tauri::command]
pub async fn open_log_dir() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = log::log_dir()?;
        paths::ensure_dir(&dir)?;
        open_path(&dir, None::<&str>).map_err(|err| format!("打开日志目录失败（{err}）"))?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| format!("打开日志目录任务异常退出（{err}）"))?
}

// ---------------------------------------------------------------------------
// 存储占用统计（决策 34）
// ---------------------------------------------------------------------------

/// 一块区域的占用：条目数与字节数
#[derive(Debug, Default, Serialize)]
pub struct StorageDirStats {
    /// 条目数：主题 = 含 theme.json 的一级子目录；备份 = `.zip` 数；
    /// 回收站 = 含 `.trash.json` 的回收站条目（决策 26 的目录口径）
    pub count: usize,
    /// 区域内全部文件字节（孤儿文件也算进去——总占用要能对上磁盘）
    pub bytes: u64,
}

/// 数据目录各区域的磁盘占用（只读统计，不做任何清理）
#[derive(Debug, Default, Serialize)]
pub struct StorageStats {
    pub themes: StorageDirStats,
    pub backups: StorageDirStats,
    pub trash: StorageDirStats,
    pub history_bytes: u64,
    pub settings_bytes: u64,
    /// 各区域之和；主题库设在数据目录外时同样计入
    pub total_bytes: u64,
}

/// 递归统计目录字节：链接 / 目录联接不进入，深度封顶防异常嵌套
///
/// 读不了的条目按 0 计——统计是给用户看的概数，一颗读不到的文件不值得让它整页报错。
fn dir_bytes(dir: &Path, depth: usize) -> u64 {
    if depth > 16 {
        return 0;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.is_dir() {
            total += dir_bytes(&entry.path(), depth + 1);
        } else if meta.is_file() {
            total += meta.len();
        }
    }
    total
}

/// 一级子目录里认得「本应用条目」的计数口径 + 全部字节数
fn child_dir_stats(dir: &Path, marker: &str) -> StorageDirStats {
    let mut stats = StorageDirStats::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return stats;
    };
    for entry in entries.flatten() {
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join(marker).is_file() {
            stats.count += 1;
        }
        stats.bytes += dir_bytes(&path, 0);
    }
    stats
}

fn backup_stats(backups_dir: &Path) -> StorageDirStats {
    let mut stats = StorageDirStats::default();
    let Ok(entries) = fs::read_dir(backups_dir) else {
        return stats;
    };
    for entry in entries.flatten() {
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            // 正常不会有子目录；真有也只计字节，不冒充备份数
            stats.bytes += dir_bytes(&path, 0);
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                if entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".zip")
                {
                    stats.count += 1;
                }
                stats.bytes += meta.len();
            }
        }
    }
    stats
}

/// 显式路径版统计（测试用临时数据根）
fn storage_stats_in(data_root: &Path, themes_dir: &Path) -> StorageStats {
    let themes = child_dir_stats(themes_dir, "theme.json");
    let trash = child_dir_stats(&data_root.join("trash"), ".trash.json");
    let backups = backup_stats(&data_root.join("backups"));
    let file_bytes = |path: &Path| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let history_bytes = file_bytes(&data_root.join("history.json"));
    let settings_bytes = file_bytes(&data_root.join("settings.json"));
    let total_bytes =
        themes.bytes + backups.bytes + trash.bytes + history_bytes + settings_bytes;
    StorageStats {
        themes,
        backups,
        trash,
        history_bytes,
        settings_bytes,
        total_bytes,
    }
}

/// 数据目录各区域的磁盘占用（决策 34）
///
/// 纯只读：不建目录、不取重操作锁、不做任何清理——统计期间别的操作照常跑。
/// 主题库可能设在数据目录外（`settings.json` 的 `themes_dir`），同样计入。
#[tauri::command]
pub async fn get_storage_stats() -> Result<StorageStats, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let data_root = paths::data_root()?;
        Ok(storage_stats_in(&data_root, &paths::themes_dir()?))
    })
    .await
    .map_err(|err| format!("统计存储占用任务异常退出（{err}）"))?
}

// ---------------------------------------------------------------------------
// 清空使用记录（决策 34）
// ---------------------------------------------------------------------------

/// 清空最近使用记录，返回清掉的条数
///
/// 轻量单文件重写（原子写口径见 `history::write_to`），不走重操作互斥锁：
/// 历史文件与主题、注册表互不牵连，没必要把导入 / 备份一起挡住。
#[tauri::command]
pub async fn clear_history() -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(|| history::clear(&paths::history_file()?))
        .await
        .map_err(|err| format!("清空使用记录任务异常退出（{err}）"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_support::TempDir;

    #[test]
    fn 数据目录命令返回根目录路径() {
        let root = TempDir::new("data-dir");
        let data = root.join("data");
        let _guard = paths::use_test_roots(data.clone(), data.join("themes"));

        let dir = get_data_dir().expect("读取数据目录路径不应失败");
        assert_eq!(dir, data.to_string_lossy(), "应返回隔离后的数据根目录");
    }

    #[test]
    fn 存储统计分区域累计字节与条目() {
        let root = TempDir::new("storage-stats");
        let data = root.join("data");
        let themes = data.join("themes");
        let _guard = paths::use_test_roots(data.clone(), themes.clone());

        // 完整主题：theme.json + cursors\arrow.cur（两层都计）
        let theme_dir = themes.join("11111111-1111-1111-1111-111111111111");
        fs::create_dir_all(theme_dir.join("cursors")).expect("建主题目录");
        fs::write(theme_dir.join("theme.json"), "12345").expect("写 theme.json");
        fs::write(theme_dir.join("cursors").join("arrow.cur"), "1234567").expect("写光标");
        // 没有 theme.json 的目录：不冒充主题数，但字节照算
        let stray = themes.join("孤儿目录");
        fs::create_dir_all(&stray).expect("建目录");
        fs::write(stray.join("x.tmp"), "1234").expect("写文件");

        fs::create_dir_all(data.join("backups")).expect("建备份目录");
        fs::write(data.join("backups").join("a.zip"), "1234567890").expect("写备份");
        fs::write(data.join("backups").join("notes.txt"), "12").expect("写杂项");

        let entry = data.join("trash").join("33333333-3333-3333-3333-333333333333");
        fs::create_dir_all(&entry).expect("建回收站条目");
        fs::write(entry.join(".trash.json"), "123").expect("写快照");
        fs::write(entry.join("f"), "12345").expect("写文件");

        fs::write(data.join("history.json"), "123456789").expect("写历史");
        fs::write(data.join("settings.json"), "12345").expect("写设置");

        let stats = storage_stats_in(&data, &themes);
        assert_eq!(stats.themes.count, 1, "只有带 theme.json 的目录算主题");
        assert_eq!(stats.themes.bytes, 16, "主题字节 = 5 + 7 + 孤儿目录 4");
        assert_eq!(stats.backups.count, 1, "只有 .zip 算备份数");
        assert_eq!(stats.backups.bytes, 12, "备份字节含非 zip 杂项");
        assert_eq!(stats.trash.count, 1);
        assert_eq!(stats.trash.bytes, 8);
        assert_eq!(stats.history_bytes, 9);
        assert_eq!(stats.settings_bytes, 5);
        assert_eq!(stats.total_bytes, 16 + 12 + 8 + 9 + 5, "总和 = 各区域之和");
    }

    #[test]
    fn 存储统计对不存在的目录返回零() {
        let root = TempDir::new("storage-stats-empty");
        let data = root.join("data");
        let _guard = paths::use_test_roots(data.clone(), data.join("themes"));

        let stats = storage_stats_in(&data, &data.join("themes"));
        assert_eq!(stats.themes.count, 0);
        assert_eq!(stats.total_bytes, 0, "一次都没用过时全部为零，不算错误");
    }
}
