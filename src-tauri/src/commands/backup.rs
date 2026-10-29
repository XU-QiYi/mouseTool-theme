//! 数据备份：整包导出 / 合并恢复 / 备份内容浏览与单主题恢复
//!
//! 备份内容 = 用户主题（`themes/**`）+ 最近使用记录（`history.json`）。
//! 恢复是**合并**语义：本地已有的主题保留（同 id 整套跳过），只补回缺失的
//! 完整主题（含 theme.json）；记录本地优先、按主题去重补回。不覆盖不删除——
//! 恢复备份不该抹掉用户之后的改动，这是「备份」锚点（决策 11）的安全底线。
//!
//! 核心函数都收显式路径（`*_to` / `*_from`），命令层才绑定真实数据目录，
//! 测试全程用临时目录，不碰用户数据。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::CursorTheme;
use crate::utils::{history, limits, ops, paths, progress, theme_paths, tray, validation};

/// 导出结果
#[derive(Debug, Serialize)]
pub struct ExportBackupSummary {
    /// 打包的主题数
    pub themes: usize,
    /// 打包的文件数（含 history.json）
    pub files: usize,
    /// 备份最终落盘的位置（应用内备份 = `backups\` 下的路径）
    pub saved_path: String,
    /// 备份文件体积（字节）
    pub bytes: u64,
    /// 无法改写成相对路径等非致命问题
    pub warnings: Vec<String>,
}

/// 备份历史的一条记录（`list_backups`）
#[derive(Debug, Serialize)]
pub struct BackupEntry {
    pub file_name: String,
    pub path: String,
    /// 文件修改时间，本地时区 `YYYY-MM-DD HH:MM`；读不到为「未知」
    pub created_at: String,
    /// "manual"（应用内手动备份）| "auto"（每天一份的自动备份，决策 32）
    pub kind: String,
    /// 包内的完整主题数（唯一 `themes/<uuid>/theme.json`）
    pub themes: usize,
    /// 包内条目数
    pub files: usize,
    pub bytes: u64,
    /// "ok" | "corrupt"
    pub status: String,
    /// corrupt 时的中文原因
    pub error: Option<String>,
}

/// 备份里的一套主题摘要（`list_backup_themes`，只读，不解压光标）
#[derive(Debug, Serialize)]
pub struct BackupThemeEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    /// 主题声明的槽位数
    pub slots: usize,
    /// 这套主题在包里的条目数（含 theme.json）
    pub files: usize,
    /// 这套主题在包里的解压后总字节数（按中央目录声明值）
    pub bytes: u64,
    /// 声明的槽位里，包里找不到对应文件的个数
    ///
    /// 0 = 文件齐全；大于 0 仍可按套恢复，但恢复后的主题会在主题库里
    /// 显示文件缺口（决策 31）；等于 `slots` 时没有任何可用文件，界面禁用恢复。
    pub missing_files: usize,
}

/// `list_backup_themes` 的返回值
#[derive(Debug, Serialize)]
pub struct BackupThemeListing {
    /// 能恢复的主题（`theme.json` 可解析、id 与目录一致、不是系统方案）
    pub themes: Vec<BackupThemeEntry>,
    /// 备份里被跳过或损坏的主题说明
    pub warnings: Vec<String>,
}

/// `restore_theme_from_backup` 的返回值
#[derive(Debug, Serialize)]
pub struct RestoreBackupThemeOutcome {
    /// 刚落盘的主题，槽位路径已解析成运行时绝对路径
    pub theme: CursorTheme,
    /// 路径改写 / 槽位清洗等非致命提示
    pub warnings: Vec<String>,
}

/// 备份历史最多返回的条数：异常目录（上千个 zip）不该拖垮界面
const MAX_BACKUP_ENTRIES: usize = 200;

/// 应用内手动备份的文件名前缀
const MANUAL_BACKUP_PREFIX: &str = "cursorstudio-backup-";
/// 自动备份的文件名前缀（决策 32）：`cursorstudio-backup-auto-YYYYMMDD-HHmmss.zip`
const AUTO_BACKUP_PREFIX: &str = "cursorstudio-backup-auto-";

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
    warnings: &mut Vec<String>,
    skip_top: Option<&str>,
) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default();
    let entries =
        fs::read_dir(dir).map_err(|err| format!("读目录失败（{}：{err}）", dir.display()))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                warnings.push(format!("读取备份目录项失败，已跳过（{err}）"));
                continue;
            }
        };
        let path = entry.path();
        let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
        // 不能跟随 junction / symlink：备份会把链接指向的外部文件一起打包
        if limits::is_reparse_entry(&entry) {
            warnings.push(format!("已跳过链接或目录联接：{}", path.display()));
            continue;
        }
        let is_dir = entry
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false);
        if is_dir {
            write_dir_into(writer, &path, &name, files, warnings, None)?;
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
    let parsed = limits::read_text_bounded(&json_path, limits::MAX_THEME_JSON_BYTES)
        .ok()
        .and_then(|raw| serde_json::from_str::<CursorTheme>(&raw).ok());

    let Some(theme) = parsed else {
        warnings.push(format!(
            "主题目录 {} 的 theme.json 读取失败或已损坏，已按原样打包",
            dir.display()
        ));
        return write_dir_into(writer, dir, prefix, files, warnings, None);
    };

    let (disk, path_warnings) = theme_paths::to_storage(&theme, dir);
    for warning in path_warnings {
        warnings.push(format!("主题《{}》{warning}", theme.name));
    }

    write_dir_into(writer, dir, prefix, files, warnings, Some("theme.json"))?;
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
        .inspect_err(|_| {
            // write_backup_zip 返回时 writer 已释放，Windows 上这时才删得掉
            let _ = fs::remove_file(&tmp);
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
        let mut theme_dirs = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    warnings.push(format!("读取主题目录项失败，已跳过（{err}）"));
                    continue;
                }
            };
            let dir = entry.path();
            if limits::is_reparse_entry(&entry) {
                warnings.push(format!("已跳过链接或目录联接：{}", dir.display()));
                continue;
            }
            // 一级子目录里有 theme.json 才算一套主题（口径与 importer 一致）
            let is_dir = entry
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or(false);
            let json_path = dir.join("theme.json");
            if is_dir && json_path.is_file() {
                if limits::is_reparse_path(&json_path) {
                    warnings.push(format!(
                        "主题目录 {} 的 theme.json 是链接或目录联接，已跳过",
                        dir.display()
                    ));
                    continue;
                }
                theme_dirs.push(dir);
            }
        }
        let total = theme_dirs.len();

        for (index, dir) in theme_dirs.iter().enumerate() {
            let dir_name = dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            // id 与目录名不一致的目录恢复后会被读取端跳过，备份里也不收
            let stored_id = limits::read_text_bounded(
                &dir.join("theme.json"),
                limits::MAX_THEME_JSON_BYTES,
            )
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
        if size > limits::MAX_STATE_FILE_BYTES {
            warnings.push(format!(
                "最近使用记录超过 {}KB 上限，已跳过；主题仍会正常备份",
                limits::MAX_STATE_FILE_BYTES / 1024
            ));
        } else {
            let data = limits::read_text_bounded(history_file, limits::MAX_STATE_FILE_BYTES)
                .map_err(|err| format!("读最近使用记录失败（{err}）"))?;
            writer
                .start_file("history.json", options)
                .map_err(|err| format!("打包失败（{err}）"))?;
            writer
                .write_all(data.as_bytes())
                .map_err(|err| format!("写入压缩包失败（{err}）"))?;
            files += 1;
        }
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
        // 命令层在改名落盘后回填；核心函数不知道（也不该知道）最终路径
        saved_path: String::new(),
        bytes: 0,
        warnings,
    })
}

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

