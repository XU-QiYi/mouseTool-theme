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
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::CursorTheme;
use crate::utils::{history, limits, ops, paths, progress, theme_paths, validation};

/// 导出结果
#[derive(Debug, Serialize)]
pub struct ExportBackupSummary {
    /// 打包的主题数
    pub themes: usize,
    /// 打包的文件数（含 history.json）
    pub files: usize,
    /// 无法改写成相对路径等非致命问题
    pub warnings: Vec<String>,
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
    /// 恢复后路径改写失败的提示
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

fn write_dir_into(
    writer: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    prefix: &str,
    files: &mut usize,
    skip_top: Option<&str>,
) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default();
    let entries =
        fs::read_dir(dir).map_err(|err| format!("读目录失败（{}：{err}）", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
        if path.is_dir() {
            write_dir_into(writer, &path, &name, files, None)?;
        } else {
            if skip_top.is_some_and(|skip| entry.file_name().to_string_lossy().as_ref() == skip) {
                continue;
            }
            // 流式写入：备份可能有上百 MB，不整个读进内存
            let mut source =
                fs::File::open(&path).map_err(|err| format!("读文件失败（{err}）"))?;
            writer
                .start_file(name, options)
                .map_err(|err| format!("打包失败（{err}）"))?;
            io::copy(&mut source, writer)
                .map_err(|err| format!("写入压缩包失败（{err}）"))?;
            *files += 1;
        }
    }
    Ok(())
}

/// 把一个主题目录写进备份；`theme.json` 统一改写成相对路径
///
/// 备份可能被恢复到另一个根目录（甚至另一台机器），绝对路径必须剥掉。
/// 旧版备份里的绝对路径也在这里顺手改写；实在改不了的保留原值并提示。
fn write_theme_into(
    writer: &mut zip::ZipWriter<fs::File>,
    dir: &Path,
    prefix: &str,
    files: &mut usize,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let json_path = dir.join("theme.json");
    let parsed = fs::read_to_string(&json_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<CursorTheme>(&raw).ok());

    let Some(theme) = parsed else {
        warnings.push(format!(
            "主题目录 {} 的 theme.json 解析失败，已按原样打包",
            dir.display()
        ));
        return write_dir_into(writer, dir, prefix, files, None);
    };

    let (disk, path_warnings) = theme_paths::to_storage(&theme, dir);
    for warning in path_warnings {
        warnings.push(format!("主题《{}》{warning}", theme.name));
    }

    write_dir_into(writer, dir, prefix, files, Some("theme.json"))?;
    let json = serde_json::to_string_pretty(&disk).map_err(|err| format!("序列化主题失败（{err}）"))?;
    let options = zip::write::SimpleFileOptions::default();
    writer
        .start_file(format!("{prefix}/theme.json"), options)
        .map_err(|err| format!("打包失败（{err}）"))?;
    writer
        .write_all(json.as_bytes())
        .map_err(|err| format!("写入压缩包失败（{err}）"))?;
    *files += 1;
    Ok(())
}

/// 把主题目录 + 记录文件打包到 dest（测试用的无进度入口）
#[cfg(test)]
fn export_to(
    dest: &Path,
    themes_dir: &Path,
    history_file: &Path,
) -> Result<ExportBackupSummary, String> {
    export_to_with_progress(dest, themes_dir, history_file, &mut |_| {})
}

fn export_to_with_progress(
    dest: &Path,
    themes_dir: &Path,
    history_file: &Path,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
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

    // 先写同目录临时文件，成功后再改名：中途失败不会留下半个 zip，
    // 也不会破坏用户原有的同名备份
    let tmp = parent.join(format!(".cursorstudio-backup-{}.zip", Uuid::new_v4()));
    let file = fs::File::create(&tmp)
        .map_err(|err| format!("无法创建文件，它可能正被占用（{err}）"))?;

    let summary = write_backup_zip(file, themes_dir, history_file, has_history, progress_fn)
        .map_err(|err| {
            // write_backup_zip 返回时 writer 已释放，Windows 上这时才删得掉
            let _ = fs::remove_file(&tmp);
            err
        })?;

    fs::rename(&tmp, dest).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        format!("保存备份压缩包失败（{err}）")
    })?;
    Ok(summary)
}

