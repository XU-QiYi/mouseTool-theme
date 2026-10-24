use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use uuid::Uuid;

use crate::models::{ApplyOutcome, CursorSlot, CursorTheme, ThemesResult};
use crate::utils::{history, importer, inf_export, paths, registry};

/// `export_theme` 的返回值：跳过项要说清是哪个槽位，否则用户不知道少了什么
#[derive(Debug, Serialize)]
pub struct ExportSummary {
    /// 实际写进压缩包的光标文件数
    pub file_count: usize,
    /// 被跳过的槽位及原因
    pub skipped: Vec<String>,
}

/// 聚合各数据源：单个来源失败只降级为 warning，不拖垮其余来源
///
/// 抽成纯函数是为了能单测"部分成功"契约——这是本模块的核心策略，
/// 没有测试的话，把 `Err` 改回 `?` 整体失败不会被任何测试拦住。
fn merge_sources(
    system: Result<Vec<CursorTheme>, String>,
    user: (Vec<CursorTheme>, Vec<String>),
) -> (Vec<CursorTheme>, Vec<String>) {
    let mut warnings = Vec::new();

    let mut themes = match system {
        Ok(schemes) => schemes,
        Err(err) => {
            warnings.push(format!("系统光标方案没能加载：{err}"));
            Vec::new()
        }
    };

    let (user_themes, user_warnings) = user;
    themes.extend(user_themes);
    warnings.extend(user_warnings);

    (themes, warnings)
}

/// 路径比较口径：Windows 路径不区分大小写，正反斜杠等价
fn normalize_path(path: &str) -> String {
    path.trim().replace('/', "\\").to_lowercase()
}

/// 主题与注册表里当前生效的光标是否为同一套
///
/// 双向覆盖：主题定义的槽位都要能在注册表里对上，注册表里的非空槽位也要都能
/// 在主题里找到。只查单向会把「某主题是当前方案的子集」误判成正在使用。
fn theme_matches_current(theme: &CursorTheme, current: &[(String, String)]) -> bool {
    if current.is_empty() {
        return false;
    }

    let theme_slots: Vec<&CursorSlot> = theme
        .cursors
        .iter()
        .filter(|slot| !slot.file_path.trim().is_empty())
        .collect();

    if theme_slots.len() != current.len() {
        return false;
    }

    theme_slots.iter().all(|slot| {
        current.iter().any(|(key, path)| {
            *key == slot.registry_key && normalize_path(path) == normalize_path(&slot.file_path)
        })
    }) && current.iter().all(|(key, path)| {
        theme_slots.iter().any(|slot| {
            slot.registry_key == *key && normalize_path(&slot.file_path) == normalize_path(path)
        })
    })
}

/// 从主题列表里挑出注册表当前正在使用的那一个
///
/// 多套主题指向同一批文件时（同一方案的两份副本）按注册表方案名择一，
/// 名字都对不上就取列表里的第一个——文件路径完全一致时，选谁都不会错。
fn detect_active_theme(
    themes: &[CursorTheme],
    current: &[(String, String)],
    scheme_name: &str,
) -> Option<String> {
    let candidates: Vec<&CursorTheme> = themes
        .iter()
        .filter(|theme| theme_matches_current(theme, current))
        .collect();

    let chosen = candidates
        .iter()
        .find(|theme| theme.name == scheme_name)
        .or_else(|| candidates.first())?;

    Some(chosen.id.clone())
}

/// 获取所有主题：系统注册表方案 + 已导入的用户主题
///
/// 两个来源独立容错：注册表读失败只降级为一条 warning，不整体失败——
/// 否则本来能显示的用户主题会跟着一起消失。
///
/// 顺带反推「当前正在使用哪个主题」：界面不能靠内存记住这件事，
/// 否则重开窗口后会把已应用的主题当成可用主题，允许再点一次「应用」。
#[tauri::command]
pub fn get_all_themes() -> Result<ThemesResult, String> {
    let (themes, mut warnings) = merge_sources(
        registry::read_system_schemes(),
        importer::read_user_themes(),
    );

    let active_theme_id = match registry::read_current_slots() {
        Ok(current) => detect_active_theme(&themes, &current, &registry::read_scheme_name()),
        Err(err) => {
            // 识别不出就当作「没有正在使用的主题」：少标一个「使用中」可以接受，
            // 标错了会让人以为已经应用成功
            warnings.push(format!("无法识别当前正在使用的主题：{err}"));
            None
        }
    };

    // 历史是附属数据：读坏了只提示，不影响主题列表
    let (recent, history_warnings) = history::read_history();
    warnings.extend(history_warnings);

    Ok(ThemesResult {
        themes,
        warnings,
        active_theme_id,
        recent,
    })
}

