//! 托盘图标：只在「关闭行为 = 最小化到托盘」时存在
//!
//! 关窗不退而是缩到托盘时，必须有个东西能把窗口叫回来，也得有个明确的
//! 「退出」出口——两件事都由托盘菜单承担（单击图标 = 打开主界面）。
//! 关闭行为切回「直接退出」时托盘随之移除，不留一个悬空图标。
//!
//! 托盘还承担「快速切换」（决策 30）：右键菜单里放最近使用的主题与
//! 「还原默认光标」，不开窗就能换光标。菜单数据在重建时读取、动作完成后
//! 重建，不轮询注册表；快照过期的兜底在点击时的复核（`apply_by_id`）。

use std::collections::HashSet;

use tauri::{
    image::Image,
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

use crate::commands::theme::{apply_by_id, collect_snapshot, restore, ThemesSnapshot};
use crate::models::{CursorTheme, HistoryEntry};
use crate::utils::log;
use crate::utils::settings::{self, CloseBehavior};

const TRAY_ID: &str = "main";
const TOOLTIP: &str = "鼠标主题工具";

const RESTORE_DEFAULT_ID: &str = "restore-default";
const APPLY_PREFIX: &str = "apply:";
/// 菜单里最近主题的上限：托盘是快捷入口，全量挑选回主界面做
const RECENT_MENU_LIMIT: usize = 8;

/// 菜单里的一条主题动作（纯数据，组装规则可以脱离 Tauri 单测）
pub(crate) struct ThemeAction {
    /// 菜单项 id：`apply:<主题 ID>`
    pub id: String,
    /// 展示名：取主题清单里的**当前**名字，改名后菜单跟着变
    pub label: String,
    pub checked: bool,
}

/// 从主题清单 + 最近使用记录推出托盘菜单条目（决策 30）
///
/// - 当前主题置顶并勾选：不在最近列表里也要出现，勾选才有着落；
/// - 最近主题按时间倒序（`recent` 已是按主题去重的派生视图），已被删除 /
///   迁移的直接摘掉，菜单不留死条目；
/// - 总数不超过 `RECENT_MENU_LIMIT`；
/// - 标签用主题清单里的当前名字，历史记录里的名字只是快照。
pub(crate) fn plan_theme_actions(
    themes: &[CursorTheme],
    recent: &[HistoryEntry],
    active_id: Option<&str>,
) -> Vec<ThemeAction> {
    let mut actions: Vec<ThemeAction> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(id) = active_id {
        seen.insert(id.to_string());
        if let Some(theme) = themes.iter().find(|theme| theme.id == id) {
            actions.push(ThemeAction {
                id: format!("{APPLY_PREFIX}{}", theme.id),
                label: theme.name.clone(),
                checked: true,
            });
        }
    }

    for entry in recent {
        if actions.len() >= RECENT_MENU_LIMIT {
            break;
        }
        if !seen.insert(entry.theme_id.clone()) {
            continue;
        }
        let Some(theme) = themes.iter().find(|theme| theme.id == entry.theme_id) else {
            continue;
        };
        actions.push(ThemeAction {
            id: format!("{APPLY_PREFIX}{}", theme.id),
            label: theme.name.clone(),
            checked: false,
        });
    }

    actions
}

/// 按当前设置同步托盘的有无（启动时调一次，设置变更后再调一次）
///
/// 创建失败只记日志：托盘是「关闭到托盘」的配套件，创建不上不代表应用
/// 不能用——此时关窗仍按设置隐藏，用户可以从开始菜单再打开。
pub fn sync(app: &AppHandle) {
    match settings::read().close_behavior {
        CloseBehavior::Tray => {
            if app.tray_by_id(TRAY_ID).is_none() {
                if let Err(err) = build(app) {
                    log::error("tray", &format!("创建托盘图标失败：{err}"));
                }
            }
            // 主题区随后台重查补齐：启动与设置变更都会走到这里，
            // 初建菜单只含「打开 / 退出」，不在启动路径里做注册表与磁盘 I/O
            refresh(app);
        }
        CloseBehavior::Exit => {
            // 返回的图标被立刻丢弃 = 移除，正是想要的
            let _ = app.remove_tray_by_id(TRAY_ID);
        }
    }
}

/// 后台重查主题数据并整体重建菜单（决策 30）
///
/// 应用 / 还原 / 删除这类会改变菜单内容的时机都要调一次。重建放在独立线程：
/// 调用方可能在主线程（启动 setup），也可能在命令的异步任务里，都不该被
/// 注册表与磁盘 I/O 拖住；并发的多次重查只是各写一次有效菜单，无竞态危害。
pub fn refresh(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let snapshot = collect_snapshot();
        rebuild_menu(&app, &snapshot);
    });
}