fn write_backup_zip(
    file: fs::File,
    themes_dir: &Path,
    history_file: &Path,
    has_history: bool,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
) -> Result<ExportBackupSummary, String> {
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let mut themes = 0usize;
    let mut files = 0usize;
    let mut warnings: Vec<String> = Vec::new();

    if themes_dir.exists() {
        let entries = fs::read_dir(themes_dir)
            .map_err(|err| format!("读主题目录失败（{err}）"))?;
        let theme_dirs: Vec<_> = entries
            .flatten()
            .map(|entry| entry.path())
            // 一级子目录里有 theme.json 才算一套主题（口径与 importer 一致）
            .filter(|dir| dir.is_dir() && dir.join("theme.json").exists())
            .collect();
        let total = theme_dirs.len();

        for (index, dir) in theme_dirs.iter().enumerate() {
            let dir_name = dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            // id 与目录名不一致的目录恢复后会被读取端跳过，备份里也不收
            let stored_id = fs::read_to_string(dir.join("theme.json"))
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|value| value.get("id")?.as_str().map(str::to_string));
            if stored_id.as_deref() != Some(dir_name.as_str()) {
                warnings.push(format!(
                    "主题目录 {dir_name} 的 theme.json 与目录名不一致，已跳过"
                ));
                continue;
            }

            themes += 1;
            let prefix = format!("themes/{dir_name}");
            write_theme_into(&mut writer, dir, &prefix, &mut files, &mut warnings)?;
            progress_fn(progress::TaskProgress::new(
                "write",
                index + 1,
                total,
                format!("正在打包主题（{}/{}）", index + 1, total),
            ));
        }
    }

    if has_history {
        let size = fs::metadata(history_file)
            .map(|meta| meta.len())
            .unwrap_or(0);
        if size > MAX_HISTORY_BYTES {
            return Err(format!(
                "最近使用记录超过 {}MB，已停止导出",
                MAX_HISTORY_BYTES / 1024 / 1024
            ));
        }
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
        // 临时文件的清理由出口统一负责（返回时 writer 已释放）
        return Err("没有可备份的文件".to_string());
    }

    writer
        .finish()
        .map_err(|err| format!("生成压缩包失败（{err}）"))?;
    Ok(ExportBackupSummary {
        themes,
        files,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/// 备份里的使用记录上限：正常只有几百条，超过这个尺寸基本是坏包
const MAX_HISTORY_BYTES: u64 = 8 * 1024 * 1024;

/// `themes/<uuid>/…` 条目 → (主题 id, 主题内相对路径)；其余返回 None
fn theme_entry(parts: &[String]) -> Option<(&str, PathBuf)> {
    if parts.len() < 3 || parts[0] != "themes" {
        return None;
    }
    let id = parts[1].as_str();
    let parsed = Uuid::parse_str(id).ok()?;
    // 目录名必须是小写规范 UUID，和读盘端「id == 目录名」的判定保持同一口径
    if parsed.to_string() != id {
        return None;
    }
    let rel: PathBuf = parts[2..].iter().collect();
    Some((id, rel))
}

/// 第一遍（只读条目名与 theme.json）：哪些主题是完整的、且 id 与目录名一致
///
/// theme.json 里声明了别的 id、或自称系统方案，恢复后读盘端会整条跳过；
/// 这种主题不写进 `complete`，第二遍整套忽略并给出提示。
fn collect_complete_themes(
    archive: &mut zip::ZipArchive<fs::File>,
    warnings: &mut Vec<String>,
) -> Result<HashSet<String>, String> {
    let mut complete: HashSet<String> = HashSet::new();
    let mut rejected: HashSet<String> = HashSet::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("读备份条目失败（{err}）"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(parts) = limits::safe_relative_parts(entry.name(), &limits::BACKUP_LIMITS)?
        else {
            continue;
        };
        let Some((id, rel)) = theme_entry(&parts) else {
            continue;
        };
        if rel != Path::new("theme.json") || rejected.contains(id) {
            continue;
        }

        let id = id.to_string();
        let mut raw = String::new();
        let valid = entry.size() <= 1024 * 1024
            && (&mut entry)
                .take(1024 * 1024)
                .read_to_string(&mut raw)
                .is_ok()
            && serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .is_some_and(|value| {
                    value.get("id").and_then(|item| item.as_str()) == Some(id.as_str())
                        && !value
                            .get("is_built_in")
                            .and_then(|item| item.as_bool())
                            .unwrap_or(false)
                });

        if valid {
            complete.insert(id);
        } else {
            complete.remove(&id);
            rejected.insert(id.clone());
            warnings.push(format!(
                "主题目录 {id} 的 theme.json 缺失、损坏或 ID 不一致，已跳过"
            ));
        }
    }
    Ok(complete)
}

/// 从备份 zip 合并恢复（测试用的无进度入口）
#[cfg(test)]
fn import_from(
    zip_path: &Path,
    themes_dir: &Path,
    history_file: &Path,
) -> Result<ImportBackupSummary, String> {
    import_from_with_progress(zip_path, themes_dir, history_file, &mut |_| {})
}

fn import_from_with_progress(
    zip_path: &Path,
    themes_dir: &Path,
    history_file: &Path,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
) -> Result<ImportBackupSummary, String> {
    let meta = fs::metadata(zip_path).map_err(|err| format!("打不开备份文件（{err}）"))?;
    if meta.len() > limits::BACKUP_LIMITS.max_total_bytes {
        return Err(format!(
            "备份文件超过 {} 上限，已拒绝导入",
            limits::BACKUP_LIMITS.total_hint()
        ));
    }

    let file = fs::File::open(zip_path).map_err(|err| format!("打不开备份文件（{err}）"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|err| format!("备份文件不是有效的 zip（{err}）"))?;
    if archive.len() > limits::BACKUP_LIMITS.max_entries {
        return Err(format!(
            "备份里的文件太多（超过 {} 个），已拒绝导入",
            limits::BACKUP_LIMITS.max_entries
        ));
    }

    let total = archive.len();
    progress_fn(progress::TaskProgress::new(
        "scan",
        0,
        total,
        "正在检查备份内容…",
    ));

    let mut warnings: Vec<String> = Vec::new();
    let complete = collect_complete_themes(&mut archive, &mut warnings)?;

    // 第二遍：写文件。本地已有同 id 主题 → 整套跳过；写失败清理半成品
    let mut themes_added = 0usize;
    let mut themes_skipped = 0usize;
    let mut counted_added: HashSet<String> = HashSet::new();
    let mut counted_skipped: HashSet<String> = HashSet::new();
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    let mut history_raw: Option<String> = None;

    let outcome = (|| -> Result<(), String> {
        let mut budget = limits::ArchiveBudget::new(&limits::BACKUP_LIMITS);
        let mut throttle = progress::ProgressThrottle::new(total);

        for index in 0..total {
            if throttle.step(index) {
                progress_fn(progress::TaskProgress::new(
                    "restore",
                    index,
                    total,
                    format!("正在恢复（{}/{}）", index, total),
                ));
            }

            let mut entry = archive
                .by_index(index)
                .map_err(|err| format!("读备份条目失败（{err}）"))?;
            if entry.is_dir() {
                continue;
            }
            // 条目名白名单：穿越、盘符、保留名、层级过深都整包拒绝
            let Some(parts) =
                limits::safe_relative_parts(entry.name(), &limits::BACKUP_LIMITS)?
            else {
                continue;
            };

            if parts.len() == 1 && parts[0] == "history.json" {
                budget.note_entry()?;
                let cap = budget.allowance().min(MAX_HISTORY_BYTES);
                let mut raw = Vec::new();
                let bytes =
                    limits::copy_bounded(&mut entry, &mut raw, cap, &limits::BACKUP_LIMITS)?;
                budget.commit(bytes)?;
                history_raw = Some(
                    String::from_utf8(raw)
                        .map_err(|_| "备份里的使用记录不是有效的 UTF-8 文本".to_string())?,
                );
                continue;
            }

            let Some((id, rel)) = theme_entry(&parts) else {
                continue;
            };
            if !complete.contains(id) || counted_skipped.contains(id) {
                continue; // 残缺 / ID 不一致的主题不恢复，免得列表里多一条坏数据
            }

            // 一套主题只在第一个条目处判定一次：本地已有 → 整套跳过；
            // 之后同 id 的条目跟着同一判定走（边读边写，目标目录会随首个条目出现）
            let target_dir = themes_dir.join(id);
            if !counted_added.contains(id) {
                if target_dir.exists() {
                    counted_skipped.insert(id.to_string());
                    themes_skipped += 1;
                    continue;
                }
                counted_added.insert(id.to_string());
                themes_added += 1;
                created_dirs.push(target_dir.clone());
            }

            let target = target_dir.join(&rel);
            // 段列表已滤过 `..`/盘符，这里再兜一层：任何异常拼接都必须落在主题目录内
            if !target.starts_with(&target_dir) {
                return Err(format!("备份里的条目越出了主题目录：{}", entry.name()));
            }
            budget.note_entry()?;
            if let Some(parent) = target.parent() {
                paths::ensure_dir(parent)?;
            }
            let mut out = fs::File::create(&target)
                .map_err(|err| format!("写入备份内容失败（{err}）"))?;
            let bytes = limits::copy_bounded(
                &mut entry,
                &mut out,
                budget.allowance(),
                &limits::BACKUP_LIMITS,
            )?;
            budget.commit(bytes)?;
        }
        Ok(())
    })();

    if let Err(err) = outcome {
        cleanup(&created_dirs);
        return Err(err);
    }

    // 记录是附属数据：合并失败不回滚已经恢复的主题，只提示原因
    let history_added = match history_raw {
        Some(raw) => match history::parse_events(&raw) {
            Ok(entries) => match history::merge_into(history_file, &entries) {
                Ok(added) => added,
                Err(err) => {
                    warnings.push(format!("主题已恢复，但最近使用记录没合并成功（{err}）"));
                    0
                }
            },
            Err(err) => {
                warnings.push(format!("备份里的最近使用记录已忽略（{err}）"));
                0
            }
        },
        None => 0,
    };

    // 恢复后统一改写 `theme.json`：备份可能来自另一个根目录/机器，旧绝对路径
    // 要重新按主题 id 或文件名落到当前主题目录；相对路径原样保留
    let mut added_ids: Vec<String> = counted_added.iter().cloned().collect();
    added_ids.sort();
    for id in added_ids {
        let dir = themes_dir.join(&id);
        match theme_paths::rewrite_theme_file(&dir) {
            Ok(path_warnings) => {
                for warning in path_warnings {
                    warnings.push(format!("主题 {id}：{warning}"));
                }
            }
            Err(err) => warnings.push(format!(
                "主题 {id} 的 theme.json 没能改写路径（{err}），已按原样恢复"
            )),
        }
    }

    progress_fn(progress::TaskProgress::new(
        "done",
        total,
        total,
        format!("恢复完成：补回 {themes_added} 套主题"),
    ));

    Ok(ImportBackupSummary {
        themes_added,
        themes_skipped,
        history_added,
        warnings,
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
///
/// 打包在后台线程执行，进度通过 `backup-progress` 事件推给界面；导出期间
/// 其它重操作（导入 / 恢复 / 迁移）会被互斥锁挡住。
#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    dest_path: String,
) -> Result<ExportBackupSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("导出备份")?;
        let dest = validation::validate_dest_path(&dest_path, "zip")?;
        let emitter = app.clone();
        export_to_with_progress(
            &dest,
            &paths::themes_dir()?,
            &paths::history_file()?,
            &mut |progress| {
                let _ = emitter.emit("backup-progress", progress);
            },
        )
    })
    .await
    .map_err(|err| format!("导出任务异常退出（{err}）"))?
}

/// 从备份 zip 合并恢复（补回缺失，不覆盖已有）
///
/// 与主题包导入共用同一套限额（`utils::limits::BACKUP_LIMITS`）：条目数、
/// 单文件与总解压体积、条目名白名单都在这里生效；超限或写盘失败会删掉
/// 本次新建的主题目录。
#[tauri::command]
pub async fn import_backup(app: AppHandle, zip_path: String) -> Result<ImportBackupSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("恢复备份")?;
        let source = validation::validate_source_file(&zip_path, "zip", "备份文件")?;
        let emitter = app.clone();
        import_from_with_progress(
            &source,
            &paths::themes_dir()?,
            &paths::history_file()?,
            &mut |progress| {
                let _ = emitter.emit("backup-progress", progress);
            },
        )
    })
    .await
    .map_err(|err| format!("恢复任务异常退出（{err}）"))?
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

    /// 合法主题：槽位路径先按旧版本口径写成绝对路径
    fn seed_absolute_theme(themes: &Path, id: &str) -> PathBuf {
        let dir = themes.join(id);
        fs::create_dir_all(dir.join("cursors")).expect("建主题目录");
        fs::write(dir.join("cursors").join("arrow.cur"), b"cursor").expect("写光标");
        let theme = CursorTheme {
            id: id.to_string(),
            name: "备份测试".to_string(),
            description: String::new(),
            created_at: "2026-01-01 00:00".to_string(),
            updated_at: "2026-01-01 00:00".to_string(),
            is_built_in: false,
            cursors: vec![crate::models::CursorSlot {
                registry_key: "Arrow".to_string(),
                display_name: "正常选择".to_string(),
                english_name: "Normal Select".to_string(),
                file_path: dir
                    .join("cursors")
                    .join("arrow.cur")
                    .to_string_lossy()
                    .into_owned(),
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

    fn read_zip_text(zip: &Path, name: &str) -> String {
        let file = fs::File::open(zip).expect("打开 zip");
        let mut archive = zip::ZipArchive::new(file).expect("解析 zip");
        let mut text = String::new();
        archive
            .by_name(name)
            .expect("zip 里应有该条目")
            .read_to_string(&mut text)
            .expect("读条目");
        text
    }

    /// 导出中途失败：不留半成品，也不能破坏用户原有的同名备份
    #[test]
    fn 导出失败时清理临时包并保留原目标文件() {
        let root = temp_root("cleanup");
        let themes = root.join("themes");
        // 主题目录位置被一个文件占住：预检能看到 history，进到读目录时失败
        fs::write(&themes, b"not a dir").expect("占住主题目录路径");
        let history_file = root.join("history.json");
        fs::write(&history_file, r#"{"version":2,"events":[]}"#).expect("写记录");

        let zip = root.join("backup.zip");
        fs::write(&zip, b"old backup").expect("预置旧备份");

        let err = export_to(&zip, &themes, &history_file).unwrap_err();
        assert!(err.contains("读主题目录失败"), "实际：{err}");
        assert_eq!(
            fs::read(&zip).expect("旧备份应还在"),
            b"old backup".to_vec(),
            "失败不能顺手把用户原有的备份删掉"
        );

        let leftovers: Vec<_> = fs::read_dir(&root)
            .expect("读临时目录")
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".cursorstudio-backup-")
            })
            .collect();
        assert!(leftovers.is_empty(), "不能留下半成品临时包");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 备份导出与恢复都写成相对路径() {
        let root = temp_root("relative");
        let themes = root.join("themes");
        let history_file = root.join("history.json");
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        seed_absolute_theme(&themes, id);

        let zip = root.join("backup.zip");
        let summary = export_to(&zip, &themes, &history_file).expect("导出");
        assert_eq!(summary.themes, 1);
        assert!(summary.warnings.is_empty(), "目录内绝对路径应能无提示改写");

        let exported: CursorTheme =
            serde_json::from_str(&read_zip_text(&zip, &format!("themes/{id}/theme.json")))
                .expect("解析导出的 theme.json");
        assert_eq!(
            exported.cursors[0].file_path, "cursors/arrow.cur",
            "备份里的槽位路径必须是相对路径"
        );

        // 恢复到新的根目录：相对路径要能拼到新目录并找到文件
        let restored = root.join("restored");
        let history2 = root.join("history2.json");
        let result = import_from(&zip, &restored, &history2).expect("恢复");
        assert_eq!(result.themes_added, 1);
        assert!(result.warnings.is_empty(), "正常备份不该有改写警告");

        let theme_dir = restored.join(id);
        let saved: CursorTheme = serde_json::from_str(
            &fs::read_to_string(theme_dir.join("theme.json")).expect("读恢复后的主题"),
        )
        .expect("解析恢复后的主题");
        assert_eq!(saved.cursors[0].file_path, "cursors/arrow.cur");
        let resolved = theme_paths::resolve(&saved.cursors[0].file_path, &theme_dir);
        assert!(Path::new(&resolved).is_file(), "恢复后的槽位应指向新根目录");

        let _ = fs::remove_dir_all(&root);
    }

    /// 旧版备份里的绝对路径：恢复到新根目录时按主题 id 重新定位
    #[test]
    fn 旧备份的绝对路径恢复后指向新根() {
        let root = temp_root("legacy");
        let zip = root.join("legacy.zip");
        let id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let old_path = format!(r"C:\old\themes\{id}\cursors\arrow.cur");
        let theme = CursorTheme {
            id: id.to_string(),
            name: "旧备份".to_string(),
            description: String::new(),
            created_at: "2026-01-01 00:00".to_string(),
            updated_at: "2026-01-01 00:00".to_string(),
            is_built_in: false,
            cursors: vec![crate::models::CursorSlot {
                registry_key: "Arrow".to_string(),
                display_name: "正常选择".to_string(),
                english_name: "Normal Select".to_string(),
                file_path: old_path,
                file_type: "cur".to_string(),
            }],
        };

        let file = fs::File::create(&zip).expect("建 zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in [
            (
                format!("themes/{id}/theme.json"),
                serde_json::to_string_pretty(&theme).unwrap().into_bytes(),
            ),
            (
                format!("themes/{id}/cursors/arrow.cur"),
                b"cursor".to_vec(),
            ),
        ] {
            writer.start_file(name, options).expect("写条目");
            writer.write_all(&data).expect("写数据");
        }
        writer.finish().expect("完成压缩");

        let restored = root.join("restored");
        let history = root.join("history.json");
        let result = import_from(&zip, &restored, &history).expect("恢复");
        assert_eq!(result.themes_added, 1);

        let theme_dir = restored.join(id);
        let saved: CursorTheme = serde_json::from_str(
            &fs::read_to_string(theme_dir.join("theme.json")).expect("读恢复后的主题"),
        )
        .expect("解析恢复后的主题");
        assert_eq!(saved.cursors[0].file_path, "cursors/arrow.cur");
        let resolved = theme_paths::resolve(&saved.cursors[0].file_path, &theme_dir);
        assert!(Path::new(&resolved).is_file());

        let _ = fs::remove_dir_all(&root);
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
    fn 路径穿越整包拒绝且不落盘() {
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
        writer.finish().unwrap();

        let err = import_from(&zip, &themes, &history_file).unwrap_err();
        assert!(
            err.contains("跳出目标目录") || err.contains("不合法"),
            "路径穿越应整包拒绝，实际：{err}"
        );
        assert!(!root.join("evil.txt").exists(), "不能写出目标目录");
        assert!(!themes
            .join("33333333-3333-4333-8333-333333333333")
            .exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn theme_json_的_id_与目录不一致时跳过() {
        let root = temp_root("id-mismatch");
        let themes = root.join("themes");
        let zip = root.join("mismatch.zip");
        let id = "55555555-5555-4555-8555-555555555555";
        let other = "66666666-6666-4666-8666-666666666666";

        let file = fs::File::create(&zip).expect("建 zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file(format!("themes/{id}/theme.json"), options)
            .unwrap();
        writer
            .write_all(
                serde_json::json!({ "id": other, "name": "冒名", "cursors": [] })
                    .to_string()
                    .as_bytes(),
            )
            .unwrap();
        writer
            .start_file(format!("themes/{id}/cursors/arrow.cur"), options)
            .unwrap();
        writer.write_all(b"cursor").unwrap();
        writer.finish().unwrap();

        let result = import_from(&zip, &themes, &root.join("history.json")).expect("恢复");
        assert_eq!(result.themes_added, 0, "ID 不一致的主题不能恢复");
        assert!(!themes.join(id).exists());
        assert!(
            result.warnings.iter().any(|w| w.contains("ID 不一致")),
            "要说明为什么跳过：{:?}",
            result.warnings
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 备份条目数超过上限时整包拒绝() {
        let root = temp_root("too-many");
        let zip = root.join("too-many.zip");
        let file = fs::File::create(&zip).expect("建 zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for index in 0..=limits::BACKUP_LIMITS.max_entries {
            writer.start_file(format!("f{index}.txt"), options).unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap();

        let err = import_from(&zip, &root.join("themes"), &root.join("history.json"))
            .unwrap_err();
        assert!(err.contains("文件太多"), "实际：{err}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 记录合并按事件去重且保留本地记录() {
        let root = temp_root("history-merge");
        let history_file = root.join("history.json");
        fs::write(
            &history_file,
            r#"{"version":1,"entries":[{"theme_id":"a","name":"本地","is_built_in":false,"applied_at":"2026-10-23 11:00"}]}"#,
        )
        .expect("写本地记录");

        let incoming = history::parse_events(
            r#"{"version":1,"entries":[{"theme_id":"a","name":"备份","is_built_in":false,"applied_at":"2026-10-22 09:00"},{"theme_id":"b","name":"B","is_built_in":false,"applied_at":"2026-10-22 08:00"}]}"#,
        )
        .expect("解析备份记录");

        let added = history::merge_into(&history_file, &incoming).expect("合并");
        assert_eq!(added, 2, "同主题不同时间是不同事件，两条都应补回");

        let events = history::read_events_from(&history_file).events;
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].name, "本地", "最新的本地事件仍在最前");
        assert!(
            events
                .iter()
                .any(|e| e.theme_id == "a" && e.applied_at == "2026-10-22 09:00"),
            "备份里的旧事件也要保留，不能被本地同主题记录吞掉"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
