//! 把注册表里当前生效的光标捕获为「我的主题」
//!
//! 使用场景：用户在系统设置或其它工具里换过光标，本应用只能看到
//! 「被系统设置修改」，这套文件没有主人；一旦应用别的主题就找不回来。
//! 捕获会把当前非空槽位的光标文件复制到新的主题目录，写成相对路径的
//! `theme.json`，再由命令层决定是否立即应用。
//!
//! 约束：沿用主题包的 20MB 单文件 / 50MB 总量上限；不可用、非光标文件、
//! 空文件与超过上限的槽位**跳过并 warning**，一个都抄不下来才整体失败。
//! 同一源文件被多个槽位引用时只复制一次，避免 15 份大 `.ani` 重复占空间。

use std::collections::HashMap;
use std::fs::{self, File};
use std::path::Path;

use serde::Serialize;
use uuid::Uuid;

use crate::models::{CursorSlot, CursorTheme};
use crate::utils::{limits, paths, registry, theme_paths, validation};

/// 捕获结果：新主题 + 被跳过的槽位说明
#[derive(Debug, Serialize)]
pub struct CaptureReport {
    pub theme: CursorTheme,
    pub warnings: Vec<String>,
    /// 实际写进主题目录的光标文件数（同一源文件多槽位复用只算 1）
    pub file_count: usize,
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn slot_names(slot_key: &str) -> (String, String) {
    registry::SLOT_DEFS
        .iter()
        .find(|(key, _, _)| *key == slot_key)
        .map(|(_, cn, en)| (cn.to_string(), en.to_string()))
        .unwrap_or_else(|| (slot_key.to_string(), slot_key.to_string()))
}

/// 从注册表读出的 `(槽位键, 文件路径)` 生成一套新用户主题
pub fn capture_current(slots: &[(String, String)]) -> Result<CaptureReport, String> {
    if slots.is_empty() {
        return Err("当前是系统默认光标，没有可保存的自定义光标".to_string());
    }

    let id = Uuid::new_v4().to_string();
    let theme_dir = paths::theme_dir(&id)?;
    paths::ensure_dir(&theme_dir.join("cursors"))?;

    match write_captured(&id, &theme_dir, slots) {
        Ok(report) => Ok(report),
        Err(err) => {
            // 与导入一致：失败连半成品目录一起清掉，不留下扫不出来源的空主题
            let _ = fs::remove_dir_all(&theme_dir);
            Err(err)
        }
    }
}

fn write_captured(
    id: &str,
    theme_dir: &Path,
    slots: &[(String, String)],
) -> Result<CaptureReport, String> {
    let mut budget = limits::ArchiveBudget::new(&limits::THEME_LIMITS);
    // 源文件路径（小写）→ 主题内相对路径；同一文件被多个槽位引用只复制一次
    let mut copied: HashMap<String, String> = HashMap::new();
    let mut cursors = Vec::new();
    let mut warnings = Vec::new();
    let mut file_count = 0usize;

    for (slot_key, raw_path) in slots {
        if !validation::is_known_slot(slot_key) {
            warnings.push(format!("跳过未知槽位「{slot_key}」"));
            continue;
        }
        let (display_name, english_name) = slot_names(slot_key);
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            continue;
        }

        let source = match fs::canonicalize(trimmed) {
            Ok(path) => path,
            Err(err) => {
                warnings.push(format!(
                    "「{display_name}」的光标文件不可用，已跳过（{err}）：{trimmed}"
                ));
                continue;
            }
        };
        if !source.is_file() {
            warnings.push(format!("「{display_name}」的路径不是文件，已跳过"));
            continue;
        }
        let Some(ext) = source
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
        else {
            warnings.push(format!("「{display_name}」没有文件扩展名，已跳过"));
            continue;
        };
        if !validation::is_cursor_extension(&ext) {
            warnings.push(format!("「{display_name}」不是 .cur / .ani / .ico 文件，已跳过"));
            continue;
        }
        let size = match fs::metadata(&source) {
            Ok(meta) => meta.len(),
            Err(err) => {
                warnings.push(format!("「{display_name}」读不到文件信息，已跳过（{err}）"));
                continue;
            }
        };
        if size == 0 {
            warnings.push(format!("「{display_name}」的光标文件是空的，已跳过"));
            continue;
        }
        if size > limits::MAX_CURSOR_FILE_BYTES {
            warnings.push(format!(
                "「{display_name}」超过 {}MB 上限，已跳过",
                limits::MAX_CURSOR_FILE_BYTES / 1024 / 1024
            ));
            continue;
        }

        let source_key = source.to_string_lossy().to_lowercase();
        let relative = if let Some(existing) = copied.get(&source_key) {
            existing.clone()
        } else {
            let file_name = format!("{}.{ext}", slot_key.to_lowercase());
            let relative = format!("cursors/{file_name}");
            let dest = theme_dir.join("cursors").join(&file_name);
            let cap = budget.allowance();
            if size > cap {
                return Err(format!(
                    "当前光标文件总量超过 {} 上限，已停止保存",
                    limits::THEME_LIMITS.total_hint()
                ));
            }
            let mut reader = match File::open(&source) {
                Ok(file) => file,
                Err(err) => {
                    warnings.push(format!("「{display_name}」的文件读不出来，已跳过（{err}）"));
                    continue;
                }
            };
            let mut writer =
                File::create(&dest).map_err(|err| format!("创建主题文件失败（{err}）"))?;
            budget.note_entry()?;
            let written =
                limits::copy_bounded(&mut reader, &mut writer, cap, &limits::THEME_LIMITS)?;
            budget.commit(written)?;
            if written != size {
                return Err(format!(
                    "复制「{display_name}」时文件大小发生变化（应为 {size} 字节，实际 {written} 字节）"
                ));
            }
            copied.insert(source_key, relative.clone());
            file_count += 1;
            relative
        };

        cursors.push(CursorSlot {
            registry_key: slot_key.clone(),
            display_name,
            english_name,
            file_path: theme_dir.join(&relative).to_string_lossy().into_owned(),
            file_type: ext,
        });
    }

