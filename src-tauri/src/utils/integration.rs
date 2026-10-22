//! 系统集成：单实例互斥、`--import` 转交、`.zip` 右键菜单注册
//!
//! 全部零新依赖：互斥与窗口激活用已有 `windows` crate，
//! 右键菜单写 HKCU（无需 UAC）。右键菜单是**试点**（决策 12）：
//! 先做出来在真机看效果，再决定去留——所以开关做成设置页里的用户动作，
//! 不在安装时悄悄写系统。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;
use windows::core::HSTRING;
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow, ShowWindow, SW_RESTORE};

use crate::utils::paths;

/// 单实例互斥名。`Local\` 前缀 = 会话内命名空间，多用户互不干扰
const MUTEX_NAME: &str = "Local\\CursorStudio.SingleInstance";
/// 主窗口标题（`tauri.conf.json` 的窗口 title），用于把旧实例拉到前台
const WINDOW_TITLE: &str = "鼠标主题工具";
/// `.zip` 右键菜单的注册表键（应用私有命名空间，不碰别人的扩展项）
const SHELL_KEY: &str = "Software\\Classes\\SystemFileAssociations\\.zip\\shell\\CursorStudio.Import";
/// 右键菜单显示文案
const MENU_LABEL: &str = "用鼠标主题工具导入";

// ---------------------------------------------------------------------------
// 启动参数与单实例
// ---------------------------------------------------------------------------

/// 解析启动参数里的 `--import <zip 路径>`（右键菜单写入的命令长这样）
pub fn startup_import_arg() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|arg| arg == "--import")
        .and_then(|index| args.get(index + 1).cloned())
}

/// 是否已有实例在跑。
///
/// 判据是命名互斥体上的 `ERROR_ALREADY_EXISTS`（183）。CreateMutexW 对已存在的
/// 互斥体也返回成功，必须看 last error，不能只看返回值。拿到全新锁后**故意不关
/// 句柄**：句柄活着，锁才陪进程到退出。
pub fn already_running() -> bool {
    let name = HSTRING::from(MUTEX_NAME);
    match unsafe { CreateMutexW(None, false, &name) } {
        Ok(_) => std::io::Error::last_os_error().raw_os_error() == Some(183),
        Err(_) => false, // 建不了锁就不拦用户，宁可多开一个窗口
    }
}

/// 把已运行的实例拉到前台。找不到窗口（标题被改、权限差异）就算了，静默放弃：
/// 待导入路径已经落盘，用户下次聚焦窗口时照样会领走。
pub fn activate_existing() -> bool {
    let title = HSTRING::from(WINDOW_TITLE);
    // windows 0.56 的 FindWindowW 直接返回 HWND，找不到是零值而非 Err
    let hwnd = unsafe { FindWindowW(None, &title) };
    if hwnd.0 == 0 {
        return false;
    }
    // 先还原再置前：窗口可能正藏在托盘里（关闭行为 = 最小化到托盘），
    // 对隐藏窗只调 SetForegroundWindow 是叫不回来的
    let _ = unsafe { ShowWindow(hwnd, SW_RESTORE) };
    let _ = unsafe { SetForegroundWindow(hwnd) };
    true
}

/// 启动期统一入口：单实例判定 + `--import` 转交。
///
/// - 已有实例：把待导入路径落盘 → 拉起旧窗口 → 本进程退出；
/// - 首个实例：把待导入路径落盘（前端启动后领取），继续正常启动。
///
/// 不带 `--import` 的普通二次启动也走这里：聚焦旧实例，不双开。
pub fn handle_launch() {
    let import = startup_import_arg();

    if already_running() {
        if let Some(path) = &import {
            let _ = write_pending_import(path);
        }
        activate_existing();
        std::process::exit(0);
    }

    if let Some(path) = &import {
        let _ = write_pending_import(path);
    }
}

// ---------------------------------------------------------------------------
// 待导入转交文件
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct PendingImport {
    path: String,
}

fn write_pending_import_at(file: &Path, zip_path: &str) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        paths::ensure_dir(parent)?;
    }
    let payload = serde_json::to_string(&PendingImport {
        path: zip_path.to_string(),
    })
    .map_err(|err| format!("整理待导入路径失败（{err}）"))?;
    fs::write(file, payload).map_err(|err| format!("写入待导入路径失败（{err}）"))
}

fn read_pending_import_at(file: &Path) -> Option<String> {
    let raw = fs::read_to_string(file).ok()?;
    let _ = fs::remove_file(file); // 领取即消费，读坏了也不能让文件残留反复触发
    serde_json::from_str::<PendingImport>(&raw).ok().map(|p| p.path)
}

/// 落盘待导入路径（转交通路的一半）
pub fn write_pending_import(zip_path: &str) -> Result<(), String> {
    write_pending_import_at(&paths::pending_import_file(), zip_path)
}

