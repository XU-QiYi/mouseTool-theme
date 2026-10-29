use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::{
    ActiveState, ApplyOutcome, CursorSlot, CursorTheme, HistoryEntry, ThemeFileGap, ThemesResult,
};
use crate::utils::{
    capture, history, importer, inf_export, limits, ops, paths, registry, theme_paths, trash,
    tray, validation,
};

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

/// 剥掉 canonicalize 产生的扩展长度前缀
///
/// `\\?\` 会让 Win32 按字面量处理路径，反而挡住后面的短名展开；`\\?\UNC\` 要
/// 还原成 `\\server\share` 才能和普通写法对上。
fn strip_device_prefix(path: &str) -> String {
    path.strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or_else(|| path.strip_prefix(r"\\?\").unwrap_or(path).to_string())
}

/// 路径比较口径：两侧都落到同一个规范空间，而不是逐条补命名差异
///
/// 应用主题时写进注册表的是 `fs::canonicalize` 之后的路径，主题侧存的是拼接出来
/// 的普通写法。只剥前缀加转小写挡不住这两类差异：Windows 的 8.3 短名（CI runner
/// 的临时目录是 `C:\Users\RUNNER~1\...`，canonical 之后是 `...\runneradmin\...`，
/// 同一个目录两种写法）和 reparse 点展开。所以普通写法也走一次 canonicalize。
/// 展不动（文件已删）或本来就是相对路径（不该拿进程 CWD 去猜）时退回原写法，
/// 与改动前行为一致。
fn normalize_path(path: &str) -> String {
    let plain = strip_device_prefix(&path.trim().replace('/', "\\"));
    if plain.is_empty() || !Path::new(&plain).is_absolute() {
        return plain.to_lowercase();
    }
    match fs::canonicalize(&plain) {
        Ok(resolved) => strip_device_prefix(&resolved.to_string_lossy()).to_lowercase(),
        Err(_) => plain.to_lowercase(),
    }
}

/// 主题与注册表里当前生效的光标是否为同一套
///
/// 双向覆盖：主题定义的槽位都要能在注册表里对上，注册表里的非空槽位也要都能
/// 在主题里找到。只查单向会把「某主题是当前方案的子集」误判成正在使用。
///
/// 先比非空槽位数再归一化：`normalize_path` 现在会开文件句柄，绝大多数主题与
/// 当前方案的槽位数不同，让它们白付这批系统调用不值。
fn theme_matches_current(theme: &CursorTheme, current: &[(String, String)]) -> bool {
    if current.is_empty() {
        return false;
    }

    let non_empty = theme
        .cursors
        .iter()
        .filter(|slot| !slot.file_path.trim().is_empty())
        .count();
    if non_empty != current.len() {
        return false;
    }

    let theme_slots: Vec<(&str, String)> = theme
        .cursors
        .iter()
        .filter(|slot| !slot.file_path.trim().is_empty())
        .map(|slot| (slot.registry_key.as_str(), normalize_path(&slot.file_path)))
        .collect();
    let current_slots: Vec<(&str, String)> = current
        .iter()
        .map(|(key, path)| (key.as_str(), normalize_path(path)))
        .collect();

    theme_slots.iter().all(|(key, path)| {
        current_slots
            .iter()
            .any(|(other_key, other_path)| other_key == key && other_path == path)
    }) && current_slots.iter().all(|(key, path)| {
        theme_slots
            .iter()
            .any(|(other_key, other_path)| other_key == key && other_path == path)
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

/// 从注册表反推「当前使用」的完整状态
///
/// `read_current_slots` 只返回非空槽位，所以它的长度就是非空槽位数。
/// 注册表读失败时不猜：既不标主题也不判外部改写，把原因带回给调用方。
pub(crate) struct ActiveInfo {
    pub id: Option<String>,
    pub filled: usize,
    pub external: bool,
    pub warning: Option<String>,
}

fn probe_active(themes: &[CursorTheme]) -> ActiveInfo {
    match registry::read_current_slots() {
        Ok(current) => {
            let filled = current.len();
            let id = detect_active_theme(themes, &current, &registry::read_scheme_name());
            // 槽位有值却不属于任何已知主题：系统设置页选样式、经典面板
            // 手改、或其它光标工具写入了注册表（2026-10-26 真机实验）
            let external = id.is_none() && filled > 0;
            ActiveInfo {
                id,
                filled,
                external,
                warning: None,
            }
        }
        Err(err) => ActiveInfo {
            id: None,
            filled: 0,
            external: false,
            warning: Some(format!("无法识别当前正在使用的主题：{err}")),
        },
    }
}

/// 获取所有主题：系统注册表方案 + 已导入的用户主题
///
/// 两个来源独立容错：注册表读失败只降级为一条 warning，不整体失败——
/// 否则本来能显示的用户主题会跟着一起消失。
///
/// 顺带反推「当前正在使用哪个主题」：界面不能靠内存记住这件事，
/// 否则重开窗口后会把已应用的主题当成可用主题，允许再点一次「应用」。
#[tauri::command]
pub async fn get_all_themes() -> Result<ThemesResult, String> {
    tauri::async_runtime::spawn_blocking(all_themes)
        .await
        .map_err(|err| format!("读取主题列表任务异常退出（{err}）"))?
}

/// 聚合完成的主题快照：清单 + 反推的使用状态 + 派生的最近主题
///
/// 界面命令与托盘菜单（决策 30）要的是同一份事实，抽出来共用，
/// 两边对「当前是谁、最近用过什么」的答案才不会漂移。
pub(crate) struct ThemesSnapshot {
    pub themes: Vec<CursorTheme>,
    pub warnings: Vec<String>,
    pub active: ActiveInfo,
    pub recent: Vec<HistoryEntry>,
}

impl ThemesSnapshot {
    /// 无数据的空快照：托盘初建时先用它拼出「打开 / 退出」菜单，
    /// 主题区随后由 `tray::refresh` 异步补齐，不在启动路径里做 I/O
    pub(crate) fn empty() -> Self {
        Self {
            themes: Vec::new(),
            warnings: Vec::new(),
            active: ActiveInfo {
                id: None,
                filled: 0,
                external: false,
                warning: None,
            },
            recent: Vec::new(),
        }
    }
}

pub(crate) fn collect_snapshot() -> ThemesSnapshot {
    let (themes, mut warnings) = merge_sources(
        registry::read_system_schemes(),
        importer::read_user_themes(),
    );

    let active = probe_active(&themes);
    // 识别不出就当作「没有正在使用的主题」：少标一个「使用中」可以接受，
    // 标错了会让人以为已经应用成功
    if let Some(warn) = active.warning.clone() {
        warnings.push(warn);
    }

    // 历史是附属数据：读坏了只提示，不影响主题列表
    let (recent, history_warnings) = history::read_history();
    warnings.extend(history_warnings);

    ThemesSnapshot {
        themes,
        warnings,
        active,
        recent,
    }
}

fn all_themes() -> Result<ThemesResult, String> {
    let snapshot = collect_snapshot();
    // 文件完整性（决策 31）：读列表时顺带体检一遍。只 stat 不读内容，
    // 15 槽位 × 主题数的代价可忽略；托盘与聚焦重查用不到它，不进 collect_snapshot
    let file_gaps = snapshot
        .themes
        .iter()
        .filter_map(|theme| {
            let slots = theme_paths::missing_slots(theme);
            (!slots.is_empty()).then(|| ThemeFileGap {
                theme_id: theme.id.clone(),
                slots,
            })
        })
        .collect();
    Ok(ThemesResult {
        themes: snapshot.themes,
        warnings: snapshot.warnings,
        active_theme_id: snapshot.active.id,
        current_slots_filled: snapshot.active.filled,
        active_external: snapshot.active.external,
        recent: snapshot.recent,
        file_gaps,
    })
}

/// 窗口聚焦时轻量重查「当前使用」（决策 24）
///
/// 系统设置页随时可能整体改写光标注册表，界面不重查就会带着旧的
/// 「正在使用」状态骗人。这里只做注册表与主题清单的比对，不重读历史，
/// 失败直接 `Err`——调用方（聚焦钩子）静默保留旧状态即可。
#[tauri::command]
pub async fn get_active_state() -> Result<ActiveState, String> {
    tauri::async_runtime::spawn_blocking(active_state)
        .await
        .map_err(|err| format!("读取当前光标状态任务异常退出（{err}）"))?
}

fn active_state() -> Result<ActiveState, String> {
    let (themes, _) = merge_sources(
        registry::read_system_schemes(),
        importer::read_user_themes(),
    );
    let info = probe_active(&themes);
    if let Some(err) = info.warning {
        return Err(err);
    }
    Ok(ActiveState {
        active_theme_id: info.id,
        current_slots_filled: info.filled,
        active_external: info.external,
    })
}

/// 导入主题来源（`.zip` 包或整个文件夹，决策 16），返回新主题与跳过项
///
/// 解压 / 扫描 / 复制都在后台线程执行，进度通过 `import-progress` 事件推给
/// 界面；导入期间其它重操作被互斥锁挡住。目录里的链接 / 目录联接会被跳过，
/// 原因随 `warnings` 返回，不能装作没看见。
#[tauri::command]
pub async fn import_theme(
    app: AppHandle,
    source_path: String,
) -> Result<importer::ImportReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("导入主题")?;
        let emitter = app.clone();
        importer::import_source_report(&source_path, &mut |progress| {
            let _ = emitter.emit("import-progress", progress);
        })
    })
    .await
    .map_err(|err| format!("导入任务异常退出（{err}）"))?
}

/// 应用 / 导出前的主题校验：槽位白名单、id 与目录一致、光标文件来源可信
///
/// 系统方案来自注册表，路径可能是用户手工指定的任意目录（Windows 的「已保存
/// 方案」允许），因此只做存在性与体积校验；用户主题的光标必须落在主题目录内。
fn checked_slots(theme: &CursorTheme) -> Result<Vec<CursorSlot>, String> {
    validation::validate_theme_slots(theme)?;
    let theme_dir = validation::ensure_theme_id_matches_dir(theme)?;

    let mut slots = theme.cursors.clone();
    for slot in &mut slots {
        let file = if theme.is_built_in {
            validation::ensure_readable_cursor_file(&slot.file_path)?
        } else {
            validation::ensure_cursor_file_in_theme(&slot.file_path, &theme_dir)?
        };
        slot.file_path = file.to_string_lossy().into_owned();
    }
    Ok(slots)
}

/// 把主题应用到系统：写注册表后立即刷新，无需注销
///
/// 顺带记一条「最近使用」。历史是附属信息：写失败不影响「已应用」这个事实，
/// 但要把原因回传，由界面说明「光标切了，只是没记上」，不能静默吞掉。
#[tauri::command]
pub async fn apply_theme(app: AppHandle, theme: CursorTheme) -> Result<ApplyOutcome, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || apply(&theme))
        .await
        .map_err(|err| format!("应用主题任务异常退出（{err}）"))?;
    // 菜单里的「最近使用」与勾选状态随应用结果变化（决策 30）
    tray::refresh(&app);
    outcome
}