/// 导入主题来源（`.zip` 包或整个文件夹，决策 16），返回新主题
#[tauri::command]
pub fn import_theme(source_path: String) -> Result<CursorTheme, String> {
    importer::import_source(&source_path)
}

/// 把主题应用到系统：写注册表后立即刷新，无需注销
///
/// 顺带记一条「最近使用」。历史是附属信息：写失败不影响「已应用」这个事实，
/// 但要把原因回传，由界面说明「光标切了，只是没记上」，不能静默吞掉。
#[tauri::command]
pub fn apply_theme(theme: CursorTheme) -> Result<ApplyOutcome, String> {
    registry::write_cursors(&theme.cursors, &theme.name)?;
    registry::refresh_cursors()?;

    match history::record(&theme) {
        Ok(recent) => Ok(ApplyOutcome {
            recent,
            warning: None,
        }),
        Err(err) => {
            let (recent, _) = history::read_history();
            Ok(ApplyOutcome {
                recent,
                warning: Some(err),
            })
        }
    }
}

/// 恢复系统默认光标
#[tauri::command]
pub fn restore_default() -> Result<(), String> {
    registry::clear_cursors()?;
    registry::refresh_cursors()
}

/// 删除一个已导入的主题（连同它的光标文件目录）
///
/// 只接受 UUID。theme_id 来自前端，必须校验格式——否则传入 `../` 之类的值
/// 会让 `theme_dir` 拼到数据目录之外，误删用户其它文件。
#[tauri::command]
pub fn delete_theme(theme_id: String) -> Result<(), String> {
    let id = Uuid::parse_str(&theme_id).map_err(|_| "非法的主题 ID".to_string())?;
    let dir = paths::theme_dir(&id.to_string());

    if !dir.exists() {
        return Err("这个主题已经不在了，可能要重新导入".to_string());
    }

    fs::remove_dir_all(&dir).map_err(|err| {
        format!("删不掉主题目录，它可能正被其它程序占用（{err}）")
    })?;
    Ok(())
}

