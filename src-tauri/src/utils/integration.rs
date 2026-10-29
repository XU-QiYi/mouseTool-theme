//! 系统集成：单实例互斥、`--import` 转交、主题文件右键菜单注册
//!
//! 全部零新依赖：互斥与窗口激活用已有 `windows` crate，
//! 右键菜单写 HKCU（无需 UAC）。右键菜单是**试点**（决策 12），
//! 决策 41 起覆盖三类主题文件（`.zip` / `.themepack` / `.theme`）：
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

use crate::utils::{limits, paths};

/// 单实例互斥名。`Local\` 前缀 = 会话内命名空间，多用户互不干扰
const MUTEX_NAME: &str = "Local\\CursorStudio.SingleInstance";
/// 主窗口标题（`tauri.conf.json` 的窗口 title），用于把旧实例拉到前台
const WINDOW_TITLE: &str = "鼠标主题工具";
/// 右键菜单显示文案
const MENU_LABEL: &str = "用鼠标主题工具导入";

// ---------------------------------------------------------------------------
// 启动参数与单实例
// ---------------------------------------------------------------------------

/// 解析启动参数里的 `--import <主题文件路径>`（右键菜单写入的命令长这样；
/// 路径可以是 .zip / .themepack / .theme，导入按扩展名分发，决策 41）
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
    let raw = limits::read_text_bounded(file, limits::MAX_STATE_FILE_BYTES);
    // 领取即消费：读取失败（过大 / 权限 / 非法 UTF-8）也必须删掉，
    // 否则每次启动和聚焦都会重试同一个坏文件
    let _ = fs::remove_file(file);
    let raw = raw.ok()?;
    serde_json::from_str::<PendingImport>(&raw).ok().map(|p| p.path)
}

/// 落盘待导入路径（转交通路的一半）
pub fn write_pending_import(zip_path: &str) -> Result<(), String> {
    write_pending_import_at(&paths::pending_import_file()?, zip_path)
}

/// 领取待导入路径；没有、已损坏或数据目录不可用都返回 `None`
/// （领取即删除，只消费一次）
pub fn take_pending_import() -> Option<String> {
    let file = match paths::pending_import_file() {
        Ok(file) => file,
        Err(err) => {
            eprintln!("[integration] 读取待导入路径失败：{err}");
            return None;
        }
    };
    read_pending_import_at(&file)
}

// ---------------------------------------------------------------------------
// 主题文件右键菜单（决策 12 试点，决策 41 扩展到三类）
// ---------------------------------------------------------------------------

/// 当前程序的可执行文件路径（右键菜单命令指向它）
fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| format!("定位当前程序失败（{err}）"))
}

/// 右键菜单注册的三类扩展名（应用私有命名空间，不碰别人的扩展项）：
/// `.zip` / `.themepack` 主题包与 `.theme` 光标方案——`--import` 转交后
/// 都走同一条 `import_theme` 链路（决策 16/36/39）
const IMPORT_MENU_KEYS: [&str; 3] = [
    "Software\\Classes\\SystemFileAssociations\\.zip\\shell\\CursorStudio.Import",
    "Software\\Classes\\SystemFileAssociations\\.themepack\\shell\\CursorStudio.Import",
    "Software\\Classes\\SystemFileAssociations\\.theme\\shell\\CursorStudio.Import",
];