/// `themes/<uuid>/…` 条目 → (主题 id, 主题内相对路径)；其余返回 None
fn theme_entry(parts: &[String]) -> Option<(&str, PathBuf)> {
    if parts.len() < 3 || parts[0] != "themes" {
        return None;
    }
    let id = parts[1].as_str();
    // 目录名必须是小写规范 UUID，和读盘端「id == 目录名」的判定保持同一口径
    if !validation::is_canonical_uuid(id) {
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

    // 第一遍之前先做整包预算预检：只看条目名和声明大小，不读内容。
    // 否则 4096 个 1MB 的 theme.json 能在真正开始恢复前就读掉 4GB。
    let mut budget = limits::ArchiveBudget::new(&limits::BACKUP_LIMITS);
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|err| format!("读备份条目失败（{err}）"))?;
        if entry.is_dir() {
            continue;
        }
        if limits::safe_relative_parts(entry.name(), &limits::BACKUP_LIMITS)?.is_none() {
            continue;
        }
        budget.note_entry()?;
        let size = entry.size();
        if size > limits::BACKUP_LIMITS.max_file_bytes {
            return Err(format!(
                "备份里的文件解压后超过单文件 {} 上限：{}",
                limits::BACKUP_LIMITS.file_hint(),
                entry.name()
            ));
        }
        budget.commit(size)?;
    }

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
        let valid = entry.size() <= limits::MAX_THEME_JSON_BYTES
            && (&mut entry)
                .take(limits::MAX_THEME_JSON_BYTES)
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

// ---------------------------------------------------------------------------
// 备份内容浏览与单主题恢复（决策 34）
// ---------------------------------------------------------------------------

fn open_backup_archive(zip_path: &Path) -> Result<zip::ZipArchive<fs::File>, String> {
    let meta = fs::metadata(zip_path).map_err(|err| format!("打不开备份文件（{err}）"))?;
    if meta.len() > limits::BACKUP_LIMITS.max_total_bytes {
        return Err(format!(
            "备份文件超过 {} 上限，已拒绝读取",
            limits::BACKUP_LIMITS.total_hint()
        ));
    }
    let file = fs::File::open(zip_path).map_err(|err| format!("打不开备份文件（{err}）"))?;
    let archive =
        zip::ZipArchive::new(file).map_err(|err| format!("备份文件不是有效的 zip（{err}）"))?;
    if archive.len() > limits::BACKUP_LIMITS.max_entries {
        return Err(format!(
            "备份里的文件太多（超过 {} 个），已拒绝读取",
            limits::BACKUP_LIMITS.max_entries
        ));
    }
    Ok(archive)
}

/// 统计 theme.json 声明、但备份包里找不到文件的槽位数
///
/// 用包里已有的相对路径当候选（`to_storage_with_file_candidates`）：旧备份的
/// 绝对路径也能先按主题 id / 文件名归一化再比较；空路径表示主题没提供该槽位，
/// 不算缺口（与决策 31 的 `missing_slots` 同口径）。
fn count_missing_files(theme: &CursorTheme, candidates: &[PathBuf]) -> usize {
    let (disk, _) = theme_paths::to_storage_with_file_candidates(theme, candidates);
    let available: HashSet<String> = candidates
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/").to_lowercase())
        .collect();
    disk.cursors
        .iter()
        .filter(|slot| !slot.file_path.trim().is_empty())
        .filter(|slot| {
            theme_paths::normalize_relative(&slot.file_path)
                .map(|relative| !available.contains(&relative.to_lowercase()))
                .unwrap_or(true)
        })
        .count()
}

/// 恢复后实际缺失的槽位中文名（决策 31 的缺口口径）
fn missing_slot_names(theme: &CursorTheme) -> Vec<String> {
    theme
        .cursors
        .iter()
        .filter(|slot| !slot.file_path.trim().is_empty())
        .filter(|slot| fs::metadata(&slot.file_path).is_err())
        .map(|slot| {
            if slot.display_name.trim().is_empty() {
                slot.registry_key.clone()
            } else {
                slot.display_name.clone()
            }
        })
        .collect()
}

/// 只读备份内容：列出包里能完整恢复的主题与它们的体积，不解压光标
///
/// 第一遍沿用合并恢复的完整性判定（`collect_complete_themes`，含整包预算预检），
/// 第二遍只读 `theme.json` 与中央目录声明大小；不预览光标、不写任何文件。
fn list_backup_themes_in(zip_path: &Path) -> Result<BackupThemeListing, String> {
    let mut archive = open_backup_archive(zip_path)?;
    let mut warnings = Vec::new();
    let complete = collect_complete_themes(&mut archive, &mut warnings)?;
    if complete.is_empty() {
        return Ok(BackupThemeListing {
            themes: Vec::new(),
            warnings,
        });
    }

    let mut stats: HashMap<String, (usize, u64)> = HashMap::new();
    let mut candidates_by_theme: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut parsed: HashMap<String, CursorTheme> = HashMap::new();
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
        if !complete.contains(id) {
            continue;
        }

        let stat = stats.entry(id.to_string()).or_insert((0, 0));
        stat.0 += 1;
        stat.1 = stat.1.saturating_add(entry.size());

        if rel != Path::new("theme.json") {
            candidates_by_theme
                .entry(id.to_string())
                .or_default()
                .push(rel.clone());
        }

        if rel == Path::new("theme.json") {
            let mut raw = String::new();
            let read_ok = entry.size() <= limits::MAX_THEME_JSON_BYTES
                && (&mut entry)
                    .take(limits::MAX_THEME_JSON_BYTES)
                    .read_to_string(&mut raw)
                    .is_ok();
            match read_ok.then(|| serde_json::from_str::<CursorTheme>(&raw)) {
                Some(Ok(theme)) => {
                    parsed.insert(id.to_string(), theme);
                }
                Some(Err(err)) => warnings.push(format!(
                    "主题目录 {id} 的 theme.json 结构不完整，已跳过（{err}）"
                )),
                None => warnings.push(format!(
                    "主题目录 {id} 的 theme.json 读取失败或超过大小上限，已跳过"
                )),
            }
        }
    }

    let mut themes: Vec<BackupThemeEntry> = parsed
        .into_iter()
        .map(|(id, theme)| {
            let (files, bytes) = stats.get(&id).copied().unwrap_or((0, 0));
            let candidates = candidates_by_theme.remove(&id).unwrap_or_default();
            let missing_files = count_missing_files(&theme, &candidates);
            BackupThemeEntry {
                id,
                name: theme.name,
                description: theme.description,
                created_at: theme.created_at,
                updated_at: theme.updated_at,
                slots: theme.cursors.len(),
                files,
                bytes,
                missing_files,
            }
        })
        .collect();
    themes.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });

    Ok(BackupThemeListing { themes, warnings })
}