fn apply(theme: &CursorTheme) -> Result<ApplyOutcome, String> {
    let slots = checked_slots(theme)?;
    registry::write_cursors(&slots, &theme.name)?;
    registry::refresh_cursors()?;

    match history::record(theme) {
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

/// 托盘快速切换（决策 30）：按 ID 从最新清单里取主题并应用
///
/// 菜单是重建时拍下的快照，点下去主题可能已被删除或迁移：找不到时返回
/// `Ok(false)`，托盘会重查菜单把过期条目摘掉，而不是报错吓人。校验完全
/// 复用 `apply`（槽位白名单、UUID 与目录一致性、光标文件落点），托盘点击
/// 与界面按钮不会走出两条安全口径。
pub(crate) fn apply_by_id(theme_id: &str) -> Result<bool, String> {
    let snapshot = collect_snapshot();
    let Some(theme) = snapshot.themes.iter().find(|theme| theme.id == theme_id) else {
        return Ok(false);
    };
    let theme = theme.clone();
    apply(&theme)?;
    Ok(true)
}

/// `save_current_theme` 的返回值
///
/// `applied = false` 有两种情况：有槽位没抄全（只保存、不改变当前光标），
/// 或抄全了但写注册表 / 刷新失败；`warning` 会给出具体原因。
#[derive(Debug, Serialize)]
pub struct SaveCurrentOutcome {
    pub theme: CursorTheme,
    /// 捕获时被跳过的槽位说明
    pub warnings: Vec<String>,
    /// 实际复制进新主题的光标文件数
    pub file_count: usize,
    pub applied: bool,
    pub recent: Vec<HistoryEntry>,
    pub warning: Option<String>,
}

/// 把当前注册表里的光标保存为「我的主题」并立即接管
///
/// 只读注册表 + 复制文件；当前已是已知主题时拒绝重复保存。有槽位没抄全时
/// 只保存不应用——自动应用会把那些没抄到的非空槽位写成空字符串，反而改变
/// 用户当前的光标设置。
#[tauri::command]
pub async fn save_current_theme(app: AppHandle) -> Result<SaveCurrentOutcome, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("保存当前光标")?;
        save_current()
    })
    .await
    .map_err(|err| format!("保存当前光标任务异常退出（{err}）"))?;
    // 抄全即接管：注册表变了，托盘勾选跟着变（决策 30）
    tray::refresh(&app);
    outcome
}

