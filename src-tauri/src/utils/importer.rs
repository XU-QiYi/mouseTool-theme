use std::collections::HashSet;
use std::fs::{self, File};
use std::io::copy;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::models::{CursorSlot, CursorTheme};
use crate::utils::{inf_parse, paths, registry};

/// 单个主题来源大小上限：50MB（zip 按包大小计，文件夹按光标文件总量计）
const MAX_THEME_BYTES: u64 = 50 * 1024 * 1024;

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

/// 递归收集目录下的 `.inf`（只用于读槽位映射，不算光标文件）
///
/// `.inf` 是可选加成，读不了就当没有：任何一层目录打不开都静默跳过。
fn collect_inf_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_inf_files(&path, out);
            continue;
        }
        let is_inf = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("inf"))
            .unwrap_or(false);
        if is_inf {
            out.push(path);
        }
    }
}

/// 解析包里的 `.inf` 槽位映射（决策 15）
///
/// 按路径排序保证确定性，取第一个能给出至少一条映射的；一个都给不出就返回
/// 空（整体退回文件名推断）。
fn inf_slot_map(files_root: &Path) -> Vec<(&'static str, String)> {
    let mut candidates = Vec::new();
    collect_inf_files(files_root, &mut candidates);
    candidates.sort();
    for path in candidates {
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let mapped = inf_parse::parse_inf(&bytes);
        if !mapped.is_empty() {
            return mapped;
        }
    }
    Vec::new()
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

/// 导入一个主题来源（`.zip` 包或整个主题文件夹，决策 16），返回生成的主题
pub fn import_source(path: &str) -> Result<CursorTheme, String> {
    import_source_as(path, &Uuid::new_v4().to_string())
}

/// `theme_id` 可注入：测试需要预先知道主题目录，才能构造并验证半成品状态
fn import_source_as(path: &str, theme_id: &str) -> Result<CursorTheme, String> {
    let source = Path::new(path);
    let meta = fs::metadata(source)
        .map_err(|err| format!("找不到这个文件，它可能已被移动或删除（{err}）"))?;

    if meta.is_dir() {
        return import_dir_as(source, theme_id);
    }

    // 文件只认 .zip：拖进来一张图片之类的要一句人话，而不是「不是有效的 ZIP」
    let is_zip = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);
    if !is_zip {
        return Err("只支持 .zip 主题包或整个主题文件夹".to_string());
    }

    import_zip_as(path, theme_id)
}

/// 兼容旧名：zip 导入入口（「导出 → 再导入」闭环测试等在用）
pub fn import_zip(zip_path: &str) -> Result<CursorTheme, String> {
    import_source_as(zip_path, &Uuid::new_v4().to_string())
}

/// 导入 zip 主题包：解压到临时目录后，走与文件夹相同的落盘流程
fn import_zip_as(zip_path: &str, theme_id: &str) -> Result<CursorTheme, String> {
    let source = Path::new(zip_path);
    let meta = fs::metadata(source)
        .map_err(|err| format!("找不到这个文件，它可能已被移动或删除（{err}）"))?;
    if meta.len() > MAX_THEME_BYTES {
        let mb = meta.len() as f64 / 1024.0 / 1024.0;
        return Err(format!(
            "主题包 {mb:.1}MB，超过 50MB 上限。请删掉多余的光标或截图后重新打包"
        ));
    }

    let temp_dir = std::env::temp_dir().join(format!("cursortheme-{theme_id}"));
    paths::ensure_dir(&temp_dir)?;

    let mut files = Vec::new();
    let outcome = extract_zip(source, &temp_dir).and_then(|()| {
        collect_cursor_files(&temp_dir, &mut files)?;
        persist_theme(files, &temp_dir, source, "压缩包", theme_id)
    });
    // 无论成败都清理临时目录
    let _ = fs::remove_dir_all(&temp_dir);
    outcome.map_err(|err| discard_partial(theme_id, err))
}

/// 导入一个主题文件夹（决策 16：与 zip 共用同一套流程，只是免了解压）
///
/// 源文件夹只读——光标复制进数据目录，原件留在原地。
fn import_dir_as(source: &Path, theme_id: &str) -> Result<CursorTheme, String> {
    let mut files = Vec::new();
    collect_cursor_files(source, &mut files)?;

    // 50MB 上限对文件夹同样生效：按收集到的光标文件总大小算
    let total: u64 = files
        .iter()
        .filter_map(|file| fs::metadata(file).ok())
        .map(|meta| meta.len())
        .sum();
    if total > MAX_THEME_BYTES {
        let mb = total as f64 / 1024.0 / 1024.0;
        return Err(format!(
            "文件夹里的光标共 {mb:.1}MB，超过 50MB 上限。请删掉多余的光标或截图后再导入"
        ));
    }

    persist_theme(files, source, source, "文件夹", theme_id)
        .map_err(|err| discard_partial(theme_id, err))
}