/// 从备份里恢复**一套**主题：只解压这套主题的文件，追加到当前主题目录
///
/// 与整包合并恢复的区别：不碰其它主题、不合并使用记录、目标已存在时直接拒绝。
/// 失败会删掉本次新建的主题目录，不留半成品；成功后才刷新托盘菜单。
fn restore_theme_from_backup_in(
    zip_path: &Path,
    theme_id: &str,
    themes_dir: &Path,
) -> Result<RestoreBackupThemeOutcome, String> {
    if !validation::is_canonical_uuid(theme_id) {
        return Err("主题 ID 必须是规范的小写 UUID".to_string());
    }
    let target_dir = themes_dir.join(theme_id);
    if fs::symlink_metadata(&target_dir).is_ok() {
        return Err(format!(
            "主题库里已有同 ID 的主题（{theme_id}），无需从备份恢复；如需替换，请先删除它"
        ));
    }

    let mut archive = open_backup_archive(zip_path)?;
    let mut scan_warnings = Vec::new();
    let complete = collect_complete_themes(&mut archive, &mut scan_warnings)?;
    if !complete.contains(theme_id) {
        return Err(
            "备份里没有这套主题，或它的 theme.json 已损坏 / ID 不一致，无法恢复".to_string(),
        );
    }

    paths::ensure_dir(themes_dir)?;
    let result = (|| -> Result<RestoreBackupThemeOutcome, String> {
        let mut budget = limits::ArchiveBudget::new(&limits::BACKUP_LIMITS);
        let mut files = 0usize;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|err| format!("读备份条目失败（{err}）"))?;
            if entry.is_dir() {
                continue;
            }
            let Some(parts) =
                limits::safe_relative_parts(entry.name(), &limits::BACKUP_LIMITS)?
            else {
                continue;
            };
            let Some((id, rel)) = theme_entry(&parts) else {
                continue;
            };
            if id != theme_id {
                continue;
            }

            let target = target_dir.join(&rel);
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
            files += 1;
        }
        if files == 0 {
            return Err("备份里没有这套主题的文件".to_string());
        }

        // 旧备份可能存的是另一台机器 / 另一个根目录的绝对路径：
        // 先按主题 id、再按文件名映射到刚解压出来的文件，和整包恢复同一口径
        let mut warnings = theme_paths::rewrite_theme_file(&target_dir)
            .map_err(|err| format!("恢复出的 theme.json 没能改写为相对路径（{err}）"))?;

        let raw = limits::read_text_bounded(
            &target_dir.join("theme.json"),
            limits::MAX_THEME_JSON_BYTES,
        )
        .map_err(|err| format!("恢复出的主题信息读取失败（{err}）"))?;
        let mut theme: CursorTheme = serde_json::from_str(&raw)
            .map_err(|err| format!("恢复出的 theme.json 解析失败（{err}）"))?;
        if theme.id != theme_id {
            return Err("恢复出的主题 ID 与请求不一致，已拒绝".to_string());
        }
        if theme.is_built_in {
            return Err("备份里的主题自称系统方案，已拒绝恢复".to_string());
        }

        theme_paths::resolve_theme(&mut theme, &target_dir);
        warnings.extend(validation::sanitize_loaded_slots(&mut theme, &target_dir));
        if theme.cursors.is_empty() {
            return Err("备份里的这套主题没有可用的光标槽位".to_string());
        }
        let missing = missing_slot_names(&theme);
        if missing.len() == theme.cursors.len() {
            return Err("备份里的这套主题没有任何可用的光标文件，已拒绝恢复".to_string());
        }
        if !missing.is_empty() {
            warnings.push(format!(
                "恢复后的主题有 {} 个槽位文件缺失（{}），应用时这些槽位会被写成空",
                missing.len(),
                missing.join("、")
            ));
        }
        validation::validate_theme_slots(&theme)
            .map_err(|err| format!("恢复出的主题数据不合法：{err}"))?;
        warnings.extend(theme_paths::write_theme_json(&target_dir, &theme)?);

        Ok(RestoreBackupThemeOutcome { theme, warnings })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&target_dir);
    }
    result
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
                if entry.size() > limits::MAX_STATE_FILE_BYTES {
                    budget.commit(entry.size())?;
                    warnings.push(format!(
                        "备份里的最近使用记录超过 {}KB，已忽略",
                        limits::MAX_STATE_FILE_BYTES / 1024
                    ));
                    continue;
                }
                let cap = budget.allowance().min(limits::MAX_STATE_FILE_BYTES);
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
// 备份历史
// ---------------------------------------------------------------------------

/// 应用内备份的落盘名：手动 `cursorstudio-backup-YYYYMMDD-HHmmss.zip`，
/// 自动备份前缀是 `cursorstudio-backup-auto-`（见 `run_auto_backup`）
///
/// 同一秒内的第二次备份加 `-2`、`-3`……；名字按时间排序就是倒序历史。
fn generate_backup_path(dir: &Path, prefix: &str) -> Result<PathBuf, String> {
    paths::ensure_dir(dir)?;
    let base = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    generate_backup_path_at(dir, prefix, &base)
}

/// 显式时间戳版（测试用固定时间戳，不赌真实时钟跨秒）
fn generate_backup_path_at(dir: &Path, prefix: &str, base: &str) -> Result<PathBuf, String> {
    for suffix in ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"] {
        let candidate = dir.join(format!("{prefix}{base}{suffix}.zip"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("同一秒内创建了太多备份，请稍后再试".to_string())
}

/// 从自动备份文件名里取出完整时间戳段（`YYYYMMDD-HHMMSS`，字典序即时间序）；
/// 不是自动备份或名字不规整返回 None
fn auto_backup_stamp(file_name: &str) -> Option<&str> {
    let rest = file_name.strip_prefix(AUTO_BACKUP_PREFIX)?;
    let stamp = rest.get(0..15)?;
    let well_formed = stamp.as_bytes()[8] == b'-'
        && stamp
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 8 || byte.is_ascii_digit());
    if well_formed { Some(stamp) } else { None }
}

/// 从自动备份文件名里取出日期段（`YYYYMMDD`）；不是自动备份或名字不规整返回 None
fn auto_backup_date(file_name: &str) -> Option<&str> {
    auto_backup_stamp(file_name).map(|stamp| &stamp[..8])
}

/// 今天是否已经有自动备份（按文件名里的日期段判断，不依赖修改时间）
fn has_auto_backup_today(dir: &Path) -> Result<bool, String> {
    if !dir.is_dir() {
        return Ok(false);
    }
    let today = chrono::Local::now().format("%Y%m%d").to_string();
    let entries =
        fs::read_dir(dir).map_err(|err| format!("读备份目录失败（{}：{err}）", dir.display()))?;
    for entry in entries.flatten() {
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.to_ascii_lowercase().ends_with(".zip") {
            continue;
        }
        if auto_backup_date(&name) == Some(today.as_str()) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 清理过期的自动备份：只动 `auto` 前缀条目
///
/// 年龄以**文件名里的时间戳**为准（mtime 在文件被整体拷贝、系统时钟回调时
/// 不可信，会把新备份误判成最旧的删掉），认不出时间戳的当最旧先删；同名
/// 时间戳按修改时间兜底。手动备份是用户亲手做的，一份都不碰；单个文件
/// 删除失败不中断（下次还会再清）。
fn prune_auto_backups(dir: &Path, keep: u32) -> usize {
    if !dir.is_dir() {
        return 0;
    }
    let keep = keep.max(1) as usize;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut autos: Vec<(String, Option<std::time::SystemTime>, PathBuf)> = entries
        .flatten()
        .filter(|entry| !limits::is_reparse_entry(entry))
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(AUTO_BACKUP_PREFIX))
        })
        .filter_map(|path| {
            let name = path.file_name()?.to_string_lossy().into_owned();
            let stamp = auto_backup_stamp(&name).unwrap_or("").to_string();
            let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok();
            Some((stamp, modified, path))
        })
        .collect();
    if autos.len() <= keep {
        return 0;
    }
    autos.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)));
    let surplus = autos.len() - keep;
    autos
        .into_iter()
        .take(surplus)
        .filter(|(_, _, path)| fs::remove_file(path).is_ok())
        .count()
}

