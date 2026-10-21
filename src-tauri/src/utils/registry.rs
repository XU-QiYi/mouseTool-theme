use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::{RegKey, RegValue};

use crate::models::{CursorSlot, CursorTheme};

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
const SCHEMES_KEY: &str = r"Control Panel\Cursors\Schemes";

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
    let key = hkcu
        .open_subkey_with_flags(SCHEMES_KEY, KEY_READ)
        .map_err(|err| format!("无法打开注册表键 HKCU\\{SCHEMES_KEY}：{err}"))?;

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
    let key = hkcu
        .open_subkey_with_flags(CURSORS_KEY, KEY_WRITE)
        .map_err(|err| format!("无法打开注册表键 HKCU\\{CURSORS_KEY}：{err}"))?;

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
    let key = hkcu
        .open_subkey_with_flags(CURSORS_KEY, KEY_WRITE)
        .map_err(|err| format!("无法打开注册表键 HKCU\\{CURSORS_KEY}：{err}"))?;

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
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPIF_SENDCHANGE, SPI_SETCURSORS,
    };

    unsafe {
        SystemParametersInfoW(SPI_SETCURSORS, 0, None, SPIF_SENDCHANGE)
            .map_err(|err| format!("刷新系统光标失败：{err}"))
    }
}

/// 读取指定槽位的当前值，测试与备份用
pub fn read_slot_value(slot_key: &str) -> Result<String, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(CURSORS_KEY, KEY_READ)
        .map_err(|err| format!("无法读取注册表键：{err}"))?;
    match key.get_value::<String, _>(slot_key) {
        Ok(value) => Ok(value),
        Err(_) => Ok(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 能读出系统方案且槽位顺序正确() {
        let themes = read_system_schemes().expect("读取系统方案不应失败");
        println!("共 {} 个方案", themes.len());

        for theme in &themes {
            println!("[{}] {} 个槽位", theme.name, theme.cursors.len());
            for slot in &theme.cursors {
                println!("  {:<12} {}", slot.registry_key, slot.file_path);
            }
        }

        let first = themes.first().expect("本机应至少有一个光标方案");
        assert!(first.is_built_in);
        assert!(first.id.starts_with("sys_"));
        assert!(!first.cursors.is_empty());
        assert!(!first.cursors[0].file_path.is_empty());
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

    /// 备份当前光标注册表设置，测试结束后原样还原
    struct Backup {
        slots: Vec<(String, String)>,
        scheme_name: String,
        default_value: String,
    }

    /// 碰注册表的测试必须串行，否则互相踩踏
    static REGISTRY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    impl Backup {
        fn capture() -> Self {
            Self {
                slots: SLOT_DEFS
                    .iter()
                    .map(|(key, _, _)| (key.to_string(), read_slot_value(key).unwrap_or_default()))
                    .collect(),
                scheme_name: read_slot_value("SchemeName").unwrap_or_default(),
                default_value: read_slot_value("").unwrap_or_default(),
            }
        }

        fn restore(&self) {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            let Ok(key) = hkcu.open_subkey_with_flags(CURSORS_KEY, KEY_WRITE) else {
                return;
            };
            for (name, value) in &self.slots {
                let _ = key.set_value(name.as_str(), value);
            }
            let _ = key.set_value("SchemeName", &self.scheme_name);
            let _ = key.set_value("", &self.default_value);
        }
    }

    #[test]
    fn 应用主题会改写注册表且能原样恢复() {
        let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let backup = Backup::capture();

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
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
        }));

        // 断言失败也要还原用户原本的光标设置
        backup.restore();
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }

        assert_eq!(
            read_slot_value("Arrow").unwrap_or_default(),
            backup.slots[0].1,
            "恢复后应与备份一致"
        );
    }

    #[test]
    fn 恢复默认会清空槽位() {
        let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let backup = Backup::capture();

        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            clear_cursors().expect("清空应成功");
            for (key, _, _) in SLOT_DEFS.iter() {
                assert_eq!(read_slot_value(key).unwrap(), "", "{key} 应为空");
            }
        }));

        backup.restore();
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }

    #[test]
    fn 刷新光标可调用() {
        let _guard = REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        refresh_cursors().expect("刷新光标不应失败");
    }
}
