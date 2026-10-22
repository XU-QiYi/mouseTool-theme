//! 托盘图标：只在「关闭行为 = 最小化到托盘」时存在
//!
//! 关窗不退而是缩到托盘时，必须有个东西能把窗口叫回来，也得有个明确的
//! 「退出」出口——两件事都由托盘菜单承担（单击图标 = 打开主界面）。
//! 关闭行为切回「直接退出」时托盘随之移除，不留一个悬空图标。

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

use crate::utils::settings::{self, CloseBehavior};

const TRAY_ID: &str = "main";
const TOOLTIP: &str = "鼠标主题工具";

/// 按当前设置同步托盘的有无（启动时调一次，设置变更后再调一次）
///
/// 创建失败只记日志：托盘是「关闭到托盘」的配套件，创建不上不代表应用
/// 不能用——此时关窗仍按设置隐藏，用户可以从开始菜单再打开。
pub fn sync(app: &AppHandle) {
    match settings::read().close_behavior {
        CloseBehavior::Tray => {
            if app.tray_by_id(TRAY_ID).is_none() {
                if let Err(err) = build(app) {
                    eprintln!("[tray] 创建托盘图标失败：{err}");
                }
            }
        }
        CloseBehavior::Exit => {
            // 返回的图标被立刻丢弃 = 移除，正是想要的
            let _ = app.remove_tray_by_id(TRAY_ID);
        }
    }
}

fn build(app: &AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败（{err}）"))?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|err| format!("创建托盘菜单项失败（{err}）"))?;
    let menu = Menu::with_items(app, &[&show, &quit])
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
            _ => {}
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

/// 把主窗口叫回前台（托盘菜单 / 托盘单击共用）
pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