fn save_current() -> Result<SaveCurrentOutcome, String> {
    let current = registry::read_current_slots()?;
    if current.is_empty() {
        return Err("当前是系统默认光标，没有可保存的自定义光标".to_string());
    }

    // 当前已经是列表里的某套主题（系统方案或用户主题）时没有保存价值；
    // 注册表里的路径完全一致才算同一套，部分相似仍允许捕获。
    let (themes, _) = merge_sources(registry::read_system_schemes(), importer::read_user_themes());
    if let Some(id) = detect_active_theme(&themes, &current, &registry::read_scheme_name()) {
        let name = themes
            .iter()
            .find(|theme| theme.id == id)
            .map(|theme| theme.name.clone())
            .unwrap_or(id);
        return Err(format!("当前光标已经是「{name}」，无需再保存"));
    }

    let capture::CaptureReport {
        theme,
        warnings,
        file_count,
    } = capture::capture_current(&current)?;

    if !warnings.is_empty() {
        let (recent, _) = history::read_history();
        return Ok(SaveCurrentOutcome {
            theme,
            warnings,
            file_count,
            applied: false,
            recent,
            warning: Some(
                "有槽位没能保存，未自动应用；可在「我的主题」里检查后再手动应用".to_string(),
            ),
        });
    }

    match apply(&theme) {
        Ok(outcome) => Ok(SaveCurrentOutcome {
            theme,
            warnings,
            file_count,
            applied: true,
            recent: outcome.recent,
            warning: outcome.warning,
        }),
        Err(err) => {
            let (recent, _) = history::read_history();
            Ok(SaveCurrentOutcome {
                theme,
                warnings,
                file_count,
                applied: false,
                recent,
                warning: Some(format!("已保存为我的主题，但没能自动应用（{err}）")),
            })
        }
    }
}

/// 恢复系统默认光标
#[tauri::command]
pub async fn restore_default(app: AppHandle) -> Result<(), String> {
    let result = tauri::async_runtime::spawn_blocking(restore)
        .await
        .map_err(|err| format!("恢复默认光标任务异常退出（{err}）"))?;
    // 还原结果决定托盘「还原默认光标」的勾选（决策 30）
    tray::refresh(&app);
    result
}

pub(crate) fn restore() -> Result<(), String> {
    registry::clear_cursors()?;
    registry::refresh_cursors()
}

/// 删除一个已导入的主题：整目录移入回收站（可恢复，决策 26）
///
/// 只接受 UUID。theme_id 来自前端，必须校验格式——否则传入 `../` 之类的值
/// 会让 `theme_dir` 拼到数据目录之外，误删用户其它文件。
#[tauri::command]
pub async fn delete_theme(app: AppHandle, theme_id: String) -> Result<trash::DeleteOutcome, String> {
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("删除主题")?;
        delete(&theme_id)
    })
    .await
    .map_err(|err| format!("删除主题任务异常退出（{err}）"))?;
    // 主题没了，托盘菜单里的对应条目也该跟着消失（决策 30）
    tray::refresh(&app);
    outcome
}

fn delete(theme_id: &str) -> Result<trash::DeleteOutcome, String> {
    if !validation::is_canonical_uuid(theme_id) {
        return Err("非法的主题 ID".to_string());
    }
    let dir = paths::theme_dir(theme_id)?;

    if !dir.exists() {
        return Err("这个主题已经不在了，可能要重新导入".to_string());
    }

    // 后端再拦一次：前端按钮禁用只是体验，IPC 调用可能来自别处。
    // theme.json 读不出来时不阻止删除（否则损坏主题永远删不掉），
    // 但只要能读到，就按磁盘内容与注册表事实复核。
    let mut meta: Option<(String, usize)> = None;
    if let Ok(raw) =
        limits::read_text_bounded(&dir.join("theme.json"), limits::MAX_THEME_JSON_BYTES)
    {
        if let Ok(mut stored) = serde_json::from_str::<CursorTheme>(&raw) {
            if stored.is_built_in {
                return Err("系统方案不能删除".to_string());
            }
            if stored.id == theme_id {
                theme_paths::resolve_theme(&mut stored, &dir);
                if let Ok(current) = registry::read_current_slots() {
                    if theme_matches_current(&stored, &current) {
                        return Err(
                            "不能删除正在使用的主题：请先切换到其它主题，或还原系统默认"
                                .to_string(),
                        );
                    }
                }
                meta = Some((stored.name, stored.cursors.len()));
            }
        }
    }

    // 读不出 theme.json 仍允许删除；回收站条目只能展示为「损坏的主题」，
    // 恢复时会再校验一次，坏掉的主题不会悄悄变回可用状态。
    let (name, slot_count) = meta.unwrap_or_else(|| ("损坏的主题".to_string(), 0));
    trash::move_into_trash(theme_id, &name, slot_count)
}

