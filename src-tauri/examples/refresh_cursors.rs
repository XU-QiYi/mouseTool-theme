//! 光标切换验证程序（普通 Win32 进程，非 AppContainer）
//!
//! Store 版 PowerShell 运行在 AppContainer 里，调用 SystemParametersInfo 会返回
//! 1400/6 错误；本程序是普通 exe，与应用的真实运行环境一致。
//!
//! 运行：双击 target\debug\examples\refresh_cursors.exe
//! 或：cargo run --example refresh_cursors

use std::io::{self, Write};

use mousetool_theme_lib::models::CursorSlot;
use mousetool_theme_lib::utils::registry;

fn wait_enter(msg: &str) {
    print!("{msg}");
    io::stdout().flush().ok();
    let mut buf = String::new();
    io::stdin().read_line(&mut buf).ok();
}

fn main() {
    println!("=== 光标切换验证（普通 Win32 进程）===");
    println!();

    // 1. 备份当前设置
    let backup: Vec<(String, String)> = registry::SLOT_DEFS
        .iter()
        .map(|(key, _, _)| (key.to_string(), registry::read_slot_value(key).unwrap_or_default()))
        .collect();
    let backup_name = registry::read_slot_value("SchemeName").unwrap_or_default();
    let filled = backup.iter().filter(|(_, v)| !v.is_empty()).count();
    println!("已备份当前设置（{filled} 个槽位有值）");
    println!();

    // 2. 清空 → 刷新
    println!("[1/2] 切换为系统默认光标……");
    if let Err(err) = registry::clear_cursors() {
        println!("  ✗ 清空注册表失败：{err}");
        return;
    }
    match registry::refresh_cursors() {
        Ok(()) => println!("  ✓ 刷新成功 —— 你的鼠标现在应该是系统默认的白色箭头"),
        Err(err) => println!("  ✗ 刷新失败：{err}"),
    }
    wait_enter("\n看完变化后按回车恢复原主题……");

    // 3. 恢复 → 刷新
    println!();
    println!("[2/2] 恢复原有主题……");
    let restored: Vec<CursorSlot> = backup
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| CursorSlot {
            registry_key: key.clone(),
            display_name: String::new(),
            english_name: String::new(),
            file_path: value.clone(),
            file_type: String::new(),
        })
        .collect();

    if let Err(err) = registry::write_cursors(&restored, &backup_name) {
        println!("  ✗ 恢复注册表失败：{err}");
        return;
    }
    match registry::refresh_cursors() {
        Ok(()) => println!("  ✓ 已恢复，鼠标应变回原来的主题"),
        Err(err) => println!("  ✗ 刷新失败：{err}"),
    }

    // 若原本没有方案名，清回去
    if backup_name.is_empty() {
        println!("  （原方案名为空，已保留空值）");
    }

    println!();
    println!("验证结束。");
    wait_enter("按回车关闭……");
}