/// 自动备份结果：今天是否新建、跳过原因、本次清理掉的过期份数
#[derive(Debug, Serialize)]
pub struct AutoBackupSummary {
    /// 本次是否真的创建了备份
    pub created: bool,
    /// 今天已有自动备份而跳过
    pub skipped: bool,
    /// 本次创建时的落盘文件名（跳过时为 None）
    pub file_name: Option<String>,
    /// 本次顺带清理掉的过期自动备份数
    pub pruned: usize,
}

/// 自动备份的核心（显式路径版，测试全程用临时目录）
fn run_auto_backup_in(
    backups_dir: &Path,
    themes_dir: &Path,
    history_file: &Path,
    keep: u32,
) -> Result<AutoBackupSummary, String> {
    if has_auto_backup_today(backups_dir)? {
        // 当日已有自动备份：不再重打，但顺手清一次过期条目——
        // 用户刚把保留份数调小时能立刻生效，不必等明天
        let pruned = prune_auto_backups(backups_dir, keep);
        return Ok(AutoBackupSummary {
            created: false,
            skipped: true,
            file_name: None,
            pruned,
        });
    }

    let dest = generate_backup_path(backups_dir, AUTO_BACKUP_PREFIX)?;
    // 半成品临时包由 export 内部清理；失败留给前端决定要不要提醒
    export_to_with_progress(&dest, themes_dir, history_file, &mut |_| {})?;
    let pruned = prune_auto_backups(backups_dir, keep);
    Ok(AutoBackupSummary {
        created: true,
        skipped: false,
        file_name: Some(
            dest.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
        ),
        pruned,
    })
}

/// 每天一份的自动备份（决策 32）
///
/// 前端在启动与窗口聚焦时调用（见 `lib/auto-backup.ts`），命令层负责当日去重
/// 与过期清理。不发 `backup-progress`：自动备份不该顶掉手动备份的进度展示；
/// 与手动备份共用同一把重操作锁，同时触发时自动的一方立即失败、由前端静默忽略。
#[tauri::command]
pub async fn run_auto_backup(keep: u32) -> Result<AutoBackupSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("自动备份")?;
        run_auto_backup_in(
            &paths::backups_dir()?,
            &paths::themes_dir()?,
            &paths::history_file()?,
            keep.clamp(1, 100),
        )
    })
    .await
    .map_err(|err| format!("自动备份任务异常退出（{err}）"))?
}

/// 只读 zip 中央目录，统计包内完整主题数（不读条目内容、不解压）
fn count_themes_in(archive: &mut zip::ZipArchive<fs::File>) -> usize {
    let mut ids: HashSet<String> = HashSet::new();
    for index in 0..archive.len() {
        let Ok(entry) = archive.by_index(index) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let Ok(Some(parts)) = limits::safe_relative_parts(entry.name(), &limits::BACKUP_LIMITS)
        else {
            continue;
        };
        if let Some((id, rel)) = theme_entry(&parts) {
            if rel == Path::new("theme.json") {
                ids.insert(id.to_string());
            }
        }
    }
    ids.len()
}

/// 扫描备份目录（只读）：一级 `.zip`，按修改时间倒序，最多 `MAX_BACKUP_ENTRIES` 条
fn list_backups_in(dir: &Path) -> Result<Vec<BackupEntry>, String> {
    if !dir.is_dir() {
        // 目录不存在 = 还没做过应用内备份，历史为空，不是错误
        return Ok(Vec::new());
    }
    let entries =
        fs::read_dir(dir).map_err(|err| format!("读备份目录失败（{}：{err}）", dir.display()))?;

    // 先收集 (修改时间, BackupEntry)：时间拿不到的沉底，不能用字符串排
    //（「未知」的字节序比日期大，字符串倒序会把坏条目顶到最前面）
    let mut items: Vec<(Option<std::time::SystemTime>, BackupEntry)> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                console_fallback_warning(&format!("读取备份目录项失败，已跳过（{err}）"));
                continue;
            }
        };
        // 链接 / 目录联接一律跳过：列表只是展示，也不给删除留入口
        if limits::is_reparse_entry(&entry) {
            continue;
        }
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.to_ascii_lowercase().ends_with(".zip") {
            continue;
        }

        let meta = match fs::metadata(&path) {
            Ok(meta) if meta.is_file() => meta,
            Ok(_) => continue,
            Err(err) => {
                console_fallback_warning(&format!("读备份文件信息失败，已跳过（{err}）"));
                continue;
            }
        };
        let modified = meta.modified().ok();
        let created_at = modified
            .map(|time| {
                chrono::DateTime::<chrono::Local>::from(time)
                    .format("%Y-%m-%d %H:%M")
                    .to_string()
            })
            .unwrap_or_else(|| "未知".to_string());
        let bytes = meta.len();

        // 打不开 / 解析不了的 zip 保留为条目并标记 corrupt——用户要知道
        // 有一个坏备份占着空间，而不是它悄悄从历史里消失
        let (files, themes, status, error) = match fs::File::open(&path)
            .map_err(|err| format!("打不开备份文件（{err}）"))
            .and_then(|file| {
                zip::ZipArchive::new(file).map_err(|err| format!("备份文件不是有效的 zip（{err}）"))
            }) {
            Ok(mut archive) => {
                let files = archive.len();
                let themes = count_themes_in(&mut archive);
                (files, themes, "ok".to_string(), None)
            }
            Err(err) => (0, 0, "corrupt".to_string(), Some(err)),
        };

        items.push((
            modified,
            BackupEntry {
                kind: if file_name.starts_with(AUTO_BACKUP_PREFIX) {
                    "auto".to_string()
                } else {
                    "manual".to_string()
                },
                file_name,
                path: path.to_string_lossy().into_owned(),
                created_at,
                themes,
                files,
                bytes,
                status,
                error,
            },
        ));
    }

    items.sort_by_key(|(stamp, _)| std::cmp::Reverse(*stamp));
    Ok(items
        .into_iter()
        .take(MAX_BACKUP_ENTRIES)
        .map(|(_, entry)| entry)
        .collect())
}

/// 列表阶段的问题只进日志：历史里少一条提示无伤大雅，弹错误反而吓人
fn console_fallback_warning(message: &str) {
    eprintln!("[list_backups] {message}");
}

