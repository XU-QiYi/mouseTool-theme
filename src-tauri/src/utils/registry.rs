use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::{RegKey, RegValue};

use std::path::Path;

use crate::models::{CursorSlot, CursorTheme};
use crate::utils::theme_paths;

/// 15 个标准光标槽位：(注册表键名, 中文名, 英文名)
///
/// 顺序即 `Schemes` 中逗号分隔路径的位置顺序，不可调整。
/// 依据：`HKCU\Control Panel\Cursors\Schemes` 实测值。
pub const SLOT_DEFS: [(&str, &str, &str); 15] = [
    ("Arrow", "正常选择", "Normal Select"),
    ("Help", "帮助选择", "Help Select"),
    ("AppStarting", "后台运行", "Working in Background"),
    ("Wait", "忙", "Busy"),
    ("Crosshair", "精确选择", "Precision Select"),
    ("IBeam", "文本选择", "Text Select"),
    ("NWPen", "手写笔", "Handwriting"),
    ("No", "不可用", "Unavailable"),
    ("SizeNS", "垂直调整大小", "Vertical Resize"),
    ("SizeWE", "水平调整大小", "Horizontal Resize"),
    ("SizeNWSE", "对角线调整 1", "Diagonal Resize 1"),
    ("SizeNESW", "对角线调整 2", "Diagonal Resize 2"),
    ("SizeAll", "移动", "Move"),
    ("UpArrow", "候选选择", "Alternate Select"),
    ("Hand", "链接选择", "Link Select"),
];

const CURSORS_KEY: &str = r"Control Panel\Cursors";