    if cursors.is_empty() {
        return Err("当前光标文件都不可用，没能保存为我的主题".to_string());
    }

    let now = now_string();
    let mut theme = CursorTheme {
        id: id.to_string(),
        name: format!("当前光标 {now}"),
        description: String::new(),
        created_at: now.clone(),
        updated_at: now,
        is_built_in: false,
        cursors,
    };
    warnings.extend(
        theme_paths::write_theme_json(theme_dir, &theme)
            .map_err(|err| format!("保存主题信息失败（{err}）"))?,
    );
    theme_paths::resolve_theme(&mut theme, theme_dir);

    Ok(CaptureReport {
        theme,
        warnings,
        file_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::test_support::{fixture_ani, fixture_cur, TempDir};

    fn external_file(root: &TempDir, name: &str, bytes: Vec<u8>) -> String {
        let path = root.join(name);
        fs::write(&path, bytes).expect("写外部光标 fixture");
        path.to_string_lossy().into_owned()
    }

    fn slots(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, path)| ((*key).to_string(), (*path).to_string()))
            .collect()
    }

    #[test]
    fn 捕获当前光标会复制文件并写相对路径() {
        let root = TempDir::new("capture-basic");
        let _guard = root.isolate_paths();
        let arrow = external_file(&root, "外部-arrow.cur", fixture_cur());
        let wait = external_file(&root, "外部-busy.ani", fixture_ani());

        let report = capture_current(&slots(&[("Arrow", &arrow), ("Wait", &wait)]))
            .expect("捕获应成功");

        assert_eq!(report.file_count, 2);
        assert!(report.warnings.is_empty());
        assert_eq!(report.theme.cursors.len(), 2);
        assert!(report.theme.name.starts_with("当前光标 "));
        assert!(!report.theme.is_built_in);
        let theme_dir = paths::theme_dir(&report.theme.id).expect("解析新主题目录");
        assert!(theme_dir.join("cursors").join("arrow.cur").is_file());
        assert!(theme_dir.join("cursors").join("wait.ani").is_file());
        assert!(report
            .theme
            .cursors
            .iter()
            .all(|slot| Path::new(&slot.file_path).starts_with(&theme_dir)));

        let raw = fs::read_to_string(theme_dir.join("theme.json")).expect("读 theme.json");
        let stored: CursorTheme = serde_json::from_str(&raw).expect("解析 theme.json");
        assert_eq!(stored.cursors[0].file_path, "cursors/arrow.cur", "磁盘必须存相对路径");
        assert_eq!(stored.cursors[1].file_path, "cursors/wait.ani");
    }

    #[test]
    fn 同一源文件多槽位只复制一份() {
        let root = TempDir::new("capture-dedupe");
        let _guard = root.isolate_paths();
        let shared = external_file(&root, "shared.cur", fixture_cur());

        let report = capture_current(&slots(&[("Arrow", &shared), ("Wait", &shared)]))
            .expect("捕获应成功");

        assert_eq!(report.file_count, 1, "同一源文件只应复制一次");
        assert_eq!(report.theme.cursors.len(), 2);
        assert_eq!(
            report.theme.cursors[0].file_path, report.theme.cursors[1].file_path,
            "两个槽位应复用同一份主题内文件"
        );
        let theme_dir = paths::theme_dir(&report.theme.id).expect("解析目录");
        assert_eq!(
            fs::read_dir(theme_dir.join("cursors")).expect("列目录").count(),
            1
        );
    }

    #[test]
    fn 不可用槽位会跳过并警告() {
        let root = TempDir::new("capture-skip");
        let _guard = root.isolate_paths();
        let good = external_file(&root, "good.cur", fixture_cur());
        let missing = root.join("不存在.cur").to_string_lossy().into_owned();
        let not_cursor = external_file(&root, "notes.txt", b"hello".to_vec());

        let report = capture_current(&slots(&[
            ("Arrow", &good),
            ("Wait", &missing),
            ("Hand", &not_cursor),
        ]))
        .expect("至少有一个可用槽位就应保存成功");

        assert_eq!(report.file_count, 1);
        assert_eq!(report.theme.cursors.len(), 1);
        assert_eq!(report.warnings.len(), 2, "缺失与错误扩展名各一条");
        assert!(report.warnings.iter().any(|warning| warning.contains("不可用")));
        assert!(report.warnings.iter().any(|warning| warning.contains("不是 .cur")));
    }

    #[test]
    fn 全部槽位不可用时清理半成品目录() {
        let root = TempDir::new("capture-empty");
        let _guard = root.isolate_paths();
        let missing = root.join("不存在.cur").to_string_lossy().into_owned();

        let err = capture_current(&slots(&[("Arrow", &missing)])).unwrap_err();
        assert!(err.contains("都不可用"), "实际：{err}");
        let themes_dir = paths::themes_dir().expect("主题目录");
        assert_eq!(
            fs::read_dir(&themes_dir).expect("列主题目录").count(),
            0,
            "失败不能留下半成品主题目录"
        );

        let err = capture_current(&[]).unwrap_err();
        assert!(err.contains("系统默认"), "实际：{err}");
    }
}
