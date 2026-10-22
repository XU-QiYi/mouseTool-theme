//! 主题存储目录：默认 `<数据目录>\themes`，用户可改（改时把现有主题搬过去）
//!
//! 解析的唯一来源仍是 `paths::themes_dir()`（它读这里的自定义值）；本模块
//! 负责「换目录」这件事本身：校验 → 搬运 → 落盘设置。**搬运成功之前不改
//! 设置**，中途失败源目录完好，界面不会指向一个空目录。

use std::fs;
use std::path::{Path, PathBuf};

use crate::utils::{paths, settings};

/// 解析目标目录；`raw` 为 None 表示回默认
fn resolve_target(raw: Option<&str>, data_root: &Path) -> Result<PathBuf, String> {
    let Some(raw) = raw else {
        return Ok(data_root.join("themes"));
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("目录路径不能为空".to_string());
    }
    let target = PathBuf::from(trimmed);
    // 数据目录本身（或它的上层）混着 history.json / settings.json，
    // 当主题目录会被扫描逻辑当成一堆坏主题
    if target == data_root || data_root.starts_with(&target) {
        return Err("不能把数据目录本身或它的上层目录设为主题存储目录".to_string());
    }
    Ok(target)
}

/// 把一个条目移到新位置：同卷改名，跨卷复制 + 删除
fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        // 目标已有同名条目：以源为准（搬家前的目标内容视为过期副本）
        let removed = if to.is_dir() {
            fs::remove_dir_all(to)
        } else {
            fs::remove_file(to)
        };
        removed.map_err(|err| format!("清理目标同名项失败（{err}）"))?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // 跨卷 rename 会失败：复制整棵树再删源
    if from.is_dir() {
        copy_dir_all(from, to)?;
        fs::remove_dir_all(from).map_err(|err| format!("删除原目录失败（{err}）"))
    } else {
        fs::copy(from, to).map_err(|err| format!("复制文件失败（{err}）"))?;
        fs::remove_file(from).map_err(|err| format!("删除原文件失败（{err}）"))
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|err| format!("创建目录失败（{err}）"))?;
    let entries =
        fs::read_dir(from).map_err(|err| format!("读目录失败（{}：{err}）", from.display()))?;
    for entry in entries.flatten() {
        let child_from = entry.path();
        let child_to = to.join(entry.file_name());
        if child_from.is_dir() {
            copy_dir_all(&child_from, &child_to)?;
        } else {
            fs::copy(&child_from, &child_to)
                .map_err(|err| format!("复制文件失败（{err}）"))?;
        }
    }
    Ok(())
}

/// 搬运主题目录的内容：逐条目移动，中途失败把已搬的挪回去（尽力回滚）
fn migrate(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        // 一次都没导入过：没有可搬的，建好目标即可
        return paths::ensure_dir(to);
    }
    if from == to {
        return Ok(());
    }
    // 互为子目录会越搬越乱（搬进去又扫出来）
    if to.starts_with(from) || from.starts_with(to) {
        return Err("新目录不能是原目录的子目录（或反过来）".to_string());
    }

    paths::ensure_dir(to)?;
    let entries =
        fs::read_dir(from).map_err(|err| format!("读原主题目录失败（{err}）"))?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let child_from = entry.path();
        let child_to = to.join(entry.file_name());
        if let Err(err) = move_path(&child_from, &child_to) {
            // 尽力回滚：搬回去的失败只记日志，主错误照实抛
            for (back_from, back_to) in moved.iter().rev() {
                if let Err(back_err) = move_path(back_from, back_to) {
                    eprintln!(
                        "[themes_dir] 回滚失败：{} → {}（{back_err}）",
                        back_from.display(),
                        back_to.display()
                    );
                }
            }
            return Err(format!("搬运主题失败（{err}）；原目录未改动"));
        }
        moved.push((child_to, child_from));
    }

    // 源目录应已空；残留（极端情况）不删，留给用户自己看
    let _ = fs::remove_dir(from);
    Ok(())
}

/// 更换主题存储目录并落盘设置；`None` = 回默认。返回实际生效的目录
pub fn change(new_dir: Option<String>) -> Result<String, String> {
    let data_root = paths::data_root();
    let target = resolve_target(new_dir.as_deref(), &data_root)?;
    let current = paths::themes_dir();

    migrate(&current, &target)?;

    let mut state = settings::read();
    state.themes_dir = new_dir;
    settings::write(&state)?;

    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cursorstudio-themes-dir-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn 目标解析拒绝数据目录与其上层() {
        let data_root = PathBuf::from(r"C:\Users\me\AppData\Local\CursorStudio");
        assert!(resolve_target(None, &data_root).unwrap().ends_with("themes"));
        assert!(resolve_target(Some("  "), &data_root).is_err());
        assert!(resolve_target(Some(r"C:\Users\me\AppData\Local\CursorStudio"), &data_root).is_err());
        assert!(resolve_target(Some(r"C:\Users\me\AppData\Local"), &data_root).is_err());
        // 数据目录的子目录可以（自定义落点的常见选择）
        assert!(resolve_target(Some(r"C:\Users\me\AppData\Local\CursorStudio\my"), &data_root).is_ok());
        assert!(resolve_target(Some(r"D:\Cursors"), &data_root).is_ok());
    }

    #[test]
    fn 搬运把全部条目移过去且不留源() {
        let root = temp_root("migrate");
        let from = root.join("from");
        let to = root.join("to");
        fs::create_dir_all(from.join("t1").join("cursors")).expect("建源结构");
        fs::write(from.join("t1").join("theme.json"), "{}").expect("写 theme.json");
        fs::write(from.join("t1").join("cursors").join("arrow.cur"), "x").expect("写光标");

        migrate(&from, &to).expect("搬运");

        assert!(to.join("t1").join("theme.json").exists(), "内容应在新目录");
        assert!(to.join("t1").join("cursors").join("arrow.cur").exists());
        assert!(!from.exists(), "源目录应被清掉");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 互为子目录的搬运被拒绝() {
        let root = temp_root("nested");
        let from = root.join("a");
        fs::create_dir_all(&from).expect("建源");
        assert!(migrate(&from, &from.join("sub")).is_err());
        assert!(migrate(&from, &root).is_err(), "目标是源的上层也应拒绝");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 源不存在时只建目标目录() {
        let root = temp_root("empty");
        let to = root.join("fresh");
        migrate(&root.join("nope"), &to).expect("无源搬运");
        assert!(to.exists());
        let _ = fs::remove_dir_all(&root);
    }
}