/// 重命名已导入的主题
///
/// 只改 theme.json 里的显示名，目录名仍是 UUID（改目录会影响正在使用的
/// 光标路径）。`updated_at` 保持导入时间不变——界面上它承担的是「导入于」。
#[tauri::command]
pub async fn rename_theme(
    app: AppHandle,
    theme_id: String,
    new_name: String,
) -> Result<CursorTheme, String> {
    let renamed = tauri::async_runtime::spawn_blocking(move || rename(&theme_id, &new_name))
        .await
        .map_err(|err| format!("改名任务异常退出（{err}）"))?;
    // 菜单标签取主题的当前名字，改名后托盘不能还叫旧名（决策 30）
    tray::refresh(&app);
    renamed
}

fn rename(theme_id: &str, new_name: &str) -> Result<CursorTheme, String> {
    if !validation::is_canonical_uuid(theme_id) {
        return Err("非法的主题 ID".to_string());
    }
    let name = validation::validate_theme_name(new_name)?;

    let theme_dir = paths::theme_dir(theme_id)?;
    let json_path = theme_dir.join("theme.json");
    if !json_path.exists() {
        return Err("找不到这个主题，它可能已被删除".to_string());
    }

    let raw = limits::read_text_bounded(&json_path, limits::MAX_THEME_JSON_BYTES)
        .map_err(|err| format!("读不到主题信息（{err}）"))?;
    let mut theme: CursorTheme =
        serde_json::from_str(&raw).map_err(|err| format!("主题信息已损坏，无法改名（{err}）"))?;
    if theme.id != theme_id || theme.is_built_in {
        return Err("主题信息与目录不一致，已拒绝改名".to_string());
    }

    theme.name = name;

    // 顺手把旧绝对路径改写成相对路径；返回给前端的仍是绝对路径
    theme_paths::write_theme_json(&theme_dir, &theme)
        .map_err(|err| format!("保存主题信息失败（{err}）"))?;
    theme_paths::resolve_theme(&mut theme, &theme_dir);

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
pub async fn export_theme(theme: CursorTheme, dest_path: String) -> Result<ExportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || export_to(&theme, &dest_path))
        .await
        .map_err(|err| format!("导出任务异常退出（{err}）"))?
}