fn rebuild_menu(app: &AppHandle, snapshot: &ThemesSnapshot) {
    match build_menu(app, snapshot) {
        Ok(menu) => {
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                if let Err(err) = tray.set_menu(Some(menu)) {
                    log::error("tray", &format!("更新托盘菜单失败：{err}"));
                }
            }
        }
        Err(err) => log::error("tray", &format!("组装托盘菜单失败：{err}")),
    }
}

fn build(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app, &ThemesSnapshot::empty())
        .map_err(|err| format!("组装托盘菜单失败（{err}）"))?;

    // 用内置 PNG 而不是 default_window_icon()：图标源确定，不依赖窗口图标是否已就绪
    let icon = Image::from_bytes(include_bytes!("../../icons/32x32.png"))
        .map_err(|err| format!("解析托盘图标失败（{err}）"))?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(TOOLTIP)
        .menu(&menu)
        // 左键直接打开主界面，菜单留给右键——与任务栏图标的习惯一致
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            RESTORE_DEFAULT_ID => restore_default_from_tray(app),
            id => {
                if let Some(theme_id) = id.strip_prefix(APPLY_PREFIX) {
                    apply_theme_from_tray(app, theme_id);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        });

    builder
        .build(app)
        .map_err(|err| format!("构建托盘失败（{err}）"))?;
    Ok(())
}

/// 拼一份完整菜单：最近主题 + 还原默认 + 打开 / 退出
///
/// 条目必须活到 `Menu::with_items` 之后，全部先持有再统一引用。
fn build_menu(app: &AppHandle, snapshot: &ThemesSnapshot) -> Result<Menu<Wry>, String> {
    let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败（{err}）"))?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败（{err}）"))?;

    let header = MenuItem::with_id(app, "themes-header", "切换主题", false, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败（{err}）"))?;
    let sep_after_header = PredefinedMenuItem::separator(app)
        .map_err(|err| format!("创建托盘菜单分隔失败（{err}）"))?;
    let sep_after_themes = PredefinedMenuItem::separator(app)
        .map_err(|err| format!("创建托盘菜单分隔失败（{err}）"))?;

    let actions = plan_theme_actions(
        &snapshot.themes,
        &snapshot.recent,
        snapshot.active.id.as_deref(),
    );
    let theme_items: Vec<CheckMenuItem<Wry>> = actions
        .iter()
        .map(|action| {
            CheckMenuItem::with_id(
                app,
                &action.id,
                &action.label,
                true,
                action.checked,
                None::<&str>,
            )
            .map_err(|err| format!("创建托盘菜单项失败（{err}）"))
        })
        .collect::<Result<_, _>>()?;

    let restore_default = CheckMenuItem::with_id(
        app,
        RESTORE_DEFAULT_ID,
        "还原默认光标",
        true,
        // 注册表读成功且槽位一个不剩 = 系统默认在用才勾；读失败时不猜
        snapshot.active.warning.is_none() && snapshot.active.filled == 0,
        None::<&str>,
    )
    .map_err(|err| format!("创建托盘菜单项失败（{err}）"))?;
    let sep_before_show = PredefinedMenuItem::separator(app)
        .map_err(|err| format!("创建托盘菜单分隔失败（{err}）"))?;

    let mut items: Vec<&dyn IsMenuItem<Wry>> = Vec::new();
    if !theme_items.is_empty() {
        items.push(&header);
        items.push(&sep_after_header);
        for item in &theme_items {
            items.push(item);
        }
        items.push(&sep_after_themes);
    }
    items.push(&restore_default);
    items.push(&sep_before_show);
    items.push(&show);
    items.push(&quit);

    Menu::with_items(app, &items).map_err(|err| format!("组装托盘菜单失败（{err}）"))
}