fn menu_registered(key_path: &str) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    hkcu.open_subkey(format!("{key_path}\\command"))
        .and_then(|command| command.get_value::<String, _>(""))
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn set_menu(key_path: &str, exe: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // 先清旧注册：exe 路径变了，残留的旧命令只会让右键点了没反应。
    // 注册表的删除是延迟生效的——删完立刻重建会撞 os error 1018
    // （键还在「被标记删除」状态），开关快速开→关→开时真实可触发，重试等它落地
    let _ = hkcu.delete_subkey_all(key_path);
    for attempt in 0..3 {
        match create_menu(&hkcu, key_path, exe) {
            Ok(()) => return Ok(()),
            Err(err) if attempt < 2 && err.contains("1018") => {
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            Err(err) => return Err(err),
        }
    }
    unreachable!("循环内要么成功要么返回")
}

fn create_menu(hkcu: &RegKey, key_path: &str, exe: &str) -> Result<(), String> {
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
///
/// 三类扩展名一把注册（决策 41）：任何一把失败就整体回滚（已写的键全删），
/// 不留「.zip 有、.themepack 没有」的半吊子状态——开关语义必须是全有或全无。
pub fn register_zip_menu() -> Result<String, String> {
    let exe = current_exe_path()?;
    register_menus(&IMPORT_MENU_KEYS, &exe)?;
    Ok(exe)
}

/// 把一批键全部注册；任何一把失败就把已写的全删（全有或全无）
fn register_menus(keys: &[&str], exe: &str) -> Result<(), String> {
    let mut written: Vec<&str> = Vec::new();
    if let Err(err) = (|| {
        for key in keys {
            set_menu(key, exe)?;
            written.push(key);
        }
        Ok(())
    })() {
        for key in written {
            let _ = remove_menu(key);
        }
        return Err(err);
    }
    Ok(())
}

/// 移除右键菜单注册；本来就没注册也算成功
pub fn unregister_zip_menu() -> Result<(), String> {
    let mut first_err = None;
    for key in IMPORT_MENU_KEYS {
        if let Err(err) = remove_menu(key) {
            first_err.get_or_insert(err);
        }
    }
    match first_err {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// 右键菜单当前状态：三类键**全部**注册才算已注册 + 当前程序路径
/// （部分注册显示为未注册，用户重新打开开关即可自愈）
pub fn zip_menu_status() -> (bool, String) {
    (
        IMPORT_MENU_KEYS.iter().all(|key| menu_registered(key)),
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

    /// 超过读取上限的转交文件同样要被消费，否则会反复触发启动检查
    #[test]
    fn 超大的转交文件也被消费() {
        let file = std::env::temp_dir().join("cursorstudio-pending-oversized.json");
        fs::write(
            &file,
            "x".repeat(limits::MAX_STATE_FILE_BYTES as usize + 1),
        )
        .expect("写超大转交文件");

        assert_eq!(read_pending_import_at(&file), None);
        assert!(!file.exists(), "读失败也必须删除，不能反复触发");
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

    /// 三类扩展名的测试键（.zip / .themepack / .theme），对应 IMPORT_MENU_KEYS 结构。
    /// 叶名带后缀与上方往返测试的键分开：注册表删除是延迟生效的，同键先后
    /// 复用会撞 os error 1018（键被标记删除）
    const TEST_KEYS: [&str; 3] = [
        "Software\\Classes\\SystemFileAssociations\\.zip\\shell\\CursorStudio.TestImport.Zip",
        "Software\\Classes\\SystemFileAssociations\\.themepack\\shell\\CursorStudio.TestImport.Pack",
        "Software\\Classes\\SystemFileAssociations\\.theme\\shell\\CursorStudio.TestImport.Theme",
    ];

    #[test]
    fn 三类扩展名一把注册全部生效() {
        for key in TEST_KEYS {
            let _ = remove_menu(key); // 起点干净
        }

        register_menus(&TEST_KEYS, "C:\\demo\\mousetool-theme.exe").expect("批量注册");
        assert!(
            TEST_KEYS.iter().all(|key| menu_registered(key)),
            "三类键全部注册：开关语义是全有"
        );

        unregister_by_keys(&TEST_KEYS);
        assert!(
            TEST_KEYS.iter().all(|key| !menu_registered(key)),
            "批量移除后三类键全干净"
        );
    }

    /// 与 `unregister_zip_menu` 相同的「NotFound 也算成功」语义，供测试键使用
    fn unregister_by_keys(keys: &[&str]) {
        for key in keys {
            let _ = remove_menu(key);
        }
    }

    #[test]
    fn 批量注册失败时整体回滚() {
        for key in TEST_KEYS {
            let _ = remove_menu(key);
        }
        // 第三把键名超过注册表 255 字符上限，create 必失败 → 前两把必须被回滚
        let doomed = format!(
            "Software\\Classes\\SystemFileAssociations\\.zip\\shell\\{}",
            "X".repeat(300)
        );
        let keys = [TEST_KEYS[0], TEST_KEYS[1], doomed.as_str()];

        let err = register_menus(&keys, "C:\\demo\\mousetool-theme.exe")
            .expect_err("超长键名应让批量注册失败");
        assert!(!err.is_empty());
        assert!(
            keys[..2].iter().all(|key| !menu_registered(key)),
            "已写的前两把必须被回滚，不留半吊子注册"
        );
    }
}