fn export_to(theme: &CursorTheme, dest_path: &str) -> Result<ExportSummary, String> {
    validation::validate_theme_slots(theme)?;
    let theme_dir = validation::ensure_theme_id_matches_dir(theme)?;
    let dest = validation::validate_dest_path(dest_path, "zip")?;
    let parent = dest.parent().ok_or_else(|| "目标路径无效".to_string())?;

    // 先写同目录临时文件，成功后再改名：中途失败不会留下半个 zip，
    // 也不会破坏用户原有的同名文件
    let tmp = parent.join(format!(".cursorstudio-export-{}.zip", Uuid::new_v4()));
    let file = fs::File::create(&tmp)
        .map_err(|err| format!("无法创建文件，它可能正被占用（{err}）"))?;

    match write_export_zip(theme, &theme_dir, file) {
        Ok(summary) => {
            if let Err(err) = fs::rename(&tmp, &dest) {
                let _ = fs::remove_file(&tmp);
                return Err(format!("保存压缩包失败（{err}）"));
            }
            Ok(summary)
        }
        Err(err) => {
            // write_export_zip 返回时 writer 已释放，Windows 上这时才删得掉
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

fn write_export_zip(
    theme: &CursorTheme,
    theme_dir: &Path,
    file: fs::File,
) -> Result<ExportSummary, String> {
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

        let src = if theme.is_built_in {
            validation::ensure_readable_cursor_file(&slot.file_path)
        } else {
            // 越出本主题目录是输入被篡改，不是「文件暂时不在」：直接拒绝导出
            if !validation::path_within_theme_dir(Path::new(&slot.file_path), theme_dir) {
                return Err(format!(
                    "光标文件不在该主题目录内，已拒绝：{}",
                    slot.file_path
                ));
            }
            let checked =
                validation::ensure_cursor_file_in_theme(&slot.file_path, theme_dir);
            if let Err(err) = &checked {
                if err.contains("不在该主题目录内") {
                    return Err(err.clone());
                }
            }
            checked
        };
        let src = match src {
            Ok(path) => path,
            Err(err) => {
                skipped.push(format!("{}（{err}）", slot.display_name));
                continue;
            }
        };
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        let Some(ext) = ext.filter(|e| matches!(e.as_str(), "cur" | "ani" | "ico")) else {
            skipped.push(format!("{}（不是光标文件）", slot.display_name));
            continue;
        };

        // 流式写进压缩包：光标文件上限 20MB，仍不整个读进内存
        let Ok(mut source) = fs::File::open(&src) else {
            skipped.push(format!("{}（源文件不存在）", slot.display_name));
            continue;
        };

        let name = format!("{}.{ext}", slot.registry_key.to_lowercase());
        writer
            .start_file(name, options)
            .map_err(|err| format!("打包失败（{err}）"))?;
        std::io::copy(&mut source, &mut writer)
            .map_err(|err| format!("写入压缩包失败（{err}）"))?;
        file_count += 1;

        // .ico 不能被 Windows 当作光标加载：照常导出，但不进 .inf，
        // 否则装出来的方案在「应用」时这些槽位会失效
        if matches!(ext.as_str(), "cur" | "ani") {
            inf_files.push((slot.registry_key.clone(), ext.clone()));
        }
    }

    if file_count == 0 {
        // 临时文件的清理由 export_to 统一负责（返回时 writer 已释放）
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
    use crate::utils::test_support::{fixture_ani, fixture_cur, TempDir};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// 删除命令会读注册表复核「正在使用」；测试一律指到隔离键
    struct TestRegistryGuard {
        path: String,
    }

    impl Drop for TestRegistryGuard {
        fn drop(&mut self) {
            let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
            let _ = hkcu.delete_subkey_all(&self.path);
            registry::set_test_cursors_key(None);
        }
    }

    fn isolate_registry(label: &str, create: bool) -> TestRegistryGuard {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = format!(
            r"Software\CursorStudio.Tests\theme-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        if create {
            let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
            let _ = hkcu.delete_subkey_all(&path);
            hkcu.create_subkey(&path).expect("建隔离注册表键");
        }
        registry::set_test_cursors_key(Some(path.clone()));
        TestRegistryGuard { path }
    }

    /// 在隔离的主题目录里放一套可导出的主题，返回 (主题, 主题目录)
    fn seed_exportable_theme(label: &str, slots: &[(&str, &str, Vec<u8>)]) -> (CursorTheme, PathBuf) {
        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id).expect("解析主题目录");
        fs::create_dir_all(dir.join("cursors")).expect("建主题目录");

        let mut cursors = Vec::new();
        for (key, file_name, bytes) in slots {
            let path = dir.join("cursors").join(file_name);
            fs::write(&path, bytes).expect("写光标 fixture");
            cursors.push(CursorSlot {
                registry_key: (*key).to_string(),
                display_name: (*key).to_string(),
                english_name: (*key).to_string(),
                file_path: path.to_string_lossy().into_owned(),
                file_type: "cur".to_string(),
            });
        }

        let theme = CursorTheme {
            id: id.clone(),
            name: label.to_string(),
            description: String::new(),
            created_at: "2026-01-01 00:00".to_string(),
            updated_at: "2026-01-01 00:00".to_string(),
            is_built_in: false,
            cursors,
        };
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).expect("序列化主题"),
        )
        .expect("写 theme.json");
        (theme, dir)
    }

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

    /// 比对失败时把两侧路径的原始值与归一值一起打出来
    ///
    /// 注册表存的是 `fs::canonicalize` 之后的路径，主题侧是拼接出来的普通路径，
    /// `normalize_path` 只兜平前缀和大小写。两者若差在别的维度（重解析点展开、
    /// 8.3 短名）只会表现为「本机绿、CI 红」，光看布尔结果定位不了，必须看到
    /// 两台机器上各自的真实字符串。
    fn path_diff_report(theme: &CursorTheme, current: &[(String, String)]) -> String {
        let mut out = String::new();
        let theme_slots: Vec<&CursorSlot> = theme
            .cursors
            .iter()
            .filter(|slot| !slot.file_path.trim().is_empty())
            .collect();
        out.push_str(&format!(
            "  主题「{}」非空槽位 {} 个（声明 {} 个）：\n",
            theme.name,
            theme_slots.len(),
            theme.cursors.len()
        ));
        for slot in &theme_slots {
            out.push_str(&format!(
                "    {:<10} 原始={:?}\n             归一={:?}\n",
                slot.registry_key,
                slot.file_path,
                normalize_path(&slot.file_path)
            ));
        }
        out.push_str(&format!("  注册表非空槽位 {} 个：\n", current.len()));
        for (key, path) in current {
            out.push_str(&format!(
                "    {:<10} 原始={:?}\n             归一={:?}\n",
                key,
                path,
                normalize_path(path)
            ));
        }
        out
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

    /// 回归测试：同一文件的 8.3 短名写法与 canonical 写法必须归一到同一个值
    ///
    /// CI runner 的临时目录是 `C:\Users\RUNNER~1\AppData\Local\Temp\...`，注册表里
    /// 存的却是 canonicalize 之后的 `...\runneradmin\...`。本机用户名不超过 8 个字符
    /// 时两种写法重合，所以这条只有 CI 能真正跑出差异——它钉的是"当场的临时目录"，
    /// 不再依赖某台机器碰巧看不出来。
    #[test]
    fn 短名写法与规范写法归一后必须相同() {
        let root = TempDir::new("norm-83");
        let _guard = root.isolate_paths();

        let file = root.join("arrow.cur");
        fs::write(&file, fixture_cur()).expect("写 fixture");
        let canonical = fs::canonicalize(&file).expect("canonicalize fixture");

        assert_eq!(
            normalize_path(&file.to_string_lossy()),
            normalize_path(&canonical.to_string_lossy()),
            "同一套光标不能因写法不同被判成两套"
        );
    }

    /// 回归测试：经重解析点到达的路径与真实路径必须归一到同一个值
    ///
    /// 与上一条是同一个坑的两面。本机用户名不够长所以短名那条是空转的，重解析点
    /// 这条在两台机器上都能真的跑出差异。建不出 junction（权限或文件系统限制）
    /// 就跳过，不给 CI 添环境性假红。
    #[test]
    fn 重解析点写法与真实写法归一后必须相同() {
        use std::process::Command;
        let root = TempDir::new("junction");
        let real = root.path().join("real");
        fs::create_dir_all(&real).expect("建 real");
        let file = real.join("arrow.cur");
        fs::write(&file, fixture_cur()).expect("写 fixture");

        let link = root.path().join("link");
        let link_arg = link.to_string_lossy().into_owned();
        let real_arg = real.to_string_lossy().into_owned();
        let created = Command::new("cmd")
            .args(["/C", "mklink", "/J", link_arg.as_str(), real_arg.as_str()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !created {
            eprintln!("跳过：本机建不出 junction，这条断言跑不了");
            return;
        }

        let via_link = link.join("arrow.cur");
        let canonical = fs::canonicalize(&file).expect("canonicalize fixture");
        let normalized_link = normalize_path(&via_link.to_string_lossy());
        let normalized_real = normalize_path(&canonical.to_string_lossy());
        fs::remove_dir(&link).expect("删 junction");
        assert_eq!(
            normalized_link, normalized_real,
            "junction 写法与真实写法不能被判成两套光标"
        );
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

    /// canonicalize 的 `\\?\` 扩展长度前缀不该拆散识别：
    /// 应用系统方案写进注册表的是 `\\?\C:\Windows\...`，方案列表读出来是普通路径
    #[test]
    fn 扩展长度前缀不影响识别() {
        let theme = theme_with_slots("sys_firefly", "firefly", &[("Arrow", r"C:\Windows\Cursors\荧1.0\arrow.ani")]);
        let slots = current(&[("Arrow", r"\\?\C:\Windows\Cursors\荧1.0\ARROW.ani")]);

        assert_eq!(
            detect_active_theme(&[theme], &slots, "firefly").as_deref(),
            Some("sys_firefly"),
            "同一文件带不带 \\\\?\\ 前缀应算同一套"
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
        assert!(detect_active_theme(std::slice::from_ref(&theme), &subset, "").is_none());

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

    /// 槽位有值但不属于任何已知主题：要能被判成「被外部改写」而不是「系统默认」
    ///（2026-10-26 真机实验：系统指针样式页选黑色会把槽位写成 %SystemRoot%\cursors\*_r.cur）
    #[test]
    fn 槽位被外部改写时不算系统默认() {
        let _registry = isolate_registry("probe-external", true);
        let theme = theme_with_slots("a", "A", &[("Arrow", r"C:\A\arrow.cur")]);
        // 模拟系统样式页的写入：路径与本应用主题毫无关系
        let foreign = theme_with_slots("foreign", "外来", &[("Arrow", r"C:\Windows\Cursors\arrow_r.cur")]);
        registry::write_cursors(&foreign.cursors, "Windows Black").expect("写隔离注册表");

        let info = probe_active(&[theme]);
        assert!(info.id.is_none(), "外来路径不该匹配到本应用主题");
        assert_eq!(info.filled, 1);
        assert!(info.external, "槽位非空且无匹配 = 被外部改写，不能当成系统默认");
        assert!(info.warning.is_none());
    }

    #[test]
    fn probe_active_在注册表读不到时降级为警告() {
        // 隔离键存在但主键没建：read_current_slots 会失败
        let _registry = isolate_registry("probe-missing", false);
        let info = probe_active(&[]);
        assert!(info.id.is_none());
        assert!(!info.external, "读不到注册表时不能武断判外部改写");
        assert!(info.warning.is_some(), "失败原因要带回给调用方");
    }

    #[test]
    fn probe_active_系统方案命中不算外部改写() {
        let _registry = isolate_registry("probe-scheme", true);
        let scheme = theme_with_slots("sys_firefly", "firefly", &[("Arrow", r"C:\F\a.ani")]);
        registry::write_cursors(&scheme.cursors, &scheme.name).expect("写隔离注册表");

        let info = probe_active(&[scheme]);
        assert_eq!(info.id.as_deref(), Some("sys_firefly"));
        assert_eq!(info.filled, 1);
        assert!(!info.external, "命中已知主题就是正常使用，不是外部改写");
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
            let err = delete(bad).unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 应被拒绝，实际：{err}");

            let err = rename(bad, "x").unwrap_err();
            assert!(err.contains("非法"), "{bad:?} 改名也应被拒绝，实际：{err}");
        }
    }

    /// 名称校验发生在碰文件系统之前，所以不需要真实目录
    #[test]
    fn 改名的名称校验() {
        let id = Uuid::new_v4().to_string();

        let err = rename(&id, "   ").unwrap_err();
        assert!(err.contains("不能为空"), "实际：{err}");

        let err = rename(&id, &"字".repeat(41)).unwrap_err();
        assert!(err.contains("40"), "实际：{err}");

        let err = rename(&id, "a\nb").unwrap_err();
        assert!(err.contains("控制字符"), "实际：{err}");
    }

    #[test]
    fn 改名应去掉首尾空格且不动导入时间() {
        let root = TempDir::new("rename");
        let _guard = root.isolate_paths();

        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id).expect("解析主题目录");
        paths::ensure_dir(&dir).expect("建临时主题目录");
        let theme = fake_theme(&id);
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).unwrap(),
        )
        .expect("写入初始 theme.json");

        let outcome = rename(&id, "  新名字  ");

        let saved: CursorTheme = serde_json::from_str(
            &fs::read_to_string(dir.join("theme.json")).expect("读回 theme.json"),
        )
        .expect("解析 theme.json");

        let renamed = outcome.expect("改名应成功");
        assert_eq!(renamed.name, "新名字", "首尾空格应被去掉");
        assert_eq!(saved.name, "新名字", "改名结果必须落盘");
        assert_eq!(saved.updated_at, "", "改名不应改动导入时间");
    }

    /// 导出必须形成闭环：文件名按槽位重命名，再导入能还原成同一个槽位
    #[test]
    fn 导出再导入应还原槽位() {
        let root = TempDir::new("export-roundtrip");
        let _guard = root.isolate_paths();

        let (theme, _dir) =
            seed_exportable_theme("导出测试", &[("SizeNWSE", "随便起的名字.cur", fixture_cur())]);
        let zip_path = root.join("roundtrip.zip");

        let summary = export_to(&theme, &zip_path.to_string_lossy())
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
    }

    /// 源文件全缺失时，必须报错，且不能留下空 zip 骗用户
    #[test]
    fn 源文件全缺失时不该留下空压缩包() {
        let root = TempDir::new("export-empty");
        let _guard = root.isolate_paths();

        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id).expect("解析主题目录");
        fs::create_dir_all(&dir).expect("建主题目录");
        let theme = theme_with_slots(
            &id,
            "空测试",
            &[(
                "Arrow",
                dir.join("cursors").join("missing.cur").to_str().unwrap(),
            )],
        );
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).unwrap(),
        )
        .expect("写 theme.json");
        let zip_path = root.join("empty.zip");

        let err = export_to(&theme, &zip_path.to_string_lossy()).unwrap_err();
        assert!(err.contains("没有可导出"), "实际：{err}");
        assert!(!zip_path.exists(), "失败时不能留下空压缩包");
    }

    /// 把一份真实导出的 .inf 抽到系统临时目录，方便用记事本打开人工检查
    /// 格式（UTF-16LE 在记事本里正常显示），也可以拿去做右键安装的真机验收
    #[test]
    fn 导出的_inf_样例落到临时目录供人工检查() {
        let root = TempDir::new("inf-sample");
        let _guard = root.isolate_paths();

        let (theme, _dir) = seed_exportable_theme(
            "样例方案",
            &[
                ("Arrow", "a.cur", fixture_cur()),
                ("Wait", "b.ani", fixture_ani()),
            ],
        );
        let zip_path = root.join("sample.zip");
        export_to(&theme, &zip_path.to_string_lossy()).expect("导出应成功");

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
        println!("样例已写到 {}", sample.display());
    }

    /// 删除改为软删除：目录移入回收站，重复删除也要给人话而不是崩溃
    #[test]
    fn 删除应移入回收站且重复删除有提示() {
        let root = TempDir::new("delete");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("delete", false);

        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id).expect("解析主题目录");
        paths::ensure_dir(&dir).expect("建临时主题目录");
        let mut theme = fake_theme(&id);
        theme.name = "待删除".to_string();
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).unwrap(),
        )
        .expect("写 theme.json");
        assert!(dir.exists());

        let outcome = delete(&id).expect("删除应成功");
        assert_eq!(outcome.auto_purged, 0);
        assert!(!dir.exists(), "主题目录必须从主题库移走");
        let listing = crate::utils::trash::list().expect("列出回收站");
        assert_eq!(listing.entries.len(), 1, "删除后应留下回收站条目");
        assert_eq!(listing.entries[0].name, "待删除");
        assert_eq!(listing.entries[0].theme_id, id);

        let err = delete(&id).unwrap_err();
        assert!(err.contains("已经不在了"), "重复删除应给人话提示，实际：{err}");
        assert_eq!(
            crate::utils::trash::list().expect("列出回收站").entries.len(),
            1,
            "重复删除不应产生第二条回收站记录"
        );
    }

    /// 读不出 theme.json 的主题也必须删得掉，否则损坏主题永远占着位置
    #[test]
    fn 损坏主题也能删除并进入回收站() {
        let root = TempDir::new("delete-corrupt");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("corrupt", false);

        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id).expect("解析主题目录");
        paths::ensure_dir(&dir).expect("建主题目录");
        fs::write(dir.join("theme.json"), "{}").expect("写损坏的 theme.json");

        delete(&id).expect("损坏主题也应能删除");
        assert!(!dir.exists());
        let listing = crate::utils::trash::list().expect("列出回收站");
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "损坏的主题");
        assert_eq!(listing.entries[0].slot_count, 0);
        assert_eq!(
            listing.entries[0].status, "damaged",
            "主题信息坏掉的条目应标记为不可恢复"
        );
        assert!(
            listing.entries[0].error.as_deref().is_some_and(|err| err.contains("主题信息")),
            "原因要说清是主题信息坏了"
        );
    }

    /// 后端也要拒绝删除自称系统方案的主题，不能只靠前端按钮禁用
    #[test]
    fn 删除时拒绝自称系统方案的主题() {
        let root = TempDir::new("delete-built-in");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("built-in", false);

        let id = Uuid::new_v4().to_string();
        let dir = paths::theme_dir(&id).expect("解析主题目录");
        paths::ensure_dir(&dir).expect("建主题目录");
        let mut theme = fake_theme(&id);
        theme.is_built_in = true;
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&theme).unwrap(),
        )
        .expect("写 theme.json");

        let err = delete(&id).unwrap_err();
        assert!(err.contains("系统方案"), "实际：{err}");
        assert!(dir.exists(), "拒绝删除时目录必须保留");
    }

    /// 正在使用的主题即使前端绕过按钮，后端也必须拒绝删除
    #[test]
    fn 删除时拒绝正在使用的主题() {
        let root = TempDir::new("delete-active");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("active", true);

        let (theme, dir) = seed_exportable_theme("使用中", &[("Arrow", "arrow.cur", fixture_cur())]);
        registry::write_cursors(&theme.cursors, &theme.name).expect("写隔离注册表");

        let err = delete(&theme.id).unwrap_err();
        assert!(err.contains("正在使用"), "实际：{err}");
        assert!(dir.exists(), "拒绝删除时目录必须保留");
    }

    /// 外部光标（系统设置 / 其它工具）保存为我的主题后应立即接管
    #[test]
    fn 保存当前光标会把外部方案收编并自动应用() {
        let root = TempDir::new("save-current");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("save-current", true);

        let external = root.join("external");
        fs::create_dir_all(&external).expect("建外部目录");
        let arrow_path = external.join("arrow.cur");
        let wait_path = external.join("busy.ani");
        fs::write(&arrow_path, fixture_cur()).expect("写 arrow");
        fs::write(&wait_path, fixture_ani()).expect("写 wait");
        let slots = vec![
            CursorSlot {
                registry_key: "Arrow".into(),
                display_name: "正常选择".into(),
                english_name: "Normal Select".into(),
                file_path: arrow_path.to_string_lossy().into_owned(),
                file_type: "cur".into(),
            },
            CursorSlot {
                registry_key: "Wait".into(),
                display_name: "忙".into(),
                english_name: "Busy".into(),
                file_path: wait_path.to_string_lossy().into_owned(),
                file_type: "ani".into(),
            },
        ];
        registry::write_cursors(&slots, "外部方案").expect("写外部光标注册表");

        let outcome = save_current().expect("应保存成功");
        assert!(outcome.applied, "抄全后应自动接管：{:?}", outcome.warning);
        assert_eq!(outcome.file_count, 2);
        assert!(outcome.warnings.is_empty());
        assert_eq!(outcome.theme.cursors.len(), 2);
        assert!(outcome.theme.name.starts_with("当前光标 "));

        let theme_dir = paths::theme_dir(&outcome.theme.id).expect("解析新主题目录");
        assert!(theme_dir.join("cursors/arrow.cur").is_file());
        assert!(theme_dir.join("cursors/wait.ani").is_file(), "扩展名应保留");
        let current = registry::read_current_slots().expect("读回注册表");
        assert_eq!(current.len(), 2);
        assert!(
            theme_matches_current(&outcome.theme, &current),
            "接管后注册表应与新主题一致\n{}",
            path_diff_report(&outcome.theme, &current)
        );
        assert_eq!(
            outcome.recent.first().map(|entry| entry.theme_id.as_str()),
            Some(outcome.theme.id.as_str()),
            "接管应记入最近使用"
        );
    }

    /// 当前已经是已知主题时没有重复保存的意义
    #[test]
    fn 当前已是已知主题时不重复保存() {
        let root = TempDir::new("save-current-known");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("save-current-known", true);

        let (theme, _dir) =
            seed_exportable_theme("已经存在", &[("Arrow", "arrow.cur", fixture_cur())]);
        registry::write_cursors(&theme.cursors, &theme.name).expect("写注册表");

        let err = save_current().unwrap_err();
        assert!(err.contains("已经是"), "实际：{err}");
        assert_eq!(
            fs::read_dir(paths::themes_dir().expect("主题目录"))
                .expect("列主题目录")
                .count(),
            1,
            "拒绝保存时不能多出主题目录"
        );
    }

    /// 有槽位没抄全时只保存、不自动应用，不能反过来清掉当前非空槽位
    #[test]
    fn 有槽位没抄全时不自动应用() {
        let root = TempDir::new("save-current-partial");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("save-current-partial", true);

        let external = root.join("external");
        fs::create_dir_all(&external).expect("建外部目录");
        let arrow_path = external.join("arrow.cur");
        fs::write(&arrow_path, fixture_cur()).expect("写 arrow");
        let missing = external.join("missing.cur");
        let slots = vec![
            CursorSlot {
                registry_key: "Arrow".into(),
                display_name: "正常选择".into(),
                english_name: "Normal Select".into(),
                file_path: arrow_path.to_string_lossy().into_owned(),
                file_type: "cur".into(),
            },
            CursorSlot {
                registry_key: "Wait".into(),
                display_name: "忙".into(),
                english_name: "Busy".into(),
                file_path: missing.to_string_lossy().into_owned(),
                file_type: "cur".into(),
            },
        ];
        registry::write_cursors(&slots, "不完整外部方案").expect("写注册表");

        let outcome = save_current().expect("至少一个槽位可用时应保存");
        assert!(!outcome.applied, "有槽位没抄全时不能自动应用");
        assert!(!outcome.warnings.is_empty());
        assert!(outcome.warning.is_some());
        assert_eq!(outcome.theme.cursors.len(), 1);
        let current = registry::read_current_slots().expect("读回注册表");
        assert!(
            current
                .iter()
                .any(|(_, path)| Path::new(path).starts_with(&external)),
            "注册表应保持原样，不能清掉当前槽位"
        );
        let saved_dir = paths::theme_dir(&outcome.theme.id).expect("解析新主题目录");
        assert!(
            current
                .iter()
                .all(|(_, path)| !Path::new(path).starts_with(&saved_dir)),
            "未自动应用时注册表不应指向新主题副本"
        );
    }

    #[test]
    fn 系统默认时不能保存当前光标() {
        let root = TempDir::new("save-current-default");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("save-current-default", true);

        let err = save_current().unwrap_err();
        assert!(err.contains("系统默认"), "实际：{err}");
        assert_eq!(
            fs::read_dir(paths::themes_dir().expect("主题目录"))
                .expect("列主题目录")
                .count(),
            0
        );
    }

    /// 用户主题引用另一套主题的文件：应用 / 导出都必须拒绝
    #[test]
    fn 用户主题不能引用另一套主题的光标() {
        let root = TempDir::new("cross-theme-slots");
        let _guard = root.isolate_paths();

        let (other, _) = seed_exportable_theme("另一套", &[("Arrow", "other.cur", fixture_cur())]);
        let (mut mine, dir) = seed_exportable_theme("本套", &[("Arrow", "mine.cur", fixture_cur())]);
        mine.cursors[0].file_path = other.cursors[0].file_path.clone();
        fs::write(
            dir.join("theme.json"),
            serde_json::to_string_pretty(&mine).unwrap(),
        )
        .expect("写 theme.json");

        let err = checked_slots(&mine).unwrap_err();
        assert!(err.contains("该主题目录"), "实际：{err}");

        let zip = root.join("cross-theme.zip");
        let err = export_to(&mine, &zip.to_string_lossy()).unwrap_err();
        assert!(err.contains("该主题目录"), "导出也必须拒绝，实际：{err}");
        assert!(!zip.exists(), "失败时不能留下压缩包");
    }

    /// 托盘快速切换（决策 30）：按 ID 应用必须与界面按钮走同一条链路
    #[test]
    fn 托盘按_id_应用主题并记录最近使用() {
        let root = TempDir::new("tray-apply");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("tray-apply", true);

        let (theme, _dir) = seed_exportable_theme("托盘切换", &[("Arrow", "arrow.cur", fixture_cur())]);

        let applied = apply_by_id(&theme.id).expect("应应用成功");
        assert!(applied);

        let current = registry::read_current_slots().expect("读回注册表");
        assert!(
            theme_matches_current(&theme, &current),
            "注册表应切到该主题\n{}",
            path_diff_report(&theme, &current)
        );
        let history_path = paths::history_file().expect("解析历史文件");
        let events = history::read_events_from(&history_path).events;
        assert_eq!(
            events.first().map(|entry| entry.theme_id.as_str()),
            Some(theme.id.as_str()),
            "托盘应用与界面应用一样要记入最近使用"
        );
    }

    /// 菜单是重建时的快照：主题被删后再点，不能报错也不能动注册表
    #[test]
    fn 托盘按_id_应用已删除的主题时静默跳过() {
        let root = TempDir::new("tray-apply-gone");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("tray-gone", false);

        let applied = apply_by_id(&Uuid::new_v4().to_string()).expect("找不到不算错误");
        assert!(!applied);
        assert!(
            registry::read_current_slots().is_err(),
            "隔离键没有槽位：未应用时注册表不应被写入"
        );
    }

    /// 托盘点击不能绕过主题目录校验：与应用命令共用同一套安全口径
    ///
    /// 光标文件被挪走后 theme.json 仍指向它：清单里还能出现这个主题
    /// （读取端只清坏槽位），但 `apply` 的存在性校验必须把它拦下。
    #[test]
    fn 托盘按_id_应用时仍走主题目录校验() {
        let root = TempDir::new("tray-apply-cross");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("tray-cross", true);

        let (theme, dir) = seed_exportable_theme("文件被挪走", &[("Arrow", "arrow.cur", fixture_cur())]);
        fs::remove_file(dir.join("cursors").join("arrow.cur")).expect("删掉光标文件");

        let err = apply_by_id(&theme.id).unwrap_err();
        assert!(err.contains("不存在") || err.contains("读不到"), "实际：{err}");
    }

    /// 托盘「还原默认」与还原命令同链路：清槽位后注册表应回到空
    #[test]
    fn 托盘还原默认清空注册表槽位() {
        let root = TempDir::new("tray-restore");
        let _guard = root.isolate_paths();
        let _registry = isolate_registry("tray-restore", true);

        let (theme, _dir) = seed_exportable_theme("应用后还原", &[("Arrow", "arrow.cur", fixture_cur())]);
        registry::write_cursors(&theme.cursors, &theme.name).expect("先占上槽位");
        assert!(!registry::read_current_slots().expect("读回注册表").is_empty());

        restore().expect("还原默认");
        assert!(
            registry::read_current_slots().expect("读回注册表").is_empty(),
            "还原后不应残留槽位"
        );
    }
}
