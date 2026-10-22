use std::collections::HashSet;
use std::fs::{self, File};
use std::io::copy;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::models::{CursorSlot, CursorTheme};
use crate::utils::{paths, registry};

/// 单个主题包大小上限：50MB
const MAX_ZIP_BYTES: u64 = 50 * 1024 * 1024;

/// 文件名关键字 → 槽位键名
///
/// 顺序即优先级：越靠前越先匹配，所以 `arrow_up` 会先命中 `UpArrow` 而不是 `Arrow`。
const SLOT_KEYWORDS: &[(&str, &[&str])] = &[
    ("UpArrow", &["uparrow", "up_arrow", "arrow_up", "alternate"]),
    ("NWPen", &["nwpen", "pen", "handwriting"]),
    ("AppStarting", &["working", "appstart", "background"]),
    ("Wait", &["busy", "wait"]),
    ("Help", &["help"]),
    ("Crosshair", &["cross", "precision"]),
    ("IBeam", &["ibeam", "beam", "text"]),
    ("No", &["unavail", "forbidden", "notallowed"]),
    ("SizeNS", &["sizens", "vertical", "vert"]),
    ("SizeWE", &["sizewe", "horizontal", "horz"]),
    ("SizeNWSE", &["nwse", "dgn1", "diag1"]),
    ("SizeNESW", &["nesw", "dgn2", "diag2"]),
    ("SizeAll", &["sizeall", "move"]),
    ("Hand", &["hand", "link"]),
    ("Arrow", &["arrow", "pointer", "normal", "default"]),
];

/// 文件名 **完全等于** 这些值时直接定槽位
///
/// 短名字（no / ns / we / up）不能塞进关键字表做包含匹配，否则 `no` 会撞上
/// `normal`、`up` 会撞上 `upload`。所以先精确匹配一遍再走关键字。
const EXACT_NAMES: &[(&str, &str)] = &[
    ("arrow", "Arrow"),
    ("pointer", "Arrow"),
    ("working", "AppStarting"),
    ("work", "AppStarting"),
    ("busy", "Wait"),
    ("wait", "Wait"),
    ("help", "Help"),
    ("cross", "Crosshair"),
    ("beam", "IBeam"),
    ("text", "IBeam"),
    ("pen", "NWPen"),
    ("no", "No"),
    ("unavailable", "No"),
    ("ns", "SizeNS"),
    ("vert", "SizeNS"),
    ("we", "SizeWE"),
    ("horz", "SizeWE"),
    ("nwse", "SizeNWSE"),
    ("nesw", "SizeNESW"),
    ("move", "SizeAll"),
    ("all", "SizeAll"),
    ("up", "UpArrow"),
    ("hand", "Hand"),
    ("link", "Hand"),
];

/// 按文件名推断槽位；先精确匹配，再按关键字包含匹配
pub fn infer_slot(stem: &str) -> Option<&'static str> {
    let name = stem.to_lowercase();

    if let Some((_, slot)) = EXACT_NAMES.iter().find(|(key, _)| *key == name) {
        return Some(slot);
    }

    SLOT_KEYWORDS
        .iter()
        .find(|(_, keys)| keys.iter().any(|key| name.contains(key)))
        .map(|(slot, _)| *slot)
}

/// 查槽位的中英文名
fn slot_names(slot_key: &str) -> (String, String) {
    registry::SLOT_DEFS
        .iter()
        .find(|(key, _, _)| *key == slot_key)
        .map(|(_, cn, en)| (cn.to_string(), en.to_string()))
        .unwrap_or_else(|| (slot_key.to_string(), slot_key.to_string()))
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// 递归收集目录下的光标文件
fn collect_cursor_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|err| format!("读取目录失败：{err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("读取目录项失败：{err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_cursor_files(&path, out)?;
            continue;
        }
        let is_cursor = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cur" | "ani" | "ico"))
            .unwrap_or(false);
        if is_cursor {
            out.push(path);
        }
    }
    Ok(())
}