/// 领取待导入路径；没有或已损坏返回 `None`（领取即删除，只消费一次）
pub fn take_pending_import() -> Option<String> {
    read_pending_import_at(&paths::pending_import_file())
}

// ---------------------------------------------------------------------------
// .zip 右键菜单（试点）
// ---------------------------------------------------------------------------

/// 当前程序的可执行文件路径（右键菜单命令指向它）
fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| format!("定位当前程序失败（{err}）"))
}

fn menu_registered(key_path: &str) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(format!("{key_path}\\command"))
        .and_then(|command| command.get_value::<String, _>(""))
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn set_menu(key_path: &str, exe: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // 先清旧注册：exe 路径变了，残留的旧命令只会让右键点了没反应
    let _ = hkcu.delete_subkey_all(key_path);

    let (key, _) = hkcu
        .create_subkey(key_path)
        .map_err(|err| format!("创建右键菜单注册表键失败（{err}）"))?;
    key.set_value("", &MENU_LABEL)
        .map_err(|err| format!("写入右键菜单文案失败（{err}）"))?;
    key.set_value("Icon", &exe)
        .map_err(|err| format!("写入右键菜单图标失败（{err}）"))?;

    let (command, _) = hkcu
        .create_subkey(format!("{key_path}\\command"))
        .map_err(|err| format!("创建右键菜单命令键失败（{err}）"))?;
    command
        .set_value("", &format!("\"{exe}\" --import \"%1\""))
        .map_err(|err| format!("写入右键菜单命令失败（{err}）"))?;
    Ok(())
}

fn remove_menu(key_path: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.delete_subkey_all(key_path)
        .or_else(|err| match err.kind() {
            // 本来就没注册 = 移除成功
            std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(err),
        })
        .map_err(|err| format!("移除右键菜单注册失败（{err}）"))
}

/// 注册右键菜单，返回写入的 exe 路径（界面展示用）
pub fn register_zip_menu() -> Result<String, String> {
    let exe = current_exe_path()?;
    set_menu(SHELL_KEY, &exe)?;
    Ok(exe)
}

/// 移除右键菜单注册；本来就没注册也算成功
pub fn unregister_zip_menu() -> Result<(), String> {
    remove_menu(SHELL_KEY)
}

/// 右键菜单当前状态：是否已注册 + 当前程序路径（注册时指向的会是它）
pub fn zip_menu_status() -> (bool, String) {
    (
        menu_registered(SHELL_KEY),
        current_exe_path().unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用键名：绝不碰真实注册（也不需要备份恢复）
    const TEST_KEY: &str =
        "Software\\Classes\\SystemFileAssociations\\.zip\\shell\\CursorStudio.TestImport";

    #[test]
    fn 待导入路径领取即消费() {
        let file = std::env::temp_dir().join("cursorstudio-pending-test.json");
        let _ = fs::remove_file(&file);

        assert_eq!(read_pending_import_at(&file), None, "没有文件应返回 None");

        write_pending_import_at(&file, "C:\\tmp\\some.zip").expect("写入待导入路径");
        assert_eq!(
            read_pending_import_at(&file).as_deref(),
            Some("C:\\tmp\\some.zip")
        );
        assert!(
            !file.exists(),
            "领取即删除：残留会让人怀疑导入没生效"
        );
        assert_eq!(read_pending_import_at(&file), None, "第二次领取应为空");
    }

    #[test]
    fn 坏掉的转交文件应返回空且不残留() {
        let file = std::env::temp_dir().join("cursorstudio-pending-broken.json");
        fs::write(&file, "{ 不是 json").expect("写坏文件");

        assert_eq!(read_pending_import_at(&file), None);
        assert!(!file.exists(), "读坏也应消费掉，不能反复触发");
    }

    #[test]
    fn 右键菜单注册与移除往返() {
        let _ = remove_menu(TEST_KEY); // 起点干净

        assert!(!menu_registered(TEST_KEY), "起点应未注册");

        set_menu(TEST_KEY, "C:\\demo\\mousetool-theme.exe").expect("注册");
        assert!(menu_registered(TEST_KEY), "注册后应可读到命令");

        // 命令串必须带引号包住 exe：安装路径含空格时靠它不散架
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let command = hkcu
            .open_subkey(format!("{TEST_KEY}\\command"))
            .and_then(|key| key.get_value::<String, _>(""))
            .expect("读回命令");
        assert_eq!(
            command,
            "\"C:\\demo\\mousetool-theme.exe\" --import \"%1\""
        );

        remove_menu(TEST_KEY).expect("移除");
        assert!(!menu_registered(TEST_KEY), "移除后应干净");
        remove_menu(TEST_KEY).expect("重复移除应视作成功");
    }
}