// 测试用线程内覆盖：用例只读写 HKCU 下的隔离键，不碰真实光标设置。
// 与 `paths` 的测试覆盖同一套思路：cargo test 每个用例占一个线程，
// 覆盖只影响当前用例；CI 里也不会改出任何用户可见的光标变化。
#[cfg(test)]
thread_local! {
    static TEST_CURSORS_KEY: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

/// 当前使用的 Cursors 键路径（测试时可能是隔离键）
fn cursors_key() -> String {
    #[cfg(test)]
    if let Some(path) = TEST_CURSORS_KEY.with(|slot| slot.borrow().clone()) {
        return path;
    }
    CURSORS_KEY.to_string()
}

fn schemes_key() -> String {
    format!(r"{}\Schemes", cursors_key())
}

#[cfg(test)]
fn testing() -> bool {
    TEST_CURSORS_KEY.with(|slot| slot.borrow().is_some())
}

/// 让其它模块的测试把注册表读写指到隔离键，避免碰真实光标设置
#[cfg(test)]
pub fn set_test_cursors_key(path: Option<String>) {
    TEST_CURSORS_KEY.with(|slot| *slot.borrow_mut() = path);
}

/// 把 `%SystemRoot%\cursors\arrow.cur` 这类写法展开为真实路径
fn expand_env(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        match rest[start + 1..].find('%') {
            Some(end) => {
                let var = &rest[start + 1..start + 1 + end];
                match std::env::var(var) {
                    Ok(val) => out.push_str(&val),
                    Err(_) => out.push_str(&rest[start..start + end + 2]),
                }
                rest = &rest[start + end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// 注册表字符串值是 UTF-16LE 编码，需按两字节一组解码
fn decode_utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .trim_end_matches('\0')
        .to_string()
}

/// 只接受字符串类型的注册表值，其它类型返回 `None`
fn value_to_string(value: &RegValue) -> Option<String> {
    match value.vtype {
        RegType::REG_SZ | RegType::REG_EXPAND_SZ => Some(decode_utf16(&value.bytes)),
        _ => None,
    }
}

fn file_type_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

/// 把一条方案字符串按逗号拆开，按位置映射到 15 个槽位
fn parse_scheme(name: &str, raw: &str) -> CursorTheme {
    let parts: Vec<&str> = raw.split(',').collect();
    let mut cursors = Vec::new();

    for (index, (key, cn_name, en_name)) in SLOT_DEFS.iter().enumerate() {
        let raw_path = parts.get(index).map(|part| part.trim()).unwrap_or("");
        if raw_path.is_empty() {
            continue;
        }
        let file_path = expand_env(raw_path);
        cursors.push(CursorSlot {
            registry_key: (*key).to_string(),
            display_name: (*cn_name).to_string(),
            english_name: (*en_name).to_string(),
            file_type: file_type_of(&file_path),
            file_path,
        });
    }

    CursorTheme {
        id: format!("sys_{name}"),
        name: name.to_string(),
        description: String::new(),
        created_at: String::new(),
        updated_at: String::new(),
        is_built_in: true,
        cursors,
    }
}

/// 读取注册表里所有已保存的光标方案
pub fn read_system_schemes() -> Result<Vec<CursorTheme>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = schemes_key();
    let key = hkcu
        .open_subkey_with_flags(&key_path, KEY_READ)
        .map_err(|err| format!("无法打开注册表键 HKCU\\{key_path}：{err}"))?;

    let mut themes = Vec::new();
    for item in key.enum_values() {
        let (name, value) = item.map_err(|err| format!("遍历方案列表失败：{err}"))?;
        let Some(raw) = value_to_string(&value) else {
            continue;
        };
        themes.push(parse_scheme(&name, &raw));
    }

    themes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(themes)
}

/// 应用主题：把 15 个标准槽位写入注册表
///
/// 主题中未提供的槽位写为空字符串，表示该槽位回落到系统默认光标。
/// 只写 HKCU，无需管理员权限。
pub fn write_cursors(slots: &[CursorSlot], theme_name: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = cursors_key();
    let key = hkcu
        .open_subkey_with_flags(&key_path, KEY_WRITE)
        .map_err(|err| format!("无法打开注册表键 HKCU\\{key_path}：{err}"))?;

    for (slot_key, _, _) in SLOT_DEFS.iter() {
        let path = slots
            .iter()
            .find(|slot| slot.registry_key == *slot_key)
            .map(|slot| slot.file_path.as_str())
            .unwrap_or("");
        key.set_value(*slot_key, &path.to_string())
            .map_err(|err| format!("写入 {slot_key} 失败：{err}"))?;
    }

    // 系统「鼠标设置」里显示的方案名
    key.set_value("SchemeName", &theme_name.to_string())
        .map_err(|err| format!("写入方案名失败：{err}"))?;
    key.set_value("", &theme_name.to_string())
        .map_err(|err| format!("写入默认值失败：{err}"))?;

    Ok(())
}

/// 恢复系统默认：清空 15 个标准槽位
pub fn clear_cursors() -> Result<(), String> {
    let empty = String::new();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = cursors_key();
    let key = hkcu
        .open_subkey_with_flags(&key_path, KEY_WRITE)
        .map_err(|err| format!("无法打开注册表键 HKCU\\{key_path}：{err}"))?;

    for (slot_key, _, _) in SLOT_DEFS.iter() {
        key.set_value(*slot_key, &empty)
            .map_err(|err| format!("清空 {slot_key} 失败：{err}"))?;
    }
    key.set_value("SchemeName", &empty)
        .map_err(|err| format!("清空方案名失败：{err}"))?;
    key.set_value("", &empty)
        .map_err(|err| format!("清空默认值失败：{err}"))?;

    Ok(())
}

/// 通知系统立即刷新光标（无需注销）
///
/// 只传 `SPIF_SENDCHANGE`：光标路径已由 [`write_cursors`] 直接写入注册表，
/// 此时只需让系统重新加载。若再带 `SPIF_UPDATEINIFILE`，系统会去回写用户配置，
/// 在部分机器上该步骤返回 ERROR_INVALID_HANDLE(0x80070006)，使整个调用失败。
pub fn refresh_cursors() -> Result<(), String> {
    // 隔离模式下写的不是真实光标键，通知系统刷新既无意义也会干扰跑测试的人
    #[cfg(test)]
    if testing() {
        return Ok(());
    }

    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPIF_SENDCHANGE, SPI_SETCURSORS,
    };

    unsafe {
        SystemParametersInfoW(SPI_SETCURSORS, 0, None, SPIF_SENDCHANGE)
            .map_err(|err| format!("刷新系统光标失败：{err}"))
    }
}

/// 读取注册表里当前生效的光标设置：只返回非空槽位，环境变量已展开
///
/// 「哪个主题正在使用」的唯一事实来源是注册表，不是界面内存状态——
/// 内存状态一重开就没了，会把已应用的主题当成可用主题再点一次。
pub fn read_current_slots() -> Result<Vec<(String, String)>, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = cursors_key();
    let key = hkcu
        .open_subkey_with_flags(&key_path, KEY_READ)
        .map_err(|err| format!("无法读取注册表键 HKCU\\{key_path}：{err}"))?;

    let mut slots = Vec::new();
    for (slot_key, _, _) in SLOT_DEFS.iter() {
        // 值缺失或为空 = 该槽位回落到系统默认，不参与比对
        if let Ok(raw) = key.get_value::<String, _>(*slot_key) {
            let raw = raw.trim();
            if !raw.is_empty() {
                slots.push(((*slot_key).to_string(), expand_env(raw)));
            }
        }
    }
    Ok(slots)
}

/// 注册表里记录的方案名
///
/// 只用于「多套主题指向同一批文件时该标哪个」，不参与是否一致的判断：
/// 改名后方案名会滞后于主题名，拿它做判断会把正在使用的主题判成没用。
pub fn read_scheme_name() -> String {
    read_slot_value("SchemeName").unwrap_or_default()
}

/// 读取指定槽位的当前值，测试与备份用
pub fn read_slot_value(slot_key: &str) -> Result<String, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = cursors_key();
    let key = hkcu
        .open_subkey_with_flags(&key_path, KEY_READ)
        .map_err(|err| format!("无法读取注册表键：{err}"))?;
    match key.get_value::<String, _>(slot_key) {
        Ok(value) => Ok(value),
        Err(_) => Ok(String::new()),
    }
}