/// 托盘里点了一个主题：后台复用同一条应用链路（决策 30）
///
/// 失败不弹窗——托盘没有 toast 通道，为它引通知依赖不值得（决策 9）；
/// 记日志后重查菜单，过期条目自愈。
fn apply_theme_from_tray(app: &AppHandle, theme_id: &str) {
    let app = app.clone();
    let theme_id = theme_id.to_string();
    std::thread::spawn(move || {
        let outcome = apply_by_id(&theme_id);
        if let Err(err) = &outcome {
            log::warn("tray", &format!("托盘应用主题失败：{err}"));
        }
        refresh(&app);
    });
}

/// 托盘里点了「还原默认光标」：走与应用 / 还原命令同一条链路（决策 30）
fn restore_default_from_tray(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(err) = restore() {
            log::warn("tray", &format!("托盘还原默认失败：{err}"));
        }
        refresh(&app);
    });
}

/// 把主窗口叫回前台（托盘菜单 / 托盘单击共用）
pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme(id: &str, name: &str) -> CursorTheme {
        CursorTheme {
            id: id.to_string(),
            name: name.to_string(),
            description: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            is_built_in: false,
            cursors: Vec::new(),
        }
    }

    fn entry(id: &str) -> HistoryEntry {
        HistoryEntry {
            theme_id: id.to_string(),
            name: id.to_string(),
            is_built_in: false,
            applied_at: "2026-10-28 12:00".to_string(),
        }
    }

    #[test]
    fn 菜单只保留仍存在的最近主题且按时间倒序() {
        let themes = vec![theme("a", "甲"), theme("b", "乙")];
        let recent = vec![entry("b"), entry("gone"), entry("a")];

        let actions = plan_theme_actions(&themes, &recent, None);

        let ids: Vec<&str> = actions.iter().map(|action| action.id.as_str()).collect();
        assert_eq!(ids, vec!["apply:b", "apply:a"], "已删除的主题要摘掉");
        assert!(actions.iter().all(|action| !action.checked));
        assert!(actions.iter().all(|action| action.id.starts_with("apply:")));
    }

    #[test]
    fn 当前主题置顶勾选且不重复出现() {
        let themes = vec![theme("a", "甲"), theme("b", "乙")];
        let recent = vec![entry("a"), entry("b")];

        let actions = plan_theme_actions(&themes, &recent, Some("a"));

        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].id, "apply:a");
        assert!(actions[0].checked, "当前主题要勾上");
        assert!(!actions[1].checked);
        assert_eq!(actions[1].id, "apply:b");
    }

    #[test]
    fn 菜单条目有数量上限() {
        let themes: Vec<_> = (0..20).map(|i| theme(&format!("t{i}"), "T")).collect();
        let recent: Vec<_> = (0..20).map(|i| entry(&format!("t{i}"))).collect();

        let actions = plan_theme_actions(&themes, &recent, Some("t0"));

        assert_eq!(actions.len(), RECENT_MENU_LIMIT);
        assert!(actions[0].checked, "当前主题占一条且必须勾上");
    }

    #[test]
    fn 菜单标签跟随主题当前名字() {
        let themes = vec![theme("a", "新名字")];
        // 历史记录里的名字是应用时的快照，菜单不该再叫旧名
        let recent = vec![entry("a")];

        let actions = plan_theme_actions(&themes, &recent, None);
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].label, "新名字");
    }

    #[test]
    fn 当前主题不在清单里时整个菜单留空() {
        let actions = plan_theme_actions(&[], &[entry("a")], Some("missing"));
        assert!(actions.is_empty(), "读不出主题时不能给出点了没反应的条目");
    }
}
