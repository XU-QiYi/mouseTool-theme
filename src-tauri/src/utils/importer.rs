use std::collections::HashSet;
use std::fs::{self, File};
use std::path::{Path, PathBuf};

use serde::Serialize;
use uuid::Uuid;

use crate::models::{CursorSlot, CursorTheme};
use crate::utils::{inf_parse, limits, paths, progress, registry, theme_paths, validation};

/// 导入结果：新主题 + 扫描时跳过的非致命问题（典型：链接 / 目录联接）
#[derive(Debug, Serialize)]
pub struct ImportReport {
    pub theme: CursorTheme,
    pub warnings: Vec<String>,
}

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
///
/// 深度、条目数与体积上限与 zip 导入共用 `THEME_LIMITS`；超限立即失败，
/// 由调用方清理半成品，避免一个巨大文件夹把导入卡死。
fn collect_cursor_files(
    dir: &Path,
    depth: usize,
    budget: &mut limits::ScanBudget<'_>,
    warnings: &mut Vec<String>,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    budget.check_depth(depth)?;
    let entries = fs::read_dir(dir).map_err(|err| format!("读取目录失败：{err}"))?;
    for entry in entries {
        let entry = entry.map_err(|err| format!("读取目录项失败：{err}"))?;
        let path = entry.path();
        if limits::is_reparse_entry(&entry) {
            warnings.push(format!("已跳过链接或目录联接：{}", path.display()));
            continue;
        }
        if entry
            .file_type()
            .map_err(|err| format!("读不到目录项类型（{err}）"))?
            .is_dir()
        {
            collect_cursor_files(&path, depth + 1, budget, warnings, out)?;
            continue;
        }
        let is_cursor = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| validation::is_cursor_extension(ext))
            .unwrap_or(false);
        if is_cursor {
            let size = entry
                .metadata()
                .map_err(|err| format!("读不到文件信息（{err}）"))?
                .len();
            budget.note_file(size)?;
            out.push(path);
        }
    }
    Ok(())
}

/// 递归收集目录下的 `.inf`（只用于读槽位映射）
///
/// 与光标文件共用同一个 `ScanBudget`：`.inf` 也要占条目数和总体积，
/// 否则一堆超大说明书可以绕过导入限额。链接 / 目录联接一律跳过。
fn collect_inf_files(
    dir: &Path,
    depth: usize,
    budget: &mut limits::ScanBudget<'_>,
    warnings: &mut Vec<String>,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    budget.check_depth(depth)?;
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            // `.inf` 是可选加成：目录打不开不拖垮导入，但要说清楚跳过了什么
            warnings.push(format!("读不到目录 {}，已跳过其中的 .inf（{err}）", dir.display()));
            return Ok(());
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                warnings.push(format!("读取 .inf 目录项失败，已跳过（{err}）"));
                continue;
            }
        };
        let path = entry.path();
        if limits::is_reparse_entry(&entry) {
            warnings.push(format!("已跳过链接或目录联接：{}", path.display()));
            continue;
        }
        let is_dir = match entry.file_type() {
            Ok(kind) => kind.is_dir(),
            Err(err) => {
                warnings.push(format!(
                    "读不到目录项类型，已跳过 {}（{err}）",
                    path.display()
                ));
                continue;
            }
        };
        if is_dir {
            collect_inf_files(&path, depth + 1, budget, warnings, out)?;
            continue;
        }
        let is_inf = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("inf"))
            .unwrap_or(false);
        if is_inf {
            let size = match entry.metadata() {
                Ok(meta) => meta.len(),
                Err(err) => {
                    warnings.push(format!(
                        "读不到 .inf 文件信息，已跳过 {}（{err}）",
                        path.display()
                    ));
                    continue;
                }
            };
            budget.note_file(size)?;
            out.push(path);
        }
    }
    Ok(())
}