/// 重命名已导入的主题
///
/// 只改 theme.json 里的显示名，目录名仍是 UUID（改目录会影响正在使用的
/// 光标路径）。`updated_at` 保持导入时间不变——界面上它承担的是「导入于」。
#[tauri::command]
pub fn rename_theme(theme_id: String, new_name: String) -> Result<CursorTheme, String> {
    let id = Uuid::parse_str(&theme_id).map_err(|_| "非法的主题 ID".to_string())?;
    let name = new_name.trim();

    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if name.chars().count() > 40 {
        return Err("名称最多 40 个字".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("名称不能包含换行或控制字符".to_string());
    }

    let json_path = paths::theme_dir(&id.to_string()).join("theme.json");
    if !json_path.exists() {
        return Err("找不到这个主题，它可能已被删除".to_string());
    }

    let raw = fs::read_to_string(&json_path).map_err(|err| format!("读不到主题信息（{err}）"))?;
    let mut theme: CursorTheme =
        serde_json::from_str(&raw).map_err(|err| format!("主题信息已损坏，无法改名（{err}）"))?;

    theme.name = name.to_string();

    let json =
        serde_json::to_string_pretty(&theme).map_err(|err| format!("保存主题信息失败（{err}）"))?;
    fs::write(&json_path, json).map_err(|err| format!("保存主题信息失败（{err}）"))?;

    Ok(theme)
}

/// 导出主题为 zip 主题包
///
/// 文件名按槽位重命名（`arrow.cur` / `busy.ani`），这样对方导入时能靠文件名
/// 反推槽位，形成「导出→再导入」的闭环。系统方案（注册表）同样能导出，
/// 因为它们也有光标文件路径。
///
/// 包根额外附带 `<方案名>.inf`（决策 13）：接收方没装本软件时，解压后右键
/// 安装即可把方案装进 Windows。生成逻辑在 `utils/inf_export`；导入端只认
/// `.cur/.ani/.ico`，会自动忽略这个文件，闭环不受影响。
#[tauri::command]
pub fn export_theme(theme: CursorTheme, dest_path: String) -> Result<ExportSummary, String> {
    let dest = Path::new(&dest_path);
    let parent = dest.parent().ok_or_else(|| "目标路径无效".to_string())?;
    if !parent.exists() {
        return Err(format!("目标文件夹不存在：{}", parent.display()));
    }

    let file =
        fs::File::create(dest).map_err(|err| format!("无法创建文件，它可能正被占用（{err}）"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();

    let mut seen: HashSet<&str> = HashSet::new();
    let mut file_count = 0usize;
    let mut skipped: Vec<String> = Vec::new();
    // 能进 .inf 的槽位：(槽位键名, 扩展名)
    let mut inf_files: Vec<(String, String)> = Vec::new();

    for slot in &theme.cursors {
        if !seen.insert(slot.registry_key.as_str()) {
            continue;
        }

        let src = Path::new(&slot.file_path);
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        let Some(ext) = ext.filter(|e| matches!(e.as_str(), "cur" | "ani" | "ico")) else {
            skipped.push(format!("{}（不是光标文件）", slot.display_name));
            continue;
        };

        let Ok(data) = fs::read(src) else {
            skipped.push(format!("{}（源文件不存在）", slot.display_name));
            continue;
        };

        let name = format!("{}.{ext}", slot.registry_key.to_lowercase());
        writer
            .start_file(name, options)
            .map_err(|err| format!("打包失败（{err}）"))?;
        writer
            .write_all(&data)
            .map_err(|err| format!("写入压缩包失败（{err}）"))?;
        file_count += 1;

        // .ico 不能被 Windows 当作光标加载：照常导出，但不进 .inf，
        // 否则装出来的方案在「应用」时这些槽位会失效
        if matches!(ext.as_str(), "cur" | "ani") {
            inf_files.push((slot.registry_key.clone(), ext.clone()));
        }
    }

    if file_count == 0 {
        // 先关掉句柄再删，否则 Windows 上文件被占用删不掉，会留个空 zip
        drop(writer);
        let _ = fs::remove_file(dest);
        return Err("没有可导出的光标文件，源文件可能已被移动或删除".to_string());
    }

    // 附带通用安装文件：接收方没装本软件也能右键安装（决策 13）
    if !inf_files.is_empty() {
        let inf_name = format!("{}.inf", inf_export::sanitize_scheme_name(&theme.name));
        writer
            .start_file(inf_name, options)
            .map_err(|err| format!("打包失败（{err}）"))?;
        writer
            .write_all(&inf_export::build_inf(&theme.name, &inf_files))
            .map_err(|err| format!("写入压缩包失败（{err}）"))?;
    }

    writer
        .finish()
        .map_err(|err| format!("生成压缩包失败（{err}）"))?;

    Ok(ExportSummary {
        file_count,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_theme(id: &str) -> CursorTheme {
        CursorTheme {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            is_built_in: false,
            cursors: Vec::new(),
        }
    }

    /// 回归测试：注册表读失败时，用户主题不该跟着消失
    ///
    /// 修之前的行为是 `read_system_schemes()?` 一错全错，用户主题读都没读。
    #[test]
    fn 注册表失败时用户主题仍应返回() {
        let (themes, warnings) = merge_sources(
            Err("无法打开注册表键".to_string()),
            (vec![fake_theme("user-1")], Vec::new()),
        );
        assert_eq!(themes.len(), 1, "用户主题必须保留");
        assert_eq!(themes[0].id, "user-1");
        assert_eq!(warnings.len(), 1, "失败来源要能被指认");
        assert!(warnings[0].contains("注册表"), "warning 要说清是哪个来源");
    }

    #[test]
    fn 各来源的警告应独立累积() {
        let (themes, warnings) = merge_sources(
            Ok(vec![fake_theme("sys_a")]),
            (vec![fake_theme("user-1")], vec!["某个主题坏了".to_string()]),
        );
        assert_eq!(themes.len(), 2);
        assert_eq!(warnings.len(), 1, "用户来源的警告不能被吞掉");
    }

    fn theme_with_slots(id: &str, name: &str, slots: &[(&str, &str)]) -> CursorTheme {
        CursorTheme {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            is_built_in: false,
            cursors: slots
                .iter()
                .map(|(key, path)| CursorSlot {
                    registry_key: (*key).to_string(),
                    display_name: String::new(),
                    english_name: String::new(),
                    file_path: (*path).to_string(),
                    file_type: "cur".to_string(),
                })
                .collect(),
        }
    }

    fn current(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, path)| ((*key).to_string(), (*path).to_string()))
            .collect()
    }

    #[test]
    fn 大小写与斜杠差异不影响识别() {
        let theme = theme_with_slots("a", "A", &[("Arrow", r"C:\Cursors\Arrow.cur")]);
        let slots = current(&[("Arrow", "c:/cursors/ARROW.cur")]);

        assert_eq!(
            detect_active_theme(&[theme], &slots, "").as_deref(),
            Some("a"),
            "注册表大小写与斜杠写法不该让人以为主题没被应用"
        );
    }

    #[test]
    fn 槽位集合不同就不算同一套() {
        let theme = theme_with_slots(
            "a",
            "A",
            &[("Arrow", r"C:\A\arrow.cur"), ("Hand", r"C:\A\hand.cur")],
        );

        // 子集：少了 Hand，说明系统里还有别的光标，不是这套主题
        let subset = current(&[("Arrow", r"C:\A\arrow.cur")]);
        assert!(detect_active_theme(&[theme.clone()], &subset, "").is_none());

        // 超集：多出 Wait，同上
        let superset = current(&[
            ("Arrow", r"C:\A\arrow.cur"),
            ("Hand", r"C:\A\hand.cur"),
            ("Wait", r"C:\A\wait.cur"),
        ]);
        assert!(detect_active_theme(&[theme], &superset, "").is_none());
    }

    #[test]
    fn 槽位路径不同就不算同一套() {
        let theme = theme_with_slots("a", "A", &[("Arrow", r"C:\A\arrow.cur")]);
        let slots = current(&[("Arrow", r"C:\B\arrow.cur")]);
        assert!(detect_active_theme(&[theme], &slots, "").is_none());
    }

    #[test]
    fn 系统默认光标下没有正在使用的主题() {
        let theme = theme_with_slots("a", "A", &[("Arrow", r"C:\A\arrow.cur")]);
        assert!(
            detect_active_theme(&[theme], &[], "").is_none(),
            "槽位全空 = 系统默认，不该标记任何主题"
        );
    }

    #[test]
    fn 文件相同的时候按方案名择一() {
        let slots = current(&[("Arrow", r"C:\A\arrow.cur")]);
        let themes = vec![
            theme_with_slots("copy-1", "副本一", &[("Arrow", r"C:\A\arrow.cur")]),
            theme_with_slots("copy-2", "副本二", &[("Arrow", r"C:\A\arrow.cur")]),
        ];

        assert_eq!(
            detect_active_theme(&themes, &slots, "副本二").as_deref(),
            Some("copy-2")
        );

        // 方案名对不上（例如改名后注册表还是旧名）时退化为第一个，不能返回 None
        assert_eq!(
            detect_active_theme(&themes, &slots, "改过的新名字").as_deref(),
            Some("copy-1")
        );
    }

    /// 安全测试：theme_id 是字符串拼接进路径的，未校验时传 `../` 会越出数据目录
    #[test]
    fn 非法主题_id_不能穿出数据目录() {
        for bad in ["../evil", "..\\evil", "a/b", "", "not-a-uuid"] {
            let err = delete_theme(bad.to_string()).unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 应被拒绝，实际：{err}");

            let err = rename_theme(bad.to_string(), "x".to_string()).unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 改名也应被拒绝，实际：{err}");
        }
    }

    /// 名称校验发生在碰文件系统之前，所以不需要真实目录
    #[test]
    fn 改名的名称校验() {
        let id = Uuid::new_v4().to_string();

        let err = rename_theme(id.clone(), "   ".to_string()).unwrap_err();
        assert!(err.contains("不能为空"), "实际：{err}");

        let err = rename_theme(id.clone(), "字".repeat(41)).unwrap_err();
        assert!(err.contains("40"), "实际：{err}");

        let err = rename_theme(id, "a\nb".to_string()).unwrap_err();
        assert!(err.contains("控制字符"), "实际：{err}");
    }

    #[test]
    fn 改名应去掉首尾空格且不动导入时间() {
        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id);
        paths::ensure_dir(&dir).expect("建临时主题目录");
        let theme = fake_theme(&id);
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).unwrap(),
        )
        .expect("写入初始 theme.json");

        let outcome = rename_theme(id.clone(), "  新名字  ".to_string());

        let saved: CursorTheme = serde_json::from_str(
            &fs::read_to_string(dir.join("theme.json")).expect("读回 theme.json"),
        )
        .expect("解析 theme.json");

        fs::remove_dir_all(&dir).ok();

        let renamed = outcome.expect("改名应成功");
        assert_eq!(renamed.name, "新名字", "首尾空格应被去掉");
        assert_eq!(saved.name, "新名字", "改名结果必须落盘");
        assert_eq!(saved.updated_at, "", "改名不应改动导入时间");
    }

    /// 导出必须形成闭环：文件名按槽位重命名，再导入能还原成同一个槽位
    #[test]
    fn 导出再导入应还原槽位() {
        let cur = std::fs::read(r"C:\Windows\Cursors\aero_arrow.cur").expect("需要系统光标文件");

        let src_dir = std::env::temp_dir().join("cursortheme-export-src");
        fs::create_dir_all(&src_dir).expect("建临时源目录");
        // 故意用不可识别的源文件名，验证导出时会按槽位重命名
        let src_file = src_dir.join("随便起的名字.cur");
        fs::write(&src_file, &cur).expect("写入临时光标");
        let src_path = src_file.to_string_lossy().to_string();

        let theme = theme_with_slots("export-test", "导出测试", &[("SizeNWSE", &src_path)]);
        let zip_path = std::env::temp_dir().join("cursortheme-export-roundtrip.zip");

        let summary = export_theme(theme, zip_path.to_string_lossy().into_owned())
            .expect("导出应成功");
        assert_eq!(summary.file_count, 1);
        assert!(summary.skipped.is_empty(), "不该有跳过项");

        // 包内 = 槽位命名的光标文件 + 通用安装文件
        let file = fs::File::open(&zip_path).expect("打开导出的 zip");
        let mut archive = zip::ZipArchive::new(file).expect("解析导出的 zip");
        assert_eq!(archive.len(), 2, "光标文件 + .inf，不应有其它内容");

        let mut inf_bytes = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
            if entry.name().ends_with(".inf") {
                inf_bytes = buf;
            } else {
                assert_eq!(entry.name(), "sizenwse.cur", "光标文件必须按槽位命名");
            }
        }
        assert!(
            archive.by_name("导出测试.inf").is_ok(),
            ".inf 应以方案名命名（zip 2.x 对非 ASCII 名自动置 UTF-8 标志）"
        );

        // .inf 字节层面：UTF-16LE BOM；内容层面：方案串与槽位路径齐全
        assert_eq!(&inf_bytes[..2], &[0xFF, 0xFE], "必须是 UTF-16LE BOM 开头");
        let units: Vec<u16> = inf_bytes[2..]
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        let inf_text = String::from_utf16(&units).expect(".inf 必须是合法 UTF-16");
        assert!(inf_text.contains("signature=\"$CHICAGO$\""));
        assert!(inf_text.contains("%10%\\%CUR_DIR%\\sizenwse.cur"));
        assert!(inf_text.contains("SCHEME_NAME = \"导出测试\""));
        drop(archive);

        // 闭环：再导入仍只认光标文件，.inf 自动忽略，槽位还原不变
        let reimported =
            importer::import_zip(zip_path.to_str().unwrap()).expect("重新导入应成功");
        assert_eq!(reimported.cursors.len(), 1);
        assert_eq!(reimported.cursors[0].registry_key, "SizeNWSE");
        assert_eq!(reimported.cursors[0].display_name, "对角线调整 1");

        fs::remove_dir_all(&src_dir).ok();
        fs::remove_file(&zip_path).ok();
        fs::remove_dir_all(paths::theme_dir(&reimported.id)).ok();
    }

    /// 源文件全缺失时，必须报错，且不能留下空 zip 骗用户
    #[test]
    fn 源文件全缺失时不该留下空压缩包() {
        let theme = theme_with_slots(
            "empty-test",
            "空测试",
            &[("Arrow", r"C:\这个文件根本不存在\arrow.cur")],
        );
        let zip_path = std::env::temp_dir().join("cursortheme-export-empty.zip");

        let err = export_theme(theme, zip_path.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("没有可导出"), "实际：{err}");
        assert!(
            !Path::new(&zip_path).exists(),
            "失败时不能留下空压缩包"
        );
    }

    /// 把一份真实导出的 .inf 抽到系统临时目录，方便用记事本打开人工检查
    /// 格式（UTF-16LE 在记事本里正常显示），也可以拿去做右键安装的真机验收
    #[test]
    fn 导出的_inf_样例落到临时目录供人工检查() {
        let cur = std::fs::read(r"C:\Windows\Cursors\aero_arrow.cur").expect("需要系统光标文件");
        let ani = std::fs::read(r"C:\Windows\Cursors\荧1.0\arrow.ani").expect("需要系统动态光标");

        let src_dir = std::env::temp_dir().join("cursortheme-inf-sample-src");
        fs::create_dir_all(&src_dir).expect("建临时源目录");
        let arrow_path = src_dir.join("a.cur");
        let wait_path = src_dir.join("b.ani");
        fs::write(&arrow_path, &cur).expect("写入临时光标");
        fs::write(&wait_path, &ani).expect("写入临时光标");

        let theme = theme_with_slots(
            "sample",
            "样例方案",
            &[
                ("Arrow", arrow_path.to_str().unwrap()),
                ("Wait", wait_path.to_str().unwrap()),
            ],
        );
        let zip_path = std::env::temp_dir().join("cursortheme-inf-sample.zip");
        export_theme(theme, zip_path.to_string_lossy().into_owned()).expect("导出应成功");

        let file = fs::File::open(&zip_path).expect("打开导出的 zip");
        let mut archive = zip::ZipArchive::new(file).expect("解析导出的 zip");
        let bytes = {
            let mut entry = archive.by_name("样例方案.inf").expect("应有 .inf");
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).expect("读取 .inf");
            buf
        };
        drop(archive);

        let sample = std::env::temp_dir().join("cursortheme-导出样例.inf");
        fs::write(&sample, &bytes).expect("写样例");

        fs::remove_dir_all(&src_dir).ok();
        fs::remove_file(&zip_path).ok();
        println!("样例已写到 {}", sample.display());
    }

    /// 删除是破坏性操作：既要真的把目录删掉，重复删除也要给人话而不是崩溃
    #[test]
    fn 删除应移除主题目录且重复删除有提示() {
        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id);
        paths::ensure_dir(&dir).expect("建临时主题目录");
        fs::write(dir.join("theme.json"), "{}").expect("写占位文件");
        assert!(dir.exists());

        delete_theme(id.clone()).expect("删除应成功");
        assert!(!dir.exists(), "主题目录必须被真正删掉");

        let err = delete_theme(id).unwrap_err();
        assert!(err.contains("已经不在了"), "重复删除应给人话提示，实际：{err}");
    }
}