/// 失败时清掉半成品主题目录，返回原始错误
///
/// cursors/ 可能已经建了一半，残留的无 theme.json 目录会让下次启动多一条
/// 「跳过主题目录」的 warning。NotFound = 落盘前的失败、目录可能根本没建过，
/// 不是清理失败，别把用户支去删一个从不存在的目录。
fn discard_partial(theme_id: &str, err: String) -> String {
    let theme_dir = paths::theme_dir(theme_id);
    match fs::remove_dir_all(&theme_dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => err,
        // 清不掉要说明，别让人对着一个来历不明的坏目录发呆；原始错误优先
        Err(_) => format!(
            "{err}；另外，残留文件清理失败，可手动删除 {} 目录",
            theme_dir.display()
        ),
        Ok(()) => err,
    }
}

/// 把收集好的光标文件落盘成主题；zip（解压后的临时目录）与文件夹共用
///
/// `files_root` 是找 `.inf` 的根；`source` 提供主题名与「导入自」描述；
/// `label`（压缩包 / 文件夹）只影响报错文案。
fn persist_theme(
    files: Vec<PathBuf>,
    files_root: &Path,
    source: &Path,
    label: &str,
    theme_id: &str,
) -> Result<CursorTheme, String> {
    if files.is_empty() {
        return Err(match label {
            "文件夹" => "这个文件夹里（含子文件夹）没有 .cur 或 .ani 光标文件。光标文件要一起放进来，别只放 .inf 或说明文档".to_string(),
            _ => "压缩包里没有 .cur 或 .ani 光标文件。请把光标文件一起打包，不要只放 .inf 或说明文档".to_string(),
        });
    }

    // 槽位来源两条（决策 15）：先按 .inf 说明书映射，剩余槽位退回文件名推断；
    // 说明书指了名但包里没有那个文件时，该槽位也退回推断，不因此缺槽位
    let mut seen: HashSet<&'static str> = HashSet::new();
    let mut picked: Vec<(&'static str, PathBuf)> = Vec::new();

    for (slot, file_name) in inf_slot_map(files_root) {
        if !seen.insert(slot) {
            continue;
        }
        let wanted = file_name.to_lowercase();
        match files.iter().find(|file| {
            file.file_name()
                .is_some_and(|name| name.to_string_lossy().to_lowercase() == wanted)
        }) {
            Some(path) => picked.push((slot, path.clone())),
            // 说明书指向的文件不在包里：放开这个槽位给文件名推断兜底
            None => {
                seen.remove(&slot);
            }
        }
    }

    for file in &files {
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let Some(slot) = infer_slot(&stem) else {
            continue;
        };
        if seen.insert(slot) {
            picked.push((slot, file.clone()));
        }
    }

    if picked.is_empty() {
        return Err(
            "光标文件名认不出来，也没有可用的 .inf 槽位映射。请把文件改成 arrow、busy、text、hand 这类标准命名后再导入"
                .to_string(),
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

    // 文件夹名整体当主题名（「我的主题.v2」不吃掉 .v2）；zip 去掉 .zip 后缀
    let theme_name = if source.is_dir() {
        source.file_name()
    } else {
        source.file_stem()
    }
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

    /// 文件夹导入（决策 16）：与 zip 同一套流程，主题名取文件夹名整体
    #[test]
    fn 能导入主题文件夹且名字取文件夹名整体() {
        let cur = std::fs::read(r"C:\Windows\Cursors\aero_arrow.cur").expect("需要系统光标文件");
        let ani = std::fs::read(r"C:\Windows\Cursors\荧1.0\arrow.ani").expect("需要系统动态光标");

        // 文件夹名故意带点：.v2 不能被当扩展名吃掉
        let src_dir = std::env::temp_dir().join("cursortheme-folder-src.v2");
        std::fs::create_dir_all(&src_dir).expect("建临时源文件夹");
        std::fs::write(src_dir.join("pointer.cur"), &cur).expect("写入光标");
        std::fs::write(src_dir.join("busy.ani"), &ani).expect("写入光标");

        let theme = import_source(src_dir.to_str().unwrap()).expect("导入应成功");

        assert_eq!(theme.cursors.len(), 2);
        assert_eq!(theme.name, "cursortheme-folder-src.v2");
        assert!(theme.cursors.iter().all(|c| Path::new(&c.file_path).exists()));

        std::fs::remove_dir_all(&src_dir).ok();
        std::fs::remove_dir_all(paths::theme_dir(&theme.id)).ok();
    }

    /// .inf 说明书优先（决策 15）：文件名认不出的文件按说明书对号
    #[test]
    fn inf_说明书优先于文件名推断() {
        let cur = std::fs::read(r"C:\Windows\Cursors\aero_arrow.cur").expect("需要系统光标文件");

        let src_dir = std::env::temp_dir().join("cursortheme-inf-src");
        std::fs::create_dir_all(&src_dir).expect("建临时源文件夹");
        // 两个文件名都认不出槽位，全靠说明书
        std::fs::write(src_dir.join("01-blue.cur"), &cur).expect("写入光标");
        std::fs::write(src_dir.join("zz-tip.cur"), &cur).expect("写入光标");
        std::fs::write(
            src_dir.join("theme.inf"),
            concat!(
                "[Scheme.Reg]\r\n",
                "HKCU,\"Control Panel\\Cursors\",Arrow,,\"%10%\\%CUR_DIR%\\01-blue.cur\"\r\n",
                "HKCU,\"Control Panel\\Cursors\",IBeam,,\"%10%\\%CUR_DIR%\\zz-tip.cur\"\r\n",
            ),
        )
        .expect("写入 .inf");

        let theme = import_source(src_dir.to_str().unwrap()).expect("导入应成功");

        assert_eq!(theme.cursors.len(), 2);
        assert!(theme.cursors.iter().any(|c| c.registry_key == "Arrow"));
        assert!(theme.cursors.iter().any(|c| c.registry_key == "IBeam"));

        std::fs::remove_dir_all(&src_dir).ok();
        std::fs::remove_dir_all(paths::theme_dir(&theme.id)).ok();
    }

    /// 说明书指向的文件不在包里时，该槽位退回文件名推断，不缺槽位
    #[test]
    fn inf_指向缺失文件时该槽位退回文件名推断() {
        let cur = std::fs::read(r"C:\Windows\Cursors\aero_arrow.cur").expect("需要系统光标文件");
        let ani = std::fs::read(r"C:\Windows\Cursors\荧1.0\arrow.ani").expect("需要系统动态光标");

        let src_dir = std::env::temp_dir().join("cursortheme-inf-missing-src");
        std::fs::create_dir_all(&src_dir).expect("建临时源文件夹");
        std::fs::write(src_dir.join("arrow.cur"), &cur).expect("写入光标");
        std::fs::write(src_dir.join("busy.ani"), &ani).expect("写入光标");
        std::fs::write(
            src_dir.join("theme.inf"),
            concat!(
                "[Control Panel\\Cursors]\r\n",
                "Arrow=arrow.cur\r\n",
                "Wait=ghost.ani\r\n",
            ),
        )
        .expect("写入 .inf");

        let theme = import_source(src_dir.to_str().unwrap()).expect("导入应成功");

        let wait = theme
            .cursors
            .iter()
            .find(|c| c.registry_key == "Wait")
            .expect("Wait 不该因为说明书指向缺失文件而缺槽位");
        assert!(
            wait.file_path.ends_with("wait.ani"),
            "busy.ani 应按文件名推断落到 Wait，实际：{}",
            wait.file_path
        );

        std::fs::remove_dir_all(&src_dir).ok();
        std::fs::remove_dir_all(paths::theme_dir(&theme.id)).ok();
    }

    /// 非 zip 文件给出人话，而不是「不是有效的 ZIP」
    #[test]
    fn 非_zip_文件报人话() {
        let file = std::env::temp_dir().join("cursortheme-not-theme.png");
        std::fs::write(&file, b"png").expect("写入测试文件");

        let err = import_source(file.to_str().unwrap()).unwrap_err();
        assert!(err.contains("只支持"), "实际：{err}");

        std::fs::remove_file(&file).ok();
    }

    /// 空文件夹与空 zip 一样报「没有光标文件」，只是文案说文件夹
    #[test]
    fn 空文件夹导入报错且不残留() {
        let dir = std::env::temp_dir().join("cursortheme-empty-folder");
        std::fs::create_dir_all(&dir).expect("建空文件夹");

        let err = import_source(dir.to_str().unwrap()).unwrap_err();
        assert!(err.contains("这个文件夹里"), "实际：{err}");
        assert!(err.contains("没有 .cur 或 .ani"), "实际：{err}");

        std::fs::remove_dir(&dir).ok();
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

    /// 回归测试：落盘前的失败（认不出文件名、非 zip）发生在主题目录创建之前，
    /// NotFound 不是「清理失败」——不能把用户支去删一个根本不存在的目录
    #[test]
    fn 落盘前的失败不应谎报清理失败() {
        use std::io::Write;

        let cur = std::fs::read(r"C:\Windows\Cursors\aero_arrow.cur").expect("需要系统光标文件");

        // 场景一：光标文件名认不出来，picked 为空，主题目录从未创建
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("cursors/随便起的名字.cur", options).expect("写入条目");
            writer.write_all(&cur).expect("写入数据");
            writer.finish().expect("完成压缩");
        }
        let unnamed = std::env::temp_dir().join("cursortheme-unnamed-test.zip");
        std::fs::write(&unnamed, buffer.into_inner()).expect("保存测试包");

        let err = import_zip(unnamed.to_str().unwrap()).unwrap_err();
        std::fs::remove_file(&unnamed).ok();
        assert!(err.contains("认不出来"), "实际：{err}");
        assert!(
            !err.contains("清理失败"),
            "目录从未创建，不该报清理失败。实际：{err}"
        );

        // 场景二：根本不是 zip，同样在落盘前失败
        let bad = std::env::temp_dir().join("cursortheme-not-zip-again.zip");
        std::fs::write(&bad, "仍然不是 zip".as_bytes()).expect("写入测试文件");

        let err = import_zip(bad.to_str().unwrap()).unwrap_err();
        std::fs::remove_file(&bad).ok();
        assert!(err.contains("不是有效的 ZIP"), "实际：{err}");
        assert!(
            !err.contains("清理失败"),
            "同上，不该报清理失败。实际：{err}"
        );
    }
}