/// 校验「应用内备份文件名」并拼出完整路径（删除 / 内容预览共用）
///
/// 只收文件名，拒绝任何形式的路径穿越。
fn app_backup_file(file_name: &str, action: &str) -> Result<std::path::PathBuf, String> {
    let name = file_name.trim();
    if name.is_empty() {
        return Err(format!("只能{action}应用内备份：文件名不能为空"));
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("只能{action}应用内备份：请传备份文件名，不要带路径"));
    }
    if !name.to_ascii_lowercase().ends_with(".zip") {
        return Err(format!("只能{action}应用内备份（.zip 文件）"));
    }

    let dir = paths::backups_dir()?;
    let target = dir.join(name);
    // 拼接后的最终位置必须仍落在备份目录内：文件名字符再怪也逃不出去
    if !target.starts_with(&dir) {
        return Err(format!("只能{action}应用内备份"));
    }
    Ok(target)
}

/// 删除应用内备份：只收文件名，拒绝任何形式的路径穿越
fn delete_backup_in(file_name: &str) -> Result<(), String> {
    let target = app_backup_file(file_name, "删除")?;
    // 链接 / 目录联接不删：remove_file 跟随链接，可能删掉目录外的真身
    if limits::is_reparse_path(&target) {
        return Err("备份文件是链接或目录联接，已拒绝删除".to_string());
    }
    if !target.is_file() {
        return Err("备份文件不存在，可能已被删除".to_string());
    }
    fs::remove_file(&target).map_err(|err| format!("删除备份失败（{err}）；文件可能正被占用"))
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 导出全部主题与记录为一个备份 zip
///
/// `dest_path = None` 时写入应用内备份目录 `backups\`（自动命名，见
/// `generate_backup_path`），这类备份会出现在「备份历史」；`Some(path)`
/// 是用户自选落点的导出，不受历史管理。打包在后台线程执行，进度通过
/// `backup-progress` 事件推给界面；导出期间其它重操作会被互斥锁挡住。
#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    dest_path: Option<String>,
) -> Result<ExportBackupSummary, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ExportBackupSummary, String> {
        let _guard = ops::try_begin("导出备份")?;
        let dest = match dest_path.as_deref() {
            Some(path) => validation::validate_dest_path(path, "zip")?,
            None => generate_backup_path(&paths::backups_dir()?, MANUAL_BACKUP_PREFIX)?,
        };
        let emitter = app.clone();
        let mut summary = export_to_with_progress(
            &dest,
            &paths::themes_dir()?,
            &paths::history_file()?,
            &mut |progress| {
                let _ = emitter.emit("backup-progress", progress);
            },
        )?;
        summary.saved_path = dest.to_string_lossy().into_owned();
        summary.bytes = fs::metadata(&dest).map(|meta| meta.len()).unwrap_or(0);
        Ok(summary)
    })
    .await
    .map_err(|err| format!("导出任务异常退出（{err}）"))?
}

/// 列出应用内备份（只读中央目录，不解压），按时间倒序
#[tauri::command]
pub async fn list_backups() -> Result<Vec<BackupEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| list_backups_in(&paths::backups_dir()?))
        .await
        .map_err(|err| format!("读取备份历史任务异常退出（{err}）"))?
}

/// 删除一个应用内备份（只按文件名，不允许越出 `backups\`）
#[tauri::command]
pub async fn delete_backup(file_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_backup_in(&file_name))
        .await
        .map_err(|err| format!("删除备份任务异常退出（{err}）"))?
}

/// 只读备份内容：列出包里能完整恢复的主题（决策 34）
///
/// 只读中央目录与 theme.json，不解压光标、不写任何文件；路径来自备份历史
/// 或用户自选文件，统一走 `validate_source_file`。
#[tauri::command]
pub async fn list_backup_themes(path: String) -> Result<BackupThemeListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = validation::validate_source_file(&path, "zip", "备份文件")?;
        list_backup_themes_in(&source)
    })
    .await
    .map_err(|err| format!("读取备份内容任务异常退出（{err}）"))?
}

/// 从备份里恢复一套主题（决策 34）
///
/// 追加语义：目标 ID 已存在时拒绝；只解压这一套主题，不合并使用记录，
/// 也不影响备份里的其它主题。取 `ops` 锁，避免与导入 / 备份 / 迁移抢目录。
#[tauri::command]
pub async fn restore_theme_from_backup(
    app: AppHandle,
    zip_path: String,
    theme_id: String,
) -> Result<RestoreBackupThemeOutcome, String> {
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("从备份恢复主题")?;
        let source = validation::validate_source_file(&zip_path, "zip", "备份文件")?;
        restore_theme_from_backup_in(&source, &theme_id, &paths::themes_dir()?)
    })
    .await
    .map_err(|err| format!("恢复主题任务异常退出（{err}）"))?;
    // 恢复出的主题带着原 ID：成功后才让托盘菜单多出可用条目（决策 30/34）
    if summary.is_ok() {
        tray::refresh(&app);
    }
    summary
}

