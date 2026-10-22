//! 数据备份：整包导出 / 合并恢复
//!
//! 备份内容 = 用户主题（`themes/**`）+ 最近使用记录（`history.json`）。
//! 恢复是**合并**语义：本地已有的主题保留（同 id 整套跳过），只补回缺失的
//! 完整主题（含 theme.json）；记录本地优先、按主题去重补回。不覆盖不删除——
//! 恢复备份不该抹掉用户之后的改动，这是「备份」锚点（决策 11）的安全底线。
//!
//! 核心函数都收显式路径（`*_to` / `*_from`），命令层才绑定真实数据目录，
//! 测试全程用临时目录，不碰用户数据。

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use uuid::Uuid;

use crate::utils::{history, paths};

/// 导出结果
#[derive(Debug, Serialize)]
pub struct ExportBackupSummary {
    /// 打包的主题数
    pub themes: usize,
    /// 打包的文件数（含 history.json）
    pub files: usize,
}

/// 恢复结果
#[derive(Debug, Serialize)]
pub struct ImportBackupSummary {
    /// 补回的主题数
    pub themes_added: usize,
    /// 备份里有、本地已有而跳过的主题数
    pub themes_skipped: usize,
    /// 补回的最近使用记录条数
    pub history_added: usize,
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

fn write_dir_into(
    writer: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    prefix: &str,
    files: &mut usize,
) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default();
    let entries =
        fs::read_dir(dir).map_err(|err| format!("读目录失败（{}：{err}）", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
        if path.is_dir() {
            write_dir_into(writer, &path, &name, files)?;
        } else {
            let data = fs::read(&path).map_err(|err| format!("读文件失败（{err}）"))?;
            writer
                .start_file(name, options)
                .map_err(|err| format!("打包失败（{err}）"))?;
            writer
                .write_all(&data)
                .map_err(|err| format!("写入压缩包失败（{err}）"))?;
            *files += 1;
        }
    }
    Ok(())
}

/// 把主题目录 + 记录文件打包到 dest
fn export_to(
    dest: &Path,
    themes_dir: &Path,
    history_file: &Path,
) -> Result<ExportBackupSummary, String> {
    let parent = dest.parent().ok_or("目标路径无效")?;
    if !parent.exists() {
        return Err(format!("目标文件夹不存在：{}", parent.display()));
    }

    let has_history = history_file.exists();
    let has_themes = themes_dir
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if !has_history && !has_themes {
        return Err("还没有可备份的内容（没导入过主题，也没有使用记录）".to_string());
    }

    let file =
        fs::File::create(dest).map_err(|err| format!("无法创建文件，它可能正被占用（{err}）"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let mut themes = 0usize;
    let mut files = 0usize;

    if themes_dir.exists() {
        let entries = fs::read_dir(themes_dir)
            .map_err(|err| format!("读主题目录失败（{err}）"))?;
        for entry in entries.flatten() {
            let dir = entry.path();
            // 一级子目录里有 theme.json 才算一套主题（口径与 importer 一致）
            if !dir.is_dir() || !dir.join("theme.json").exists() {
                continue;
            }
            themes += 1;
            let prefix = format!("themes/{}", entry.file_name().to_string_lossy());
            write_dir_into(&mut writer, &dir, &prefix, &mut files)?;
        }
    }

    if has_history {
        let data = fs::read(history_file).map_err(|err| format!("读最近使用记录失败（{err}）"))?;
        writer
            .start_file("history.json", options)
            .map_err(|err| format!("打包失败（{err}）"))?;
        writer
            .write_all(&data)
            .map_err(|err| format!("写入压缩包失败（{err}）"))?;
        files += 1;
    }

    if files == 0 {
        drop(writer);
        let _ = fs::remove_file(dest);
        return Err("没有可备份的文件".to_string());
    }

    writer
        .finish()
        .map_err(|err| format!("生成压缩包失败（{err}）"))?;
    Ok(ExportBackupSummary { themes, files })
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/// zip 条目名 → 安全的相对段列表（`/` 归一；`..`、盘符、绝对路径一律拒绝）
fn safe_parts(raw: &str) -> Option<Vec<String>> {
    let name = raw.replace('\\', "/");
    let parts: Vec<String> = name
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect();
    if parts.is_empty() {
        return None;
    }
    if parts
        .iter()
        .any(|part| part == ".." || part.contains(':') || part.contains('\0'))
    {
        return None;
    }
    Some(parts)
}

/// `themes/<uuid>/…` 条目 → (主题 id, 主题内相对路径)；其余返回 None
fn theme_entry(parts: &[String]) -> Option<(&str, PathBuf)> {
    if parts.len() < 3 || parts[0] != "themes" {
        return None;
    }
    let id = parts[1].as_str();
    if Uuid::parse_str(id).is_err() {
        return None;
    }
    let rel: PathBuf = parts[2..].iter().collect();
    Some((id, rel))
}

/// 从备份 zip 合并恢复
fn import_from(
    zip_path: &Path,
    themes_dir: &Path,
    history_file: &Path,
) -> Result<ImportBackupSummary, String> {
    let file = fs::File::open(zip_path).map_err(|err| format!("打不开备份文件（{err}）"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|err| format!("备份文件不是有效的 zip（{err}）"))?;

    // 第一遍（只读条目名）：哪些主题是完整的（带 theme.json）
    let mut complete: HashSet<String> = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|err| format!("读备份条目失败（{err}）"))?;
        if entry.is_dir() {
            continue;
        }
        if let Some(parts) = safe_parts(entry.name()) {
            if let Some((id, rel)) = theme_entry(&parts) {
                if rel == Path::new("theme.json") {
                    complete.insert(id.to_string());
                }
            }
        }
    }

    // 第二遍：写文件。本地已有同 id 主题 → 整套跳过；写失败清理半成品
    let mut themes_added = 0usize;
    let mut themes_skipped = 0usize;
    let mut counted_added: HashSet<String> = HashSet::new();
    let mut counted_skipped: HashSet<String> = HashSet::new();
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    let mut history_raw: Option<String> = None;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("读备份条目失败（{err}）"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(parts) = safe_parts(entry.name()) else {
            continue; // 怪条目直接跳过，绝不给路径穿越机会
        };

        if parts.len() == 1 && parts[0] == "history.json" {
            let mut raw = String::new();
            entry
                .read_to_string(&mut raw)
                .map_err(|err| format!("读备份里的使用记录失败（{err}）"))?;
            history_raw = Some(raw);
            continue;
        }

        let Some((id, rel)) = theme_entry(&parts) else {
            continue;
        };
        if !complete.contains(id) {
            continue; // 残缺主题（没有 theme.json）不恢复，免得列表里多一条坏数据
        }

        // 一套主题只在第一个条目处判定一次：本地已有 → 整套跳过；
        // 之后同 id 的条目跟着同一判定走（边读边写，目标目录会随首个条目出现）
        if counted_skipped.contains(id) {
            continue;
        }
        let target_dir = themes_dir.join(id);
        if !counted_added.contains(id) {
            if target_dir.exists() {
                counted_skipped.insert(id.to_string());
                themes_skipped += 1;
                continue;
            }
            counted_added.insert(id.to_string());
            themes_added += 1;
        }

        let target = target_dir.join(&rel);
        // 段列表已滤过 `..`/盘符，这里再兜一层：任何异常拼接都必须落在主题目录内
        if !target.starts_with(&target_dir) {
            continue;
        }
        if let Some(parent) = target.parent() {
            if let Err(err) = paths::ensure_dir(parent) {
                cleanup(&created_dirs);
                return Err(err);
            }
        }
        let mut out = match fs::File::create(&target) {
            Ok(file) => file,
            Err(err) => {
                cleanup(&created_dirs);
                return Err(format!("写入备份内容失败（{err}）"));
            }
        };
        if let Err(err) = std::io::copy(&mut entry, &mut out) {
            cleanup(&created_dirs);
            return Err(format!("写入备份内容失败（{err}）"));
        }
        if !created_dirs.contains(&target_dir) {
            created_dirs.push(target_dir.clone());
        }
    }

    let history_added = match history_raw {
        Some(raw) => {
            let entries = history::parse_entries(&raw)?;
            history::merge_into(history_file, &entries)?
        }
        None => 0,
    };

    Ok(ImportBackupSummary {
        themes_added,
        themes_skipped,
        history_added,
    })
}

/// 清理本次新建的主题目录（失败回滚；只删我们刚建的，不碰用户原有数据）
fn cleanup(dirs: &[PathBuf]) {
    for dir in dirs {
        let _ = fs::remove_dir_all(dir);
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 导出全部主题与使用记录为一个备份 zip
#[tauri::command]
pub fn export_backup(dest_path: String) -> Result<ExportBackupSummary, String> {
    export_to(
        Path::new(&dest_path),
        &paths::themes_dir(),
        &paths::history_file(),
    )
}

/// 从备份 zip 合并恢复（补回缺失，不覆盖已有）
#[tauri::command]
pub fn import_backup(zip_path: String) -> Result<ImportBackupSummary, String> {
    import_from(
        Path::new(&zip_path),
        &paths::themes_dir(),
        &paths::history_file(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cursorstudio-backup-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn seed_theme(themes: &Path, id: &str, marker: &str) {
        let dir = themes.join(id);
        fs::create_dir_all(dir.join("cursors")).expect("建主题目录");
        fs::write(dir.join("theme.json"), format!("{{\"id\":\"{id}\"}}")).expect("写 theme.json");
        fs::write(dir.join("cursors").join("arrow.cur"), marker).expect("写光标");
    }

    #[test]
    fn 导出再恢复应补回缺失主题并跳过重复() {
        let root = temp_root("roundtrip");
        let themes = root.join("themes");
        let history_file = root.join("history.json");
        seed_theme(&themes, "11111111-1111-4111-8111-111111111111", "a");
        seed_theme(&themes, "22222222-2222-4222-8222-222222222222", "b");
        fs::write(
            &history_file,
            r#"{"version":1,"entries":[{"theme_id":"11111111-1111-4111-8111-111111111111","name":"A","is_built_in":false,"applied_at":"2026-10-23 10:00"}]}"#,
        )
        .expect("写记录");

        let zip = root.join("backup.zip");
        let summary = export_to(&zip, &themes, &history_file).expect("导出");
        assert_eq!(summary.themes, 2);
        assert!(summary.files >= 3, "两套主题的文件 + history：{}", summary.files);

        // 恢复到空目录：两套都补回，记录一条
        let themes2 = root.join("themes2");
        let history2 = root.join("history2.json");
        let result = import_from(&zip, &themes2, &history2).expect("恢复");
        assert_eq!(result.themes_added, 2);
        assert_eq!(result.themes_skipped, 0);
        assert_eq!(result.history_added, 1);
        assert!(themes2
            .join("11111111-1111-4111-8111-111111111111")
            .join("cursors")
            .join("arrow.cur")
            .exists());

        // 再恢复一次：全部跳过，记录也去重
        let again = import_from(&zip, &themes2, &history2).expect("重复恢复");
        assert_eq!(again.themes_added, 0);
        assert_eq!(again.themes_skipped, 2);
        assert_eq!(again.history_added, 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 路径穿越与残缺主题不落盘() {
        let root = temp_root("unsafe");
        let themes = root.join("themes");
        let history_file = root.join("history.json");
        let zip = root.join("evil.zip");

        let file = fs::File::create(&zip).expect("建 zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("../evil.txt", options).expect("写穿越条目");
        writer.write_all(b"x").unwrap();
        writer
            .start_file("themes/33333333-3333-4333-8333-333333333333/../../evil.txt", options)
            .expect("写怪条目");
        writer.write_all(b"x").unwrap();
        // 没有 theme.json 的残缺主题：不该恢复
        writer
            .start_file(
                "themes/44444444-4444-4444-8444-444444444444/cursors/orphan.cur",
                options,
            )
            .expect("写残缺条目");
        writer.write_all(b"x").unwrap();
        writer.finish().unwrap();

        let result = import_from(&zip, &themes, &history_file).expect("恢复");
        assert_eq!(result.themes_added, 0, "残缺主题不该被恢复");
        assert!(!root.join("evil.txt").exists(), "不能写出目标目录");
        assert!(!themes
            .join("44444444-4444-4444-8444-444444444444")
            .exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 记录合并本地优先() {
        let root = temp_root("history-merge");
        let history_file = root.join("history.json");
        fs::write(
            &history_file,
            r#"{"version":1,"entries":[{"theme_id":"a","name":"本地","is_built_in":false,"applied_at":"2026-10-23 11:00"}]}"#,
        )
        .expect("写本地记录");

        let incoming = history::parse_entries(
            r#"{"version":1,"entries":[{"theme_id":"a","name":"备份","is_built_in":false,"applied_at":"2026-10-22 09:00"},{"theme_id":"b","name":"B","is_built_in":false,"applied_at":"2026-10-22 08:00"}]}"#,
        )
        .expect("解析备份记录");

        let added = history::merge_into(&history_file, &incoming).expect("合并");
        assert_eq!(added, 1, "同主题不重复补，只补 b");

        let (entries, _) = history::read_from(&history_file);
        let a = entries.iter().find(|e| e.theme_id == "a").expect("a 应保留");
        assert_eq!(a.name, "本地", "本地记录优先，不被备份覆盖");

        let _ = fs::remove_dir_all(&root);
    }
}