/// 主题目录搬家后，把注册表里仍指向旧根目录的光标路径改到新根目录
///
/// 只改 `from_root` 之下的槽位值，其它路径（系统光标、用户手选）原样保留。
/// 返回改写的槽位数；有改动才刷新系统光标，避免无谓地弹一下鼠标。
pub fn relocate_cursor_paths(from_root: &Path, to_root: &Path) -> Result<usize, String> {
    let current = read_current_slots()?;
    let mut updates: Vec<(String, String)> = Vec::new();
    for (slot_key, raw_path) in &current {
        let Some(relative) = theme_paths::relative_to(Path::new(raw_path), from_root) else {
            continue;
        };
        let next = to_root.join(relative).to_string_lossy().into_owned();
        updates.push((slot_key.clone(), next));
    }
    if updates.is_empty() {
        return Ok(0);
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = cursors_key();
    let key = hkcu
        .open_subkey_with_flags(&key_path, KEY_WRITE)
        .map_err(|err| format!("无法打开注册表键 HKCU\\{key_path}：{err}"))?;
    for (slot_key, next) in &updates {
        key.set_value(slot_key.as_str(), next)
            .map_err(|err| format!("写入 {slot_key} 失败：{err}"))?;
    }
    refresh_cursors()?;
    Ok(updates.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// 隔离键守卫：用例结束删除整棵测试键，并还原线程内的覆盖
    struct IsolatedRegistry {
        path: String,
    }

    impl Drop for IsolatedRegistry {
        fn drop(&mut self) {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let _ = hkcu.delete_subkey_all(&self.path);
            TEST_CURSORS_KEY.with(|slot| *slot.borrow_mut() = None);
        }
    }

    /// 每个用例一个独立键：不碰真实的 `Control Panel\Cursors`，
    /// 也不需要备份/恢复用户的光标设置。
    fn isolate(label: &str) -> IsolatedRegistry {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let path = format!(
            r"Software\CursorStudio.Tests\{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(&path);
        hkcu.create_subkey(&path).expect("建隔离注册表键");
        hkcu
            .create_subkey(format!(r"{path}\Schemes"))
            .expect("建隔离 Schemes 子键");
        TEST_CURSORS_KEY.with(|slot| *slot.borrow_mut() = Some(path.clone()));
        IsolatedRegistry { path }
    }

    fn open_cursors(flags: u32) -> RegKey {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey_with_flags(cursors_key(), flags)
            .expect("打开隔离光标键")
    }

    #[test]
    fn 能读出方案列表且槽位顺序正确() {
        let _guard = isolate("schemes");

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let schemes = hkcu
            .open_subkey_with_flags(schemes_key(), KEY_WRITE)
            .expect("打开隔离 Schemes 键");
        schemes
            .set_value("Beta", &r"C:\themes\beta.cur".to_string())
            .expect("写 Beta");
        schemes
            .set_value(
                "Alpha",
                &r"%SystemRoot%\cursors\arrow.cur,,C:\themes\work.ani".to_string(),
            )
            .expect("写 Alpha");

        let themes = read_system_schemes().expect("读取方案列表不应失败");
        assert_eq!(themes.len(), 2);
        assert_eq!(themes[0].name, "Alpha", "应按名称排序");
        assert!(themes[0].is_built_in);
        assert_eq!(themes[0].id, "sys_Alpha");
        assert_eq!(themes[0].cursors.len(), 2, "空槽位应被跳过");
        assert_eq!(themes[0].cursors[0].registry_key, "Arrow");
        assert_eq!(
            themes[0].cursors[1].registry_key,
            "AppStarting",
            "空槽位不能让它后面的槽位串位"
        );
        assert!(!themes[0].cursors[0].file_path.starts_with('%'), "环境变量应展开");
    }

    #[test]
    fn 空槽位应被跳过且不串位() {
        let theme = parse_scheme("demo", r"C:\a\arrow.ani,,C:\a\work.ani");
        assert_eq!(theme.cursors.len(), 2);
        assert_eq!(theme.cursors[0].registry_key, "Arrow");
        assert_eq!(theme.cursors[1].registry_key, "AppStarting");
        assert_eq!(theme.cursors[1].file_type, "ani");
    }

    #[test]
    fn 环境变量应被展开() {
        let expanded = expand_env(r"%SystemRoot%\cursors\arrow.cur");
        assert!(!expanded.starts_with('%'));
        assert!(expanded.ends_with(r"\cursors\arrow.cur"));
    }

    #[test]
    fn 能读出当前生效的光标槽位() {
        let _guard = isolate("current");

        let key = open_cursors(KEY_WRITE);
        key.set_value("Arrow", &r"%SystemRoot%\cursors\arrow.cur".to_string())
            .expect("写 Arrow");
        key.set_value("Wait", &r"C:\themes\wait.ani".to_string())
            .expect("写 Wait");
        key.set_value("Hand", &String::new()).expect("写空槽位");
        key.set_value("NotASlot", &r"C:\themes\bogus.cur".to_string())
            .expect("写未知槽位");
        key.set_value("SchemeName", &"演示".to_string()).expect("写方案名");

        let slots = read_current_slots().expect("读取当前光标不应失败");
        assert_eq!(slots.len(), 2, "空值与未知槽位都应被跳过");
        assert!(slots.iter().any(|(key, path)| {
            key == "Arrow" && path.ends_with(r"\cursors\arrow.cur") && !path.starts_with('%')
        }));
        assert!(slots.iter().any(|(key, path)| key == "Wait" && path.ends_with("wait.ani")));
        assert_eq!(read_scheme_name(), "演示");
    }

    #[test]
    fn 应用主题会写入全部槽位并清空空位() {
        let _guard = isolate("write");

        let slots = vec![CursorSlot {
            registry_key: "Arrow".to_string(),
            display_name: "正常选择".to_string(),
            english_name: "Normal Select".to_string(),
            file_path: r"C:\Windows\Cursors\荧1.0\arrow.ani".to_string(),
            file_type: "ani".to_string(),
        }];
        write_cursors(&slots, "测试方案").expect("写入应成功");

        assert_eq!(
            read_slot_value("Arrow").unwrap(),
            r"C:\Windows\Cursors\荧1.0\arrow.ani"
        );
        assert_eq!(
            read_slot_value("Hand").unwrap(),
            "",
            "主题未提供的槽位应被清空（回落到系统默认）"
        );
        assert_eq!(read_slot_value("SchemeName").unwrap(), "测试方案");
        assert_eq!(read_slot_value("").unwrap(), "测试方案");
    }

    #[test]
    fn 恢复默认会清空槽位() {
        let _guard = isolate("clear");

        let key = open_cursors(KEY_WRITE);
        key.set_value("Arrow", &r"C:\themes\arrow.cur".to_string())
            .expect("写 Arrow");

        clear_cursors().expect("清空应成功");
        for (slot_key, _, _) in SLOT_DEFS.iter() {
            assert_eq!(read_slot_value(slot_key).unwrap(), "", "{slot_key} 应为空");
        }
        assert_eq!(read_slot_value("SchemeName").unwrap(), "");
    }

    #[test]
    fn 隔离模式下刷新不触碰系统() {
        let _guard = isolate("refresh");
        refresh_cursors().expect("隔离模式应直接返回成功");
    }

    #[test]
    fn 重绑只改旧根目录下的槽位() {
        let _guard = isolate("relocate");

        let key = open_cursors(KEY_WRITE);
        key.set_value(
            "Arrow",
            &r"C:\old\themes\8f0f0f0f-0000-4000-8000-000000000000\arrow.cur".to_string(),
        )
        .expect("写旧路径");
        key.set_value("Hand", &r"C:\Windows\Cursors\hand.cur".to_string())
            .expect("写系统路径");

        let changed = relocate_cursor_paths(Path::new(r"C:\old"), Path::new(r"C:\new"))
            .expect("重绑应成功");
        assert_eq!(changed, 1, "只应改旧根目录下的那一个槽位");
        let relocated = read_slot_value("Arrow").unwrap();
        assert!(
            relocated.starts_with(r"C:\new\themes") && relocated.ends_with("arrow.cur"),
            "旧根目录前缀应被替换，实际：{relocated}"
        );
        assert_eq!(
            read_slot_value("Hand").unwrap(),
            r"C:\Windows\Cursors\hand.cur",
            "系统光标路径不应被改动"
        );
    }
}