/// 把 zip 解压到临时目录
fn extract_zip(zip_path: &Path, temp_dir: &Path) -> Result<(), String> {
    let file = File::open(zip_path)
        .map_err(|err| format!("打不开这个文件，它可能已被移动或删除（{err}）"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| format!("这不是有效的 ZIP 压缩包（{err}）"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|err| format!("读取压缩包条目失败：{err}"))?;

        // enclosed_name 会拒绝 ../ 之类的路径穿越
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let name = relative.to_string_lossy();
        if name.contains("__MACOSX") || name.starts_with('.') {
            continue;
        }

        let out_path = temp_dir.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("创建目录失败：{err}"))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("创建目录失败：{err}"))?;
        }
        let mut out_file =
            File::create(&out_path).map_err(|err| format!("写入文件失败：{err}"))?;
        copy(&mut entry, &mut out_file).map_err(|err| format!("解压文件失败：{err}"))?;
    }
    Ok(())
}

/// 导入一个 zip 主题包，返回生成的主题
pub fn import_zip(zip_path: &str) -> Result<CursorTheme, String> {
    import_zip_as(zip_path, &Uuid::new_v4().to_string())
}

/// `theme_id` 可注入：测试需要预先知道主题目录，才能构造并验证半成品状态
fn import_zip_as(zip_path: &str, theme_id: &str) -> Result<CursorTheme, String> {
    let source = Path::new(zip_path);
    let meta = fs::metadata(source)
        .map_err(|err| format!("找不到这个文件，它可能已被移动或删除（{err}）"))?;
    if meta.len() > MAX_ZIP_BYTES {
        let mb = meta.len() as f64 / 1024.0 / 1024.0;
        return Err(format!(
            "主题包 {mb:.1}MB，超过 50MB 上限。请删掉多余的光标或截图后重新打包"
        ));
    }

    let temp_dir = std::env::temp_dir().join(format!("cursortheme-{theme_id}"));
    paths::ensure_dir(&temp_dir)?;

    match extract_and_persist(source, &temp_dir, theme_id) {
        Ok(theme) => {
            let _ = fs::remove_dir_all(&temp_dir);
            Ok(theme)
        }
        Err(err) => {
            // 无论成败都清理临时目录
            let _ = fs::remove_dir_all(&temp_dir);
            // 失败时也不能留半成品主题目录：cursors/ 可能已经建了一半，
            // 残留的无 theme.json 目录会让下次启动多一条「跳过主题目录」的 warning
            let theme_dir = paths::theme_dir(theme_id);
            if fs::remove_dir_all(&theme_dir).is_err() {
                // 清不掉要说明，别让人对着一个来历不明的坏目录发呆；原始错误优先
                return Err(format!(
                    "{err}；另外，残留文件清理失败，可手动删除 {} 目录",
                    theme_dir.display()
                ));
            }
            Err(err)
        }
    }
}

