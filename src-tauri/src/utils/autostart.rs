//! 开机自启动：写 `HKCU\...\Run`，无需 UAC
//!
//! 真相在注册表——界面只是读写它，不另存一份「是否自启动」的配置，
//! 免得两处不一致。与 `.zip` 右键菜单（决策 12）同一口径：注册的是
//! **当前程序位置**，移动安装目录后需在设置里重新开启。

use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
use winreg::RegKey;

/// 默认注册表键与值名（测试用走显式参数，绝不碰真实键）
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_NAME: &str = "CursorStudio";

/// 当前程序路径（注册表值指向它）
fn current_exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| format!("定位当前程序失败（{err}）"))
}

/// 从注册表值里取出程序路径：写入时带引号，读回要剥掉
fn exe_from_command(command: &str) -> String {
    let trimmed = command.trim();
    match trimmed.strip_prefix('"').and_then(|rest| rest.split_once('"')) {
        Some((exe, _)) => exe.to_string(),
        // 没有引号（旧版或手工写入）：整串就是命令，原样展示
        None => trimmed.to_string(),
    }
}

/// 自启动状态：是否已注册 + **注册表里实际登记**的 exe（界面展示用）
///
/// 不能拿 `current_exe()` 顶上：程序移动过之后，注册表里仍是旧路径，
/// 界面上「命令指向」必须显示那个旧路径，用户才知道自启动为什么失效。
pub fn status_at(key_path: &str, name: &str) -> (bool, String) {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let command = hkcu
        .open_subkey(key_path)
        .and_then(|key| key.get_value::<String, _>(name))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    match command {
        Some(command) => (true, exe_from_command(&command)),
        None => (false, String::new()),
    }
}

/// 写入 / 移除自启动项
pub fn set_at(key_path: &str, name: &str, exe: &str, enable: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if enable {
        let (key, _) = hkcu
            .create_subkey(key_path)
            .map_err(|err| format!("打开自启动注册表键失败（{err}）"))?;
        // 值带引号：安装路径含空格时 Run 键不会把它劈成两截
        key.set_value(name, &format!("\"{exe}\""))
            .map_err(|err| format!("写入自启动项失败（{err}）"))?;
    } else {
        // 要删值得带 KEY_SET_VALUE 打开：默认的 open_subkey 是只读句柄；
        // 连键都没有 = 从未注册过，不用删
        if let Ok(key) = hkcu.open_subkey_with_flags(key_path, KEY_SET_VALUE) {
            key.delete_value(name).or_else(|err| match err.kind() {
                // 本来就没有 = 移除成功
                std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(err),
            }).map_err(|err| format!("移除自启动项失败（{err}）"))?;
        }
    }
    Ok(())
}

pub fn status() -> (bool, String) {
    status_at(RUN_KEY, RUN_NAME)
}

/// 注册 / 移除开机自启动，返回操作后的状态
pub fn set(enable: bool) -> Result<(bool, String), String> {
    let exe = current_exe_path()?;
    set_at(RUN_KEY, RUN_NAME, &exe, enable)?;
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试专用键：绝不碰真实 Run 键
    const TEST_KEY: &str = "Software\\CursorStudio.Test\\Run";

    /// 碰注册表的测试必须串行，否则互相踩踏（防中毒取回锁）
    static REGISTRY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn 自启动注册与移除往返() {
        let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let _ = set_at(TEST_KEY, "TestApp", "C:\\demo\\app.exe", false); // 起点干净

        assert!(!status_at(TEST_KEY, "TestApp").0, "起点应未注册");

        set_at(TEST_KEY, "TestApp", "C:\\demo\\app.exe", true).expect("注册");
        let (enabled, exe) = status_at(TEST_KEY, "TestApp");
        assert!(enabled, "注册后应可读到");
        assert_eq!(
            exe, "C:\\demo\\app.exe",
            "状态里的路径必须来自注册表且剥掉引号，不能拿当前进程路径顶替"
        );

        // 值必须带引号包住 exe：路径含空格时不被 Run 键劈开
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let value: String = hkcu
            .open_subkey(TEST_KEY)
            .and_then(|key| key.get_value("TestApp"))
            .expect("读回自启动值");
        assert_eq!(value, "\"C:\\demo\\app.exe\"");

        set_at(TEST_KEY, "TestApp", "C:\\demo\\app.exe", false).expect("移除");
        assert!(!status_at(TEST_KEY, "TestApp").0, "移除后应干净");

        // 重复移除视作成功；键不存在时移除也视作成功
        set_at(TEST_KEY, "TestApp", "C:\\demo\\app.exe", false).expect("重复移除");
        let _ = hkcu.delete_subkey_all(TEST_KEY);
    }
}