/// 解析包里的 `.inf` 槽位映射（决策 15）
///
/// 按路径排序保证确定性，取第一个能给出至少一条映射的；一个都给不出就返回
/// 空（整体退回文件名推断）。
fn inf_slot_map(
    files_root: &Path,
    budget: &mut limits::ScanBudget<'_>,
    warnings: &mut Vec<String>,
) -> Result<Vec<(&'static str, String)>, String> {
    let mut candidates = Vec::new();
    collect_inf_files(files_root, 0, budget, warnings, &mut candidates)?;
    candidates.sort();
    for path in candidates {
        // `.inf` 可能是 UTF-16LE（本工具导出的就是），不能先按 UTF-8 解码
        let bytes = match limits::read_bytes_bounded(&path, limits::MAX_INF_BYTES) {
            Ok(bytes) => bytes,
            Err(err) => {
                warnings.push(format!(
                    "跳过无法读取的 .inf：{}（{err}）",
                    path.display()
                ));
                continue;
            }
        };
        let mapped = inf_parse::parse_inf(&bytes);
        if !mapped.is_empty() {
            return Ok(mapped);
        }
    }
    Ok(Vec::new())
}

/// 把 zip 解压到临时目录
///
/// 每个条目先过名称白名单与预算，再分块复制；超限立即返回错误，
/// 临时目录由 `import_zip_as` 统一清理。
fn extract_zip(
    zip_path: &Path,
    temp_dir: &Path,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
) -> Result<(), String> {
    let file = File::open(zip_path)
        .map_err(|err| format!("打不开这个文件，它可能已被移动或删除（{err}）"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| format!("这不是有效的 ZIP 压缩包（{err}）"))?;

    let total = archive.len();
    if total > limits::THEME_LIMITS.max_entries {
        return Err(format!(
            "主题包里的条目太多（{total} 个，上限 {}），已停止导入",
            limits::THEME_LIMITS.max_entries
        ));
    }

    let mut budget = limits::ArchiveBudget::new(&limits::THEME_LIMITS);
    let mut throttle = progress::ProgressThrottle::new(total);

    for i in 0..total {
        let mut entry = archive
            .by_index(i)
            .map_err(|err| format!("读取压缩包条目失败：{err}"))?;

        let Some(parts) = limits::safe_relative_parts(entry.name(), &limits::THEME_LIMITS)? else {
            continue;
        };
        let out_path = limits::join_parts(temp_dir, &parts);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("创建目录失败：{err}"))?;
            continue;
        }

        budget.note_entry()?;
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("创建目录失败：{err}"))?;
        }
        let mut out_file =
            File::create(&out_path).map_err(|err| format!("写入文件失败：{err}"))?;
        let written = limits::copy_bounded(
            &mut entry,
            &mut out_file,
            budget.allowance(),
            &limits::THEME_LIMITS,
        )?;
        budget.commit(written)?;

        if throttle.step(i + 1) {
            progress_fn(progress::TaskProgress::new(
                "extract",
                i + 1,
                total,
                format!("正在解压（{}/{}）", i + 1, total),
            ));
        }
    }
    Ok(())
}

/// 导入一个主题来源（`.zip` 包或整个主题文件夹，决策 16），返回生成的主题
pub fn import_source(path: &str) -> Result<CursorTheme, String> {
    import_source_report(path, &mut |_| {}).map(|report| report.theme)
}

/// 带进度的导入入口：返回主题 + 扫描时跳过的非致命问题
pub fn import_source_report(
    path: &str,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
) -> Result<ImportReport, String> {
    import_source_as(path, &Uuid::new_v4().to_string(), progress_fn)
}