fn extract_and_persist(
    source: &Path,
    temp_dir: &Path,
    theme_id: &str,
) -> Result<CursorTheme, String> {
    extract_zip(source, temp_dir)?;

    let mut files = Vec::new();
    collect_cursor_files(temp_dir, &mut files)?;
    if files.is_empty() {
        return Err(
            "压缩包里没有 .cur 或 .ani 光标文件。请把光标文件一起打包，不要只放 .inf 或说明文档"
                .to_string(),
        );
    }

    // 按槽位去重：同一槽位只取第一个文件
    let mut seen: HashSet<&'static str> = HashSet::new();
    let mut picked: Vec<(&'static str, PathBuf)> = Vec::new();
    for file in files {
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let Some(slot) = infer_slot(&stem) else {
            continue;
        };
        if seen.insert(slot) {
            picked.push((slot, file));
        }
    }

    if picked.is_empty() {
        return Err(
            "光标文件名认不出来。请改用 arrow、busy、text、hand 这类标准命名后重新打包".to_string(),
        );
    }

    // 按标准槽位顺序排列，界面显示更整齐
    picked.sort_by_key(|(slot, _)| {
        registry::SLOT_DEFS
            .iter()
            .position(|(key, _, _)| *key == *slot)
            .unwrap_or(usize::MAX)
    });

    let cursors_dir = paths::theme_dir(theme_id).join("cursors");
    paths::ensure_dir(&cursors_dir)?;

    let mut slots = Vec::new();
    for (slot_key, src) in picked {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_else(|| "cur".to_string());
        let dest = cursors_dir.join(format!("{}.{ext}", slot_key.to_lowercase()));
        fs::copy(&src, &dest).map_err(|err| format!("复制光标文件失败：{err}"))?;

        let (display_name, english_name) = slot_names(slot_key);
        slots.push(CursorSlot {
            registry_key: slot_key.to_string(),
            display_name,
            english_name,
            file_path: dest.to_string_lossy().into_owned(),
            file_type: ext,
        });
    }

    let theme_name = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名主题".to_string());

    let now = now_string();
    let theme = CursorTheme {
        id: theme_id.to_string(),
        name: theme_name,
        description: format!("导入自 {}", source.file_name().unwrap_or_default().to_string_lossy()),
        created_at: now.clone(),
        updated_at: now,
        is_built_in: false,
        cursors: slots,
    };

    let json =
        serde_json::to_string_pretty(&theme).map_err(|err| format!("序列化主题失败：{err}"))?;
    fs::write(paths::theme_dir(theme_id).join("theme.json"), json)
        .map_err(|err| format!("写入 theme.json 失败：{err}"))?;

    Ok(theme)
}

/// 读取全部已导入的用户主题
///
/// 返回 `(主题列表, 非致命问题描述)`。单项损坏只跳过那一项，不整体失败；
/// 目录本身读不出来也要让调用方知情，否则用户只会看到"主题凭空消失"。
pub fn read_user_themes() -> (Vec<CursorTheme>, Vec<String>) {
    let mut warnings = Vec::new();
    let dir = paths::themes_dir();
    if !dir.exists() {
        return (Vec::new(), warnings);
    }
    let Ok(entries) = fs::read_dir(&dir) else {
        warnings.push(format!(
            "用户主题目录读不出来（{}），已导入的主题暂时显示不了",
            dir.display()
        ));
        return (Vec::new(), warnings);
    };

    let mut themes: Vec<CursorTheme> = entries
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            // 不能直接 .ok()?：theme.json 一旦损坏，主题会从列表里凭空消失，
            // 用户只会觉得"我的主题丢了"。跳过它并留下可诊断的信息。
            let json = match fs::read_to_string(dir.join("theme.json")) {
                Ok(text) => text,
                Err(err) => {
                    let msg = format!("跳过主题目录 {}（读不到 theme.json：{err}）", dir.display());
                    eprintln!("{msg}");
                    warnings.push(msg);
                    return None;
                }
            };
            match serde_json::from_str::<CursorTheme>(&json) {
                Ok(theme) => Some(theme),
                Err(err) => {
                    let msg = format!("跳过损坏的 theme.json {}：{err}", dir.display());
                    eprintln!("{msg}");
                    warnings.push(msg);
                    None
                }
            }
        })
        .collect();

    themes.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    (themes, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 文件名能推断出槽位() {
        assert_eq!(infer_slot("arrow"), Some("Arrow"));
        assert_eq!(infer_slot("working"), Some("AppStarting"));
        assert_eq!(infer_slot("busy"), Some("Wait"));
        assert_eq!(infer_slot("link"), Some("Hand"));
        assert_eq!(infer_slot("arrow_up"), Some("UpArrow"));
        assert_eq!(infer_slot("size_nwse"), Some("SizeNWSE"));
        // 短名字走精确匹配
        assert_eq!(infer_slot("no"), Some("No"));
        assert_eq!(infer_slot("ns"), Some("SizeNS"));
        assert_eq!(infer_slot("we"), Some("SizeWE"));
        // normal 不能被 no 抢走
        assert_eq!(infer_slot("normal"), Some("Arrow"));
        assert_eq!(infer_slot("随便什么"), None);
    }

    #[test]
    fn 槽位名能查到中英文() {
        let (cn, en) = slot_names("Arrow");
        assert_eq!(cn, "正常选择");
        assert_eq!(en, "Normal Select");
    }

    #[test]
    fn 能导入自造主题包() {
        use std::io::Write;

        let cur = std::fs::read(r"C:\Windows\Cursors\aero_arrow.cur").expect("需要系统光标文件");
        let ani = std::fs::read(r"C:\Windows\Cursors\荧1.0\arrow.ani").expect("需要系统动态光标");

        // 造一个含两个光标文件、且带子目录的 zip
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            for (name, data) in [
                ("cursors/pointer.cur", &cur),
                ("cursors/busy.ani", &ani),
                ("readme.txt", &Vec::new()),
            ] {
                writer.start_file(name, options).expect("写入条目");
                writer.write_all(data).expect("写入数据");
            }
            writer.finish().expect("完成压缩");
        }

        let zip_path = std::env::temp_dir().join("cursortheme-import-test.zip");
        std::fs::write(&zip_path, buffer.into_inner()).expect("保存测试包");

        let theme = import_zip(zip_path.to_str().unwrap()).expect("导入应成功");

        assert!(!theme.is_built_in);
        assert_eq!(theme.cursors.len(), 2, "应只识别出两个光标");
        assert!(theme.cursors.iter().any(|c| c.registry_key == "Arrow"));
        // busy.ani 应落到 Wait
        assert!(theme.cursors.iter().any(|c| c.registry_key == "Wait"));

        let arrow = theme
            .cursors
            .iter()
            .find(|c| c.registry_key == "Arrow")
            .unwrap();
        assert!(Path::new(&arrow.file_path).exists(), "文件应已复制到数据目录");
        assert!(arrow.file_path.contains("CursorStudio"));

        // 清理产生的数据与临时文件
        std::fs::remove_dir_all(paths::theme_dir(&theme.id)).ok();
        std::fs::remove_file(&zip_path).ok();
    }

    #[test]
    fn 非压缩包应报错而不是崩溃() {
        let bad = std::env::temp_dir().join("cursortheme-not-a-zip.zip");
        std::fs::write(&bad, "这不是 zip".as_bytes()).expect("写入测试文件");
        let outcome = import_zip(bad.to_str().unwrap());
        assert!(outcome.is_err());
        std::fs::remove_file(&bad).ok();
    }

    /// 持久化阶段失败时不能留半成品主题目录：没有 theme.json 的残留目录
    /// 会让下次启动多一条「跳过主题目录」的 warning，还一直占着数据目录
    #[test]
    fn 导入失败时不残留半成品主题目录() {
        use std::io::Write;

        let cur = std::fs::read(r"C:\Windows\Cursors\aero_arrow.cur").expect("需要系统光标文件");

        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("cursors/pointer.cur", options).expect("写入条目");
            writer.write_all(&cur).expect("写入数据");
            writer.finish().expect("完成压缩");
        }
        let zip_path = std::env::temp_dir().join("cursortheme-rollback-test.zip");
        std::fs::write(&zip_path, buffer.into_inner()).expect("保存测试包");

        // 预先制造半成品：cursors 被一个同名文件占住，后面 ensure_dir 必然失败
        let theme_id = "00000000-0000-4000-8000-000000000001";
        let theme_dir = paths::theme_dir(theme_id);
        let _ = fs::remove_dir_all(&theme_dir);
        paths::ensure_dir(&theme_dir).expect("建主题目录");
        fs::write(theme_dir.join("cursors"), "不是目录").expect("造占位文件");

        let outcome = import_zip_as(zip_path.to_str().unwrap(), theme_id);

        fs::remove_file(&zip_path).ok();

        assert!(outcome.is_err(), "cursors 被文件占住应导入失败");
        assert!(!theme_dir.exists(), "失败后不能残留半成品主题目录");
    }
}