/// 从备份 zip 合并恢复（补回缺失，不覆盖已有）
///
/// 与主题包导入共用同一套限额（`utils::limits::BACKUP_LIMITS`）：条目数、
/// 单文件与总解压体积、条目名白名单都在这里生效；超限或写盘失败会删掉
/// 本次新建的主题目录。
#[tauri::command]
pub async fn import_backup(app: AppHandle, zip_path: String) -> Result<ImportBackupSummary, String> {
    let emitter = app.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("恢复备份")?;
        let source = validation::validate_source_file(&zip_path, "zip", "备份文件")?;
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
    .map_err(|err| format!("恢复任务异常退出（{err}）"))?;
    // 备份补回的主题带着原 ID：托盘菜单里可能因此多出可用条目（决策 30）
    tray::refresh(&app);
    summary
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

    /// 完整主题（合法 theme.json + 光标文件），用于内容浏览 / 单主题恢复用例
    fn seed_full_theme(
        themes: &Path,
        id: &str,
        name: &str,
        slots: &[(&str, &str)],
    ) -> PathBuf {
        let dir = themes.join(id);
        fs::create_dir_all(dir.join("cursors")).expect("建主题目录");
        let cursors = slots
            .iter()
            .map(|(key, file)| crate::models::CursorSlot {
                registry_key: (*key).to_string(),
                display_name: (*key).to_string(),
                english_name: (*key).to_string(),
                file_path: dir
                    .join("cursors")
                    .join(file)
                    .to_string_lossy()
                    .into_owned(),
                file_type: file.rsplit('.').next().unwrap_or("cur").to_string(),
            })
            .collect::<Vec<_>>();
        for (_, file) in slots {
            fs::write(dir.join("cursors").join(file), b"cursor").expect("写光标");
        }
        let theme = CursorTheme {
            id: id.to_string(),
            name: name.to_string(),
            description: format!("测试主题 {name}"),
            created_at: "2026-10-01 10:00".to_string(),
            updated_at: "2026-10-01 10:00".to_string(),
            is_built_in: false,
            cursors,
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

    // -----------------------------------------------------------------------
    // 备份历史：列表 / 删除（全部走临时目录，不碰真实 backups\）
    // -----------------------------------------------------------------------

    fn sandbox(name: &str) -> (PathBuf, impl Drop) {
        let data = std::env::temp_dir().join(format!("cursorstudio-backup-history-{name}"));
        let _ = fs::remove_dir_all(&data);
        fs::create_dir_all(&data).expect("建临时数据根");
        // 数据根指向临时目录：backups_dir() 全程只碰这个沙箱
        let guard = paths::use_test_roots(data.clone(), data.join("themes"));
        (data, guard)
    }

    #[test]
    fn 备份目录不存在时历史为空() {
        let (data, _guard) = sandbox("empty");
        let list = list_backups_in(&data.join("backups")).expect("列表");
        assert!(list.is_empty(), "目录不存在应返回空列表");
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 备份历史统计主题与文件数() {
        let (data, _guard) = sandbox("stats");
        let themes = data.join("themes");
        let history_file = data.join("history.json");
        seed_theme(&themes, "77777777-7777-4777-8777-777777777777", "a");
        fs::write(
            &history_file,
            r#"{"version":2,"events":[]}"#,
        )
        .expect("写记录");

        let dest = data.join("backups").join("cursorstudio-backup-test.zip");
        paths::ensure_dir(dest.parent().unwrap()).expect("建备份目录");
        let summary = export_to(&dest, &themes, &history_file).expect("导出");
        let list = list_backups_in(&data.join("backups")).expect("列表");
        assert_eq!(list.len(), 1, "只有一份备份：{:?}", list);
        let entry = &list[0];
        assert_eq!(entry.status, "ok");
        assert_eq!(entry.kind, "manual");
        assert_eq!(entry.themes, 1, "一套主题");
        assert_eq!(entry.files, summary.files, "文件数以中央目录为准");
        assert!(entry.bytes > 0);
        assert!(entry.error.is_none());

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 损坏的_zip_保留为_corrupt_条目() {
        let (data, _guard) = sandbox("corrupt");
        let backups = data.join("backups");
        fs::create_dir_all(&backups).expect("建备份目录");
        // 空文件不是合法 zip：中央目录都读不出来
        fs::write(backups.join("broken.zip"), b"").expect("写坏备份");

        let list = list_backups_in(&backups).expect("列表");
        assert_eq!(list.len(), 1, "坏备份也要出现在历史里");
        let entry = &list[0];
        assert_eq!(entry.status, "corrupt");
        assert_eq!(entry.themes, 0);
        assert_eq!(entry.files, 0);
        assert!(entry.error.is_some(), "要说明打不开的原因");

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 删除备份拒绝路径穿越与非_zip() {
        let (data, _guard) = sandbox("reject");
        let backups = data.join("backups");
        fs::create_dir_all(&backups).expect("建备份目录");

        for evil in ["../evil.zip", "sub/evil.zip", "sub\\evil.zip", "..\\evil.zip", "evil.txt", ""] {
            let err = delete_backup_in(evil).expect_err(evil);
            assert!(err.contains("只能删除应用内备份"), "{evil} 应被拒绝：{err}");
        }
        assert!(!data.parent().unwrap().join("evil.zip").exists());
        assert!(!backups.join("sub").exists(), "不能顺手建目录");

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 删除只影响指定的那份备份() {
        let (data, _guard) = sandbox("delete-one");
        let backups = data.join("backups");
        fs::create_dir_all(&backups).expect("建备份目录");
        let keep = backups.join("cursorstudio-backup-keep.zip");
        let drop = backups.join("cursorstudio-backup-drop.zip");
        fs::write(&keep, b"keep").expect("写备份");
        fs::write(&drop, b"drop").expect("写备份");
        // 非 zip 文件在备份目录里也不该被牵连（历史不展示它，更不能删）
        let note = backups.join("notes.txt");
        fs::write(&note, b"note").expect("写说明文件");

        delete_backup_in("cursorstudio-backup-drop.zip").expect("删除");
        assert!(!drop.exists(), "目标备份应被删除");
        assert!(keep.exists(), "其它备份不能被牵连");
        assert!(note.exists(), "非备份文件不能被牵连");

        let err = delete_backup_in("cursorstudio-backup-drop.zip").expect_err("再删应报错");
        assert!(err.contains("不存在"), "要说明文件已经不在：{err}");

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 应用内备份自动命名并落在备份目录() {
        let (data, _guard) = sandbox("auto-name");
        let backups = data.join("backups");
        let themes = data.join("themes");
        seed_theme(&themes, "88888888-8888-4888-8888-888888888888", "a");

        let first = generate_backup_path(&backups, MANUAL_BACKUP_PREFIX).expect("第一个名字");
        assert!(
            first.to_string_lossy().contains("cursorstudio-backup-"),
            "命名要有统一前缀：{}",
            first.display()
        );
        assert!(first.extension().map(|ext| ext == "zip").unwrap_or(false));
        // 目录不存在时自动创建
        assert!(backups.is_dir());

        // 同秒冲突退避用固定时间戳验证，不赌真实时钟——两次调用跨过秒边界时
        // 时间戳本来就不同，`-2` 断言会随机失败（2026-10-30 零点真挂在 CI 外的手跑里）
        let stamp = "20261030-000214";
        let occupied = backups.join(format!("{MANUAL_BACKUP_PREFIX}{stamp}.zip"));
        fs::write(&occupied, b"occupied").expect("占住当前秒的名字");
        let second =
            generate_backup_path_at(&backups, MANUAL_BACKUP_PREFIX, stamp).expect("第二个名字");
        assert_ne!(second, occupied, "同名冲突必须换名字");
        assert!(
            second.to_string_lossy().contains("-2.zip"),
            "加 -2 后缀：{}",
            second.display()
        );

        let third = {
            // -2 也被占住（上一轮返回的名字落了盘），才会退到 -3
            fs::write(&second, b"occupied").expect("占住 -2 名字");
            generate_backup_path_at(&backups, MANUAL_BACKUP_PREFIX, stamp).expect("第三个名字")
        };
        assert!(
            third.to_string_lossy().contains("-3.zip"),
            "同一秒内继续退避：{}",
            third.display()
        );

        let _ = fs::remove_dir_all(&data);
    }

    // -----------------------------------------------------------------------
    // 自动备份（决策 32）：当日去重 / 过期清理 / kind 判定
    // -----------------------------------------------------------------------

    fn seed_auto_backup(backups: &Path, date: &str, marker: &str) {
        fs::write(
            backups.join(format!("{AUTO_BACKUP_PREFIX}{date}-000000.zip")),
            marker,
        )
        .expect("写自动备份占位文件");
    }

    fn count_auto_backups(backups: &Path) -> usize {
        fs::read_dir(backups)
            .expect("读备份目录")
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(AUTO_BACKUP_PREFIX)
            })
            .count()
    }

    #[test]
    fn 自动备份当日只打一份且跳过时顺带清理() {
        let (data, _guard) = sandbox("auto-dedupe");
        let themes = data.join("themes");
        seed_theme(&themes, "99999999-9999-4999-8999-999999999999", "a");
        let backups = data.join("backups");

        let first = run_auto_backup_in(&backups, &themes, &data.join("history.json"), 10)
            .expect("第一次自动备份");
        assert!(first.created);
        assert!(!first.skipped);
        assert!(
            first
                .file_name
                .as_deref()
                .is_some_and(|name| name.starts_with(AUTO_BACKUP_PREFIX)),
            "自动备份文件名要带 auto 前缀：{:?}",
            first.file_name
        );
        assert_eq!(count_auto_backups(&backups), 1);

        // 同日再触发：不再重打（打 zip 有成本，也没必要一天很多份）
        let second = run_auto_backup_in(&backups, &themes, &data.join("history.json"), 10)
            .expect("第二次自动备份");
        assert!(!second.created);
        assert!(second.skipped, "当日去重");
        assert_eq!(count_auto_backups(&backups), 1, "去重不应新增文件");

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 自动备份清理过期只动_auto_条目() {
        let (data, _guard) = sandbox("auto-prune");
        let themes = data.join("themes");
        seed_theme(&themes, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a");
        fs::write(data.join("history.json"), r#"{"version":2,"events":[]}"#).expect("写记录");
        let backups = data.join("backups");
        fs::create_dir_all(&backups).expect("建备份目录");

        // 三份过期的自动备份 + 一份手动备份
        for date in ["20200101", "20200102", "20200103"] {
            seed_auto_backup(&backups, date, "old");
        }
        let manual = backups.join("cursorstudio-backup-20200101-000000.zip");
        fs::write(&manual, b"manual").expect("写手动备份");

        let summary =
            run_auto_backup_in(&backups, &themes, &data.join("history.json"), 2).expect("自动备份");
        assert!(summary.created);
        // 4 份自动备份（3 旧 + 本次新建）只留最新 2 份；手动备份不动。
        // 年龄按文件名时间戳算：占位文件哪怕写入更晚（mtime 更新）也不能把
        // 当天真备份挤进"最旧"里——这正是清理排序必须看文件名的原因
        assert_eq!(summary.pruned, 2, "要清到保留份数：{}", summary.pruned);
        assert_eq!(count_auto_backups(&backups), 2);
        assert!(manual.exists(), "手动备份绝不能被牵连");
        let today = chrono::Local::now().format("%Y%m%d").to_string();
        let survivors: Vec<String> = fs::read_dir(&backups)
            .expect("读备份目录")
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(AUTO_BACKUP_PREFIX)
            })
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            survivors.iter().any(|name| auto_backup_date(name) == Some(today.as_str())),
            "当天备份必须幸存：{:?}",
            survivors
        );
        assert!(
            survivors
                .iter()
                .all(|name| name.contains("20200103") || auto_backup_date(name) == Some(today.as_str())),
            "被删的必须是文件名最旧的（20200101/02），留下的是 20200103 + 当天：{:?}",
            survivors
        );

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 备份历史区分自动与手动条目() {
        let (data, _guard) = sandbox("auto-kind");
        let backups = data.join("backups");
        fs::create_dir_all(&backups).expect("建备份目录");
        seed_auto_backup(&backups, "20200101", "auto");
        fs::write(backups.join("cursorstudio-backup-manual.zip"), b"manual").expect("写手动备份");

        let list = list_backups_in(&backups).expect("列表");
        assert_eq!(list.len(), 2);
        for entry in &list {
            let expected = if entry.file_name.starts_with(AUTO_BACKUP_PREFIX) {
                "auto"
            } else {
                "manual"
            };
            assert_eq!(entry.kind, expected, "kind 要按文件名前缀判定：{}", entry.file_name);
        }

        let _ = fs::remove_dir_all(&data);
    }

    // -----------------------------------------------------------------------
    // 备份内容浏览与单主题恢复（决策 34）
    // -----------------------------------------------------------------------

    const THEME_ALPHA: &str = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const THEME_BETA: &str = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

    fn export_sample_backup(data: &Path, themes: &Path) -> PathBuf {
        let backups = data.join("backups");
        paths::ensure_dir(&backups).expect("建备份目录");
        let zip = backups.join("content.zip");
        export_to(&zip, themes, &data.join("history.json")).expect("导出备份");
        zip
    }

    #[test]
    fn 备份内容能列出主题与体积() {
        let (data, _guard) = sandbox("content-list");
        let themes = data.join("themes");
        seed_full_theme(
            &themes,
            THEME_ALPHA,
            "Alpha",
            &[("Arrow", "arrow.cur"), ("Wait", "busy.cur")],
        );
        seed_full_theme(&themes, THEME_BETA, "Beta", &[("Arrow", "arrow.cur")]);
        let zip = export_sample_backup(&data, &themes);

        let listing = list_backup_themes_in(&zip).expect("列出备份内容");
        assert_eq!(listing.themes.len(), 2, "warnings: {:?}", listing.warnings);
        assert!(listing.warnings.is_empty(), "正常备份不该有提示：{:?}", listing.warnings);

        let alpha = listing
            .themes
            .iter()
            .find(|theme| theme.id == THEME_ALPHA)
            .expect("应列出 Alpha");
        assert_eq!(alpha.name, "Alpha");
        assert_eq!(alpha.slots, 2);
        assert_eq!(alpha.files, 3, "两个光标 + theme.json");
        assert_eq!(alpha.missing_files, 0, "文件齐全时不应报缺口");
        assert!(alpha.bytes > 0, "体积应来自中央目录声明值");

        let beta = listing
            .themes
            .iter()
            .find(|theme| theme.id == THEME_BETA)
            .expect("应列出 Beta");
        assert_eq!(beta.slots, 1);
        assert_eq!(beta.files, 2, "一个光标 + theme.json");
        assert_eq!(beta.missing_files, 0, "文件齐全时不应报缺口");

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 从备份恢复单套主题且不碰其它主题() {
        let (data, _guard) = sandbox("restore-one");
        let themes = data.join("themes");
        seed_full_theme(
            &themes,
            THEME_ALPHA,
            "Alpha",
            &[("Arrow", "arrow.cur"), ("Wait", "busy.cur")],
        );
        seed_full_theme(&themes, THEME_BETA, "Beta", &[("Arrow", "arrow.cur")]);
        let zip = export_sample_backup(&data, &themes);

        let restored_dir = data.join("restored");
        let outcome =
            restore_theme_from_backup_in(&zip, THEME_ALPHA, &restored_dir).expect("恢复单套主题");
        assert_eq!(outcome.theme.id, THEME_ALPHA);
        assert_eq!(outcome.theme.cursors.len(), 2);
        assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);
        assert!(
            outcome.theme.cursors.iter().all(|slot| Path::new(&slot.file_path).is_absolute()),
            "返回给前端的主题应是运行时绝对路径"
        );

        let theme_dir = restored_dir.join(THEME_ALPHA);
        assert!(theme_dir.join("cursors").join("arrow.cur").is_file());
        assert!(theme_dir.join("cursors").join("busy.cur").is_file());
        assert!(
            !restored_dir.join(THEME_BETA).exists(),
            "只恢复选中的那一套，其它主题不能被解压"
        );

        let saved: CursorTheme = serde_json::from_str(
            &fs::read_to_string(theme_dir.join("theme.json")).expect("读恢复后的主题"),
        )
        .expect("解析恢复后的主题");
        assert!(
            saved.cursors.iter().all(|slot| !Path::new(&slot.file_path).is_absolute()),
            "落盘仍必须是相对路径：{:?}",
            saved
                .cursors
                .iter()
                .map(|slot| slot.file_path.as_str())
                .collect::<Vec<_>>()
        );
        let resolved = theme_paths::resolve(&saved.cursors[0].file_path, &theme_dir);
        assert!(Path::new(&resolved).is_file(), "相对路径应能指向新根目录");

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 旧备份的绝对路径单主题恢复后指向新根() {
        let (data, _guard) = sandbox("restore-legacy");
        let zip = data.join("legacy.zip");
        let theme_id = "ffffffff-6666-4666-8666-ffffffffffff";
        let old_path = format!(r"C:\old\themes\{theme_id}\cursors\arrow.cur");
        let theme = CursorTheme {
            id: theme_id.to_string(),
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
                format!("themes/{theme_id}/theme.json"),
                serde_json::to_string_pretty(&theme).unwrap().into_bytes(),
            ),
            (
                format!("themes/{theme_id}/cursors/arrow.cur"),
                b"cursor".to_vec(),
            ),
        ] {
            writer.start_file(name, options).expect("写条目");
            writer.write_all(&data).expect("写数据");
        }
        writer.finish().expect("完成压缩");

        let restored_dir = data.join("restored");
        let outcome = restore_theme_from_backup_in(&zip, theme_id, &restored_dir)
            .expect("旧备份也能恢复单套主题");

        let theme_dir = restored_dir.join(theme_id);
        let expected = theme_dir.join("cursors").join("arrow.cur");
        assert_eq!(
            Path::new(&outcome.theme.cursors[0].file_path),
            expected,
            "旧绝对路径要按主题 id 映射到新根目录"
        );
        assert!(expected.is_file());

        let saved: CursorTheme = serde_json::from_str(
            &fs::read_to_string(theme_dir.join("theme.json")).expect("读恢复后的主题"),
        )
        .expect("解析恢复后的主题");
        assert_eq!(
            saved.cursors[0].file_path, "cursors/arrow.cur",
            "落盘必须是相对路径"
        );

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 单主题恢复在目标已存在时拒绝且不碰原目录() {
        let (data, _guard) = sandbox("restore-exists");
        let themes = data.join("themes");
        seed_full_theme(&themes, THEME_ALPHA, "Alpha", &[("Arrow", "arrow.cur")]);
        let zip = export_sample_backup(&data, &themes);

        let restored_dir = data.join("restored");
        let existing = restored_dir.join(THEME_ALPHA);
        fs::create_dir_all(&existing).expect("预置同 ID 目录");
        fs::write(existing.join("marker.txt"), b"keep").expect("写标记");

        let err = restore_theme_from_backup_in(&zip, THEME_ALPHA, &restored_dir)
            .expect_err("目标已存在应拒绝");
        assert!(err.contains("已有同 ID"), "实际：{err}");
        assert_eq!(
            fs::read(existing.join("marker.txt")).expect("原目录应保留"),
            b"keep".to_vec(),
            "拒绝时不能改名或清空用户已有的同 ID 目录"
        );

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 单主题恢复找不到主题时报错且不留目录() {
        let (data, _guard) = sandbox("restore-missing");
        let themes = data.join("themes");
        seed_full_theme(&themes, THEME_ALPHA, "Alpha", &[("Arrow", "arrow.cur")]);
        let zip = export_sample_backup(&data, &themes);

        let restored_dir = data.join("restored");
        let missing = "cccccccc-3333-4333-8333-cccccccccccc";
        let err = restore_theme_from_backup_in(&zip, missing, &restored_dir)
            .expect_err("备份里没有的主题应拒绝");
        assert!(err.contains("没有这套主题"), "实际：{err}");
        assert!(!restored_dir.join(missing).exists(), "不能留下空目录");

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 零槽位主题可列出但恢复失败并清理() {
        let (data, _guard) = sandbox("restore-empty");
        let themes = data.join("themes");
        let empty_id = "dddddddd-4444-4444-8444-dddddddddddd";
        seed_full_theme(&themes, empty_id, "Empty", &[]);
        let zip = export_sample_backup(&data, &themes);

        let listing = list_backup_themes_in(&zip).expect("列出内容");
        assert_eq!(listing.themes.len(), 1);
        assert_eq!(listing.themes[0].slots, 0);
        assert_eq!(listing.themes[0].files, 1, "只剩 theme.json");
        assert_eq!(listing.themes[0].missing_files, 0, "没有声明槽位就不算缺文件");

        let restored_dir = data.join("restored");
        let err = restore_theme_from_backup_in(&zip, empty_id, &restored_dir)
            .expect_err("零槽位主题不能恢复");
        assert!(err.contains("没有可用的光标槽位"), "实际：{err}");
        assert!(
            !restored_dir.join(empty_id).exists(),
            "失败后必须清理半成品主题目录"
        );

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 备份内容标出缺文件主题且恢复后提示缺口() {
        let (data, _guard) = sandbox("content-partial");
        let themes = data.join("themes");
        seed_full_theme(
            &themes,
            THEME_ALPHA,
            "Alpha",
            &[("Arrow", "arrow.cur"), ("Wait", "busy.cur")],
        );
        fs::remove_file(themes.join(THEME_ALPHA).join("cursors").join("busy.cur"))
            .expect("删掉一个光标，模拟备份包内文件缺失");
        let zip = export_sample_backup(&data, &themes);

        let listing = list_backup_themes_in(&zip).expect("列出内容");
        let alpha = listing
            .themes
            .iter()
            .find(|theme| theme.id == THEME_ALPHA)
            .expect("应列出 Alpha");
        assert_eq!(alpha.slots, 2);
        assert_eq!(alpha.files, 2, "只剩一个光标 + theme.json");
        assert_eq!(alpha.missing_files, 1, "声明了两个槽位，包里只有一个文件");

        let restored = restore_theme_from_backup_in(&zip, THEME_ALPHA, &data.join("restored"))
            .expect("部分缺文件仍可按套恢复");
        assert_eq!(restored.theme.cursors.len(), 2, "缺口槽位要保留，交给完整性体检展示");
        assert!(
            restored
                .warnings
                .iter()
                .any(|warning| warning.contains("1 个槽位文件缺失") && warning.contains("Wait")),
            "恢复结果要点名缺口：{:?}",
            restored.warnings
        );

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 全缺文件主题恢复失败并清理() {
        let (data, _guard) = sandbox("content-no-files");
        let themes = data.join("themes");
        seed_full_theme(&themes, THEME_ALPHA, "Alpha", &[("Arrow", "arrow.cur")]);
        fs::remove_file(themes.join(THEME_ALPHA).join("cursors").join("arrow.cur"))
            .expect("删掉唯一光标");
        let zip = export_sample_backup(&data, &themes);

        let listing = list_backup_themes_in(&zip).expect("列出内容");
        assert_eq!(listing.themes[0].slots, 1);
        assert_eq!(listing.themes[0].missing_files, 1);

        let restored_dir = data.join("restored");
        let err = restore_theme_from_backup_in(&zip, THEME_ALPHA, &restored_dir)
            .expect_err("没有任何可用文件应拒绝");
        assert!(err.contains("没有任何可用"), "实际：{err}");
        assert!(
            !restored_dir.join(THEME_ALPHA).exists(),
            "失败后必须清理半成品主题目录"
        );

        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn 损坏备份读取内容与恢复都报人话() {
        let (data, _guard) = sandbox("content-corrupt");
        let backups = data.join("backups");
        paths::ensure_dir(&backups).expect("建备份目录");
        let zip = backups.join("broken.zip");
        fs::write(&zip, b"not a zip").expect("写坏备份");

        let err = list_backup_themes_in(&zip).expect_err("坏备份不能列出内容");
        assert!(err.contains("不是有效的 zip"), "实际：{err}");
        let err = restore_theme_from_backup_in(
            &zip,
            "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
            &data.join("restored"),
        )
        .expect_err("坏备份不能恢复");
        assert!(err.contains("不是有效的 zip"), "实际：{err}");

        let _ = fs::remove_dir_all(&data);
    }
}