/// `theme_id` 可注入：测试需要预先知道主题目录，才能构造并验证半成品状态
fn import_source_as(
    path: &str,
    theme_id: &str,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
) -> Result<ImportReport, String> {
    let source = Path::new(path);
    let meta = fs::metadata(source)
        .map_err(|err| format!("找不到这个文件，它可能已被移动或删除（{err}）"))?;

    if meta.is_dir() {
        return import_dir_as(source, theme_id, progress_fn);
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

    import_zip_as(path, theme_id, progress_fn)
}

/// 兼容旧名：zip 导入入口（「导出 → 再导入」闭环测试等在用）
pub fn import_zip(zip_path: &str) -> Result<CursorTheme, String> {
    import_source_as(zip_path, &Uuid::new_v4().to_string(), &mut |_| {}).map(|report| report.theme)
}

/// 导入 zip 主题包：解压到临时目录后，走与文件夹相同的落盘流程
fn import_zip_as(
    zip_path: &str,
    theme_id: &str,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
) -> Result<ImportReport, String> {
    let source = Path::new(zip_path);
    let meta = fs::metadata(source)
        .map_err(|err| format!("找不到这个文件，它可能已被移动或删除（{err}）"))?;
    if meta.len() > limits::THEME_LIMITS.max_total_bytes {
        let mb = meta.len() as f64 / 1024.0 / 1024.0;
        return Err(format!(
            "主题包 {mb:.1}MB，超过 {} 上限。请删掉多余的光标或截图后重新打包",
            limits::THEME_LIMITS.total_hint()
        ));
    }

    progress_fn(progress::TaskProgress::new("extract", 0, 0, "正在读取主题包…"));
    let temp_dir = std::env::temp_dir().join(format!("cursortheme-{theme_id}"));
    paths::ensure_dir(&temp_dir)?;

    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let outcome = extract_zip(source, &temp_dir, progress_fn).and_then(|()| {
        let mut budget = limits::ScanBudget::new(&limits::THEME_LIMITS);
        collect_cursor_files(
            &temp_dir,
            0,
            &mut budget,
            &mut warnings,
            &mut files,
        )?;
        let theme = persist_theme(
            files,
            &temp_dir,
            source,
            "压缩包",
            theme_id,
            &mut budget,
            &mut warnings,
            progress_fn,
        )?;
        Ok(ImportReport { theme, warnings })
    });
    // 无论成败都清理临时目录（超限、解压失败也不会留下半截文件）
    let _ = fs::remove_dir_all(&temp_dir);
    outcome.map_err(|err| discard_partial(theme_id, err))
}

/// 导入一个主题文件夹（决策 16：与 zip 共用同一套流程，只是免了解压）
///
/// 源文件夹只读——光标复制进数据目录，原件留在原地。
fn import_dir_as(
    source: &Path,
    theme_id: &str,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
) -> Result<ImportReport, String> {
    progress_fn(progress::TaskProgress::new("scan", 0, 0, "正在扫描文件夹…"));
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let mut budget = limits::ScanBudget::new(&limits::THEME_LIMITS);
    collect_cursor_files(source, 0, &mut budget, &mut warnings, &mut files)?;

    let theme = persist_theme(
        files,
        source,
        source,
        "文件夹",
        theme_id,
        &mut budget,
        &mut warnings,
        progress_fn,
    )
    .map_err(|err| discard_partial(theme_id, err))?;
    Ok(ImportReport { theme, warnings })
}

/// 失败时清掉半成品主题目录，返回原始错误
///
/// cursors/ 可能已经建了一半，残留的无 theme.json 目录会让下次启动多一条
/// 「跳过主题目录」的 warning。NotFound = 落盘前的失败、目录可能根本没建过，
/// 不是清理失败，别把用户支去删一个从不存在的目录。
fn discard_partial(theme_id: &str, err: String) -> String {
    let Ok(theme_dir) = paths::theme_dir(theme_id) else {
        return err;
    };
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
    budget: &mut limits::ScanBudget<'_>,
    warnings: &mut Vec<String>,
    progress_fn: &mut dyn FnMut(progress::TaskProgress),
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

    for (slot, file_name) in inf_slot_map(files_root, budget, warnings)? {
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

    let cursors_dir = paths::theme_dir(theme_id)?.join("cursors");
    paths::ensure_dir(&cursors_dir)?;

    let total = picked.len();
    let mut slots = Vec::new();
    for (index, (slot_key, src)) in picked.into_iter().enumerate() {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_else(|| "cur".to_string());
        if !validation::is_cursor_extension(&ext) {
            continue;
        }
        let dest = cursors_dir.join(format!("{}.{ext}", slot_key.to_lowercase()));

        // 与 zip 解压共用单文件上限；分块复制，超过上限立即中止
        let mut input =
            File::open(&src).map_err(|err| format!("打开光标文件失败（{err}）"))?;
        let mut output = File::create(&dest).map_err(|err| format!("复制光标文件失败：{err}"))?;
        let written = limits::copy_bounded(
            &mut input,
            &mut output,
            limits::MAX_CURSOR_FILE_BYTES,
            &limits::THEME_LIMITS,
        )?;
        if written == 0 {
            return Err(format!("光标文件是空的：{}", src.display()));
        }

        let (display_name, english_name) = slot_names(slot_key);
        slots.push(CursorSlot {
            registry_key: slot_key.to_string(),
            display_name,
            english_name,
            file_path: dest.to_string_lossy().into_owned(),
            file_type: ext,
        });

        progress_fn(progress::TaskProgress::new(
            "persist",
            index + 1,
            total,
            format!("正在保存光标（{}/{}）", index + 1, total),
        ));
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

    // 磁盘只存相对主题目录的路径；返回给调用方的仍是绝对路径（预览/应用直接用）
    theme_paths::write_theme_json(&paths::theme_dir(theme_id)?, &theme)?;

    progress_fn(progress::TaskProgress::new("done", total, total, "导入完成"));
    Ok(theme)
}

/// 读取全部已导入的用户主题
///
/// 返回 `(主题列表, 非致命问题描述)`。单项损坏只跳过那一项，不整体失败；
/// 目录本身读不出来也要让调用方知情，否则用户只会看到"主题凭空消失"。
pub fn read_user_themes() -> (Vec<CursorTheme>, Vec<String>) {
    let mut warnings = Vec::new();
    let dir = match paths::themes_dir() {
        Ok(dir) => dir,
        Err(err) => return (Vec::new(), vec![err]),
    };
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
            if limits::is_reparse_entry(&entry) {
                let msg = format!(
                    "跳过链接或目录联接主题目录：{}",
                    entry.path().display()
                );
                eprintln!("{msg}");
                warnings.push(msg);
                return None;
            }
            let dir = entry.path();
            let json_path = dir.join("theme.json");
            if limits::is_reparse_path(&json_path) {
                let msg = format!(
                    "跳过主题目录 {}（theme.json 是链接或目录联接）",
                    dir.display()
                );
                eprintln!("{msg}");
                warnings.push(msg);
                return None;
            }
            // 不能直接 .ok()?：theme.json 一旦损坏，主题会从列表里凭空消失，
            // 用户只会觉得"我的主题丢了"。跳过它并留下可诊断的信息。
            let json = match limits::read_text_bounded(
                &json_path,
                limits::MAX_THEME_JSON_BYTES,
            ) {
                Ok(text) => text,
                Err(err) => {
                    let msg = format!("跳过主题目录 {}（读不到 theme.json：{err}）", dir.display());
                    eprintln!("{msg}");
                    warnings.push(msg);
                    return None;
                }
            };
            match serde_json::from_str::<CursorTheme>(&json) {
                Ok(mut theme) => {
                    let dir_name = dir
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default();
                    // 磁盘主题只能是用户主题；自称系统方案就是伪装，不能进列表
                    if theme.is_built_in {
                        let msg = format!(
                            "跳过主题目录 {}（theme.json 声明为系统方案，用户主题不能自称系统方案）",
                            dir.display()
                        );
                        eprintln!("{msg}");
                        warnings.push(msg);
                        return None;
                    }
                    // id 与目录名不一致 = 数据被手工搬过或拷过，继续用会删错目录
                    if theme.id != dir_name || Uuid::parse_str(&theme.id).is_err() {
                        let msg = format!(
                            "跳过主题目录 {}（theme.json 的 id 与目录名不一致：{}）",
                            dir.display(),
                            theme.id
                        );
                        eprintln!("{msg}");
                        warnings.push(msg);
                        return None;
                    }
                    // 旧版本的绝对路径：能全部相对化就立刻回写一次，避免每次启动
                    // 都靠内存修补；改不动的保持原样，交给下面的清洗给出提示
                    let had_absolute = theme
                        .cursors
                        .iter()
                        .any(|slot| theme_paths::is_absolute(&slot.file_path));
                    if had_absolute {
                        let (disk, repairable) = theme_paths::to_storage(&theme, &dir);
                        if repairable.is_empty() {
                            match theme_paths::write_stored_theme(&dir, &disk) {
                                Ok(()) => theme = disk,
                                Err(err) => warnings.push(format!(
                                    "主题《{}》的旧绝对路径没能写回（{err}）",
                                    theme.name
                                )),
                            }
                        }
                    }
                    // 磁盘上是相对路径（旧版本可能是绝对路径），统一拼回绝对路径
                    theme_paths::resolve_theme(&mut theme, &dir);
                    // 未知槽位、重复槽位、越出主题目录的路径都清掉，只提示不崩
                    warnings.extend(validation::sanitize_loaded_slots(&mut theme, &dir));
                    if theme.cursors.is_empty() {
                        warnings.push(format!(
                            "跳过主题目录 {}（没有可用的光标槽位）",
                            dir.display()
                        ));
                        return None;
                    }
                    Some(theme)
                }
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
    use crate::utils::test_support::{fixture_ani, fixture_cur, write_cursor_fixtures, TempDir};
    use std::io::Write;

    fn zip_with(path: &Path, entries: Vec<(String, Vec<u8>)>) {
        let file = File::create(path).expect("建 zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            writer.start_file(name, options).expect("写入条目");
            writer.write_all(&data).expect("写入数据");
        }
        writer.finish().expect("完成压缩");
    }

    #[test]
    fn 文件名能推断出槽位() {
        assert_eq!(infer_slot("arrow"), Some("Arrow"));
        assert_eq!(infer_slot("working"), Some("AppStarting"));
        assert_eq!(infer_slot("busy"), Some("Wait"));
        assert_eq!(infer_slot("link"), Some("Hand"));
        assert_eq!(infer_slot("arrow_up"), Some("UpArrow"));
        assert_eq!(infer_slot("size_nwse"), Some("SizeNWSE"));
        assert_eq!(infer_slot("no"), Some("No"));
        assert_eq!(infer_slot("ns"), Some("SizeNS"));
        assert_eq!(infer_slot("we"), Some("SizeWE"));
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
        let temp = TempDir::new("import-zip");
        let _guard = temp.isolate_paths();

        let zip_path = temp.join("theme.zip");
        zip_with(
            &zip_path,
            vec![
                ("cursors/pointer.cur".to_string(), fixture_cur()),
                ("cursors/busy.ani".to_string(), fixture_ani()),
                ("readme.txt".to_string(), Vec::new()),
            ],
        );

        let theme = import_zip(zip_path.to_str().unwrap()).expect("导入应成功");
        assert!(!theme.is_built_in);
        assert_eq!(theme.cursors.len(), 2, "应只识别出两个光标");
        assert!(theme.cursors.iter().any(|c| c.registry_key == "Arrow"));
        assert!(theme.cursors.iter().any(|c| c.registry_key == "Wait"));

        let arrow = theme
            .cursors
            .iter()
            .find(|c| c.registry_key == "Arrow")
            .unwrap();
        assert!(Path::new(&arrow.file_path).exists(), "文件应已复制到数据目录");
        assert!(arrow.file_path.contains("themes"));

        // 磁盘上只留相对路径：换主题目录后旧绝对路径不会失效
        let raw = std::fs::read_to_string(
            paths::theme_dir(&theme.id).expect("解析主题目录").join("theme.json"),
        )
            .expect("读 theme.json");
        let stored: CursorTheme = serde_json::from_str(&raw).expect("解析 theme.json");
        assert!(stored.cursors.iter().all(|c| !theme_paths::is_absolute(&c.file_path)));
        assert!(stored.cursors.iter().all(|c| c.file_path.starts_with("cursors/")));
    }

    #[test]
    fn 非压缩包应报错而不是崩溃() {
        let temp = TempDir::new("not-zip");
        let _guard = temp.isolate_paths();
        let bad = temp.join("not-a-zip.zip");
        fs::write(&bad, "这不是 zip".as_bytes()).expect("写入测试文件");
        let outcome = import_zip(bad.to_str().unwrap());
        assert!(outcome.is_err());
    }

    #[test]
    fn 能导入主题文件夹且名字取文件夹名整体() {
        let temp = TempDir::new("import-folder");
        let _guard = temp.isolate_paths();

        // 文件夹名故意带点：.v2 不能被当扩展名吃掉
        let src_dir = temp.join("cursortheme-folder-src.v2");
        write_cursor_fixtures(&src_dir);

        let theme = import_source(src_dir.to_str().unwrap()).expect("导入应成功");
        assert_eq!(theme.cursors.len(), 2);
        assert_eq!(theme.name, "cursortheme-folder-src.v2");
        assert!(theme.cursors.iter().all(|c| Path::new(&c.file_path).exists()));
    }

    #[test]
    fn inf_说明书优先于文件名推断() {
        let temp = TempDir::new("inf-priority");
        let _guard = temp.isolate_paths();

        let src_dir = temp.join("src");
        fs::create_dir_all(&src_dir).expect("建临时源文件夹");
        fs::write(src_dir.join("01-blue.cur"), fixture_cur()).expect("写入光标");
        fs::write(src_dir.join("zz-tip.cur"), fixture_cur()).expect("写入光标");
        fs::write(
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
    }

    /// 本工具导出的 `.inf` 是 UTF-16LE + BOM，导入端必须按字节交给解析器
    #[test]
    fn utf16le_说明书能进入解析器() {
        let temp = TempDir::new("inf-utf16le");
        let _guard = temp.isolate_paths();

        let src_dir = temp.join("src");
        fs::create_dir_all(&src_dir).expect("建临时源文件夹");
        fs::write(src_dir.join("custom.cur"), fixture_cur()).expect("写入光标");

        let mut bytes = vec![0xFF, 0xFE];
        for unit in "[Control Panel\\Cursors]\r\nArrow=custom.cur\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(src_dir.join("theme.inf"), bytes).expect("写入 UTF-16LE .inf");

        let theme = import_source(src_dir.to_str().unwrap()).expect("导入应成功");
        assert_eq!(theme.cursors.len(), 1);
        assert_eq!(theme.cursors[0].registry_key, "Arrow");
        assert!(
            theme.cursors[0].file_path.ends_with("arrow.cur"),
            "应落到标准槽位文件名，实际：{}",
            theme.cursors[0].file_path
        );
    }

    #[test]
    fn inf_指向缺失文件时该槽位退回文件名推断() {
        let temp = TempDir::new("inf-missing");
        let _guard = temp.isolate_paths();

        let src_dir = temp.join("src");
        fs::create_dir_all(&src_dir).expect("建临时源文件夹");
        fs::write(src_dir.join("arrow.cur"), fixture_cur()).expect("写入光标");
        fs::write(src_dir.join("busy.ani"), fixture_ani()).expect("写入光标");
        fs::write(
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
    }

    #[test]
    fn 非_zip_文件报人话() {
        let temp = TempDir::new("not-theme");
        let _guard = temp.isolate_paths();
        let file = temp.join("not-theme.png");
        fs::write(&file, b"png").expect("写入测试文件");

        let err = import_source(file.to_str().unwrap()).unwrap_err();
        assert!(err.contains("只支持"), "实际：{err}");
    }

    #[test]
    fn 空文件夹导入报错且不残留() {
        let temp = TempDir::new("empty-folder");
        let _guard = temp.isolate_paths();
        let dir = temp.join("empty");
        fs::create_dir_all(&dir).expect("建空文件夹");

        let err = import_source(dir.to_str().unwrap()).unwrap_err();
        assert!(err.contains("这个文件夹里"), "实际：{err}");
        assert!(err.contains("没有 .cur 或 .ani"), "实际：{err}");
    }

    #[test]
    fn 导入失败时不残留半成品主题目录() {
        let temp = TempDir::new("rollback");
        let _guard = temp.isolate_paths();

        let zip_path = temp.join("rollback.zip");
        zip_with(
            &zip_path,
            vec![("cursors/pointer.cur".to_string(), fixture_cur())],
        );

        // 预先制造半成品：cursors 被一个同名文件占住，后面 ensure_dir 必然失败
        let theme_id = "00000000-0000-4000-8000-000000000001";
        let theme_dir = paths::theme_dir(theme_id).expect("解析主题目录");
        paths::ensure_dir(&theme_dir).expect("建主题目录");
        fs::write(theme_dir.join("cursors"), "不是目录").expect("造占位文件");

        let outcome = import_zip_as(zip_path.to_str().unwrap(), theme_id, &mut |_| {});
        assert!(outcome.is_err(), "cursors 被文件占住应导入失败");
        assert!(!theme_dir.exists(), "失败后不能残留半成品主题目录");
    }

    #[test]
    fn 落盘前的失败不应谎报清理失败() {
        let temp = TempDir::new("early-fail");
        let _guard = temp.isolate_paths();

        // 场景一：光标文件名认不出来，picked 为空，主题目录从未创建
        let unnamed = temp.join("unnamed.zip");
        zip_with(
            &unnamed,
            vec![("cursors/随便起的名字.cur".to_string(), fixture_cur())],
        );
        let err = import_zip(unnamed.to_str().unwrap()).unwrap_err();
        assert!(err.contains("认不出来"), "实际：{err}");
        assert!(!err.contains("清理失败"), "目录从未创建，不该报清理失败。实际：{err}");

        // 场景二：根本不是 zip，同样在落盘前失败
        let bad = temp.join("not-zip-again.zip");
        fs::write(&bad, "仍然不是 zip".as_bytes()).expect("写入测试文件");
        let err = import_zip(bad.to_str().unwrap()).unwrap_err();
        assert!(err.contains("不是有效的 ZIP"), "实际：{err}");
        assert!(!err.contains("清理失败"), "同上，不该报清理失败。实际：{err}");
    }

    /// 条目数上限：在解压前就挡住，并清理解压临时目录
    #[test]
    fn 条目数超限时拒绝并清理临时目录() {
        let temp = TempDir::new("too-many");
        let _guard = temp.isolate_paths();

        let zip_path = temp.join("many.zip");
        let entries = (0..=limits::THEME_LIMITS.max_entries)
            .map(|i| (format!("junk-{i}.txt"), Vec::new()))
            .collect();
        zip_with(&zip_path, entries);

        let theme_id = "00000000-0000-4000-8000-000000000002";
        let err = import_zip_as(zip_path.to_str().unwrap(), theme_id, &mut |_| {}).unwrap_err();
        assert!(err.contains("条目太多"), "实际：{err}");
        assert!(
            !std::env::temp_dir().join(format!("cursortheme-{theme_id}")).exists(),
            "失败后必须清理解压临时目录"
        );
    }

    /// 路径穿越：整个包拒绝，不能只跳过那一条
    #[test]
    fn 路径穿越条目被拒绝() {
        let temp = TempDir::new("traversal");
        let _guard = temp.isolate_paths();

        let zip_path = temp.join("evil.zip");
        zip_with(
            &zip_path,
            vec![("../evil.cur".to_string(), fixture_cur())],
        );
        let err = import_zip(zip_path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("跳出目标目录"), "实际：{err}");
    }

    /// 嵌套过深：同样在解压阶段拒绝
    #[test]
    fn 目录层级过深被拒绝() {
        let temp = TempDir::new("too-deep");
        let _guard = temp.isolate_paths();

        let deep = format!(
            "{}/arrow.cur",
            std::iter::repeat("dir")
                .take(limits::THEME_LIMITS.max_depth + 1)
                .collect::<Vec<_>>()
                .join("/")
        );
        let zip_path = temp.join("deep.zip");
        zip_with(&zip_path, vec![(deep, fixture_cur())]);

        let err = import_zip(zip_path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("层级过深"), "实际：{err}");
    }

    fn write_theme_json(dir: &Path, theme: &CursorTheme) {
        fs::create_dir_all(dir.join("cursors")).expect("建主题目录");
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(theme).expect("序列化"),
        )
        .expect("写 theme.json");
    }

    fn sample_theme(id: &str, file_path: &str) -> CursorTheme {
        CursorTheme {
            id: id.to_string(),
            name: "样例".to_string(),
            description: String::new(),
            created_at: "2026-01-01 00:00".to_string(),
            updated_at: "2026-01-01 00:00".to_string(),
            is_built_in: false,
            cursors: vec![CursorSlot {
                registry_key: "Arrow".to_string(),
                display_name: "正常选择".to_string(),
                english_name: "Normal Select".to_string(),
                file_path: file_path.to_string(),
                file_type: "cur".to_string(),
            }],
        }
    }

    /// theme.id 与目录名不一致的目录必须跳过，不能显示成一套来历不明的主题
    #[test]
    fn 读取时跳过_id_与目录名不一致的主题() {
        let temp = TempDir::new("id-mismatch");
        let _guard = temp.isolate_paths();

        let dir = paths::theme_dir("11111111-1111-4111-8111-111111111111")
            .expect("解析主题目录");
        fs::create_dir_all(dir.join("cursors")).expect("建目录");
        fs::write(dir.join("cursors/arrow.cur"), fixture_cur()).expect("写光标");
        write_theme_json(
            &dir,
            &sample_theme("22222222-2222-4222-8222-222222222222", "cursors/arrow.cur"),
        );

        let (themes, warnings) = read_user_themes();
        assert!(themes.is_empty(), "id 不一致的主题不能被读出");
        assert!(
            warnings.iter().any(|w| w.contains("不一致")),
            "应给出可诊断的 warning：{warnings:?}"
        );
    }

    /// 槽位路径越出主题目录：只丢弃该槽位，不把路径交给预览/应用
    #[test]
    fn 读取时丢弃越出主题目录的槽位() {
        let temp = TempDir::new("escape-slot");
        let _guard = temp.isolate_paths();

        let id = "33333333-3333-4333-8333-333333333333";
        let dir = paths::theme_dir(id).expect("解析主题目录");
        fs::create_dir_all(dir.join("cursors")).expect("建目录");
        fs::write(dir.join("cursors/arrow.cur"), fixture_cur()).expect("写光标");
        write_theme_json(&dir, &sample_theme(id, r"C:\Windows\Cursors\aero_arrow.cur"));

        let (themes, warnings) = read_user_themes();
        assert!(themes.is_empty(), "唯一槽位越界时整套主题没有可用槽位");
        assert!(
            warnings.iter().any(|w| w.contains("越出主题目录")),
            "应说明被丢弃的原因：{warnings:?}"
        );
    }

    /// 旧绝对路径能相对化时，读取阶段就回写一次，别每次启动都靠内存修补
    #[test]
    fn 读取时把旧绝对路径回写为相对路径() {
        let temp = TempDir::new("repair-absolute");
        let _guard = temp.isolate_paths();

        let id = "44444444-4444-4444-8444-444444444444";
        let dir = paths::theme_dir(id).expect("解析主题目录");
        let cursor = dir.join("cursors").join("arrow.cur");
        fs::create_dir_all(cursor.parent().unwrap()).expect("建目录");
        fs::write(&cursor, fixture_cur()).expect("写光标");
        write_theme_json(&dir, &sample_theme(id, &cursor.to_string_lossy()));

        let (themes, warnings) = read_user_themes();
        assert_eq!(themes.len(), 1);
        assert_eq!(
            Path::new(&themes[0].cursors[0].file_path),
            cursor,
            "内存里仍返回绝对路径，预览/应用不用改"
        );
        assert!(warnings.is_empty(), "可修复的旧路径不该产生警告：{warnings:?}");

        let raw = fs::read_to_string(dir.join("theme.json")).expect("读回 theme.json");
        let stored: CursorTheme = serde_json::from_str(&raw).expect("解析 theme.json");
        assert_eq!(stored.cursors[0].file_path, "cursors/arrow.cur");
    }

    /// 磁盘上的主题不能自称系统方案，否则会混进系统分组骗用户
    #[test]
    fn 读取时拒绝伪装成系统方案的主题() {
        let temp = TempDir::new("fake-built-in");
        let _guard = temp.isolate_paths();

        let id = "55555555-5555-4555-8555-555555555555";
        let dir = paths::theme_dir(id).expect("解析主题目录");
        fs::create_dir_all(dir.join("cursors")).expect("建目录");
        fs::write(dir.join("cursors/arrow.cur"), fixture_cur()).expect("写光标");
        let mut theme = sample_theme(id, "cursors/arrow.cur");
        theme.is_built_in = true;
        write_theme_json(&dir, &theme);

        let (themes, warnings) = read_user_themes();
        assert!(themes.is_empty(), "伪装成系统方案的主题必须丢弃");
        assert!(
            warnings.iter().any(|w| w.contains("系统方案")),
            "要说清为什么跳过：{warnings:?}"
        );
    }

    /// 超大 theme.json 不能整个读进内存，按损坏主题跳过并给警告
    /// `.inf` 与光标文件共用同一份额度，不能靠堆说明书绕过导入限额
    #[test]
    fn inf_也受条目预算约束() {
        let temp = TempDir::new("inf-budget");
        for i in 0..=limits::THEME_LIMITS.max_entries {
            fs::write(temp.path().join(format!("{i}.inf")), "").expect("写 .inf");
        }

        let mut budget = limits::ScanBudget::new(&limits::THEME_LIMITS);
        let mut warnings = Vec::new();
        let mut files = Vec::new();
        let err = collect_inf_files(temp.path(), 0, &mut budget, &mut warnings, &mut files)
            .unwrap_err();
        assert!(err.contains("文件太多"), "实际：{err}");
    }

    #[test]
    fn 超过上限的_theme_json_被跳过() {
        let temp = TempDir::new("oversized-theme-json");
        let _guard = temp.isolate_paths();

        let id = "66666666-6666-4666-8666-666666666666";
        let dir = paths::theme_dir(id).expect("解析主题目录");
        fs::create_dir_all(&dir).expect("建目录");
        fs::write(
            dir.join("theme.json"),
            "x".repeat(limits::MAX_THEME_JSON_BYTES as usize + 1),
        )
        .expect("写超大 theme.json");

        let (themes, warnings) = read_user_themes();
        assert!(themes.is_empty());
        assert!(
            warnings.iter().any(|w| w.contains("上限")),
            "警告要说明尺寸超限：{warnings:?}"
        );
    }
}
