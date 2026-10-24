//! 解析光标主题包里的 `.inf` 安装说明（决策 15）
//!
//! 与 [`crate::utils::inf_export`]（生成）成对：导入时若包里带了 `.inf`，
//! 槽位映射以它为准（优先级高于文件名推断）；没带、或解析不出任何映射时
//! 整体退回文件名推断，不报错、不因此缺槽位。
//!
//! 认三种写法（需求文档 §9 遗留问题的答案：都认）：
//! 1. `[Control Panel\Cursors]` 段的 `槽位=文件` 行（社区老式写法）；
//! 2. 任意段里的 AddReg 行 `HKCU,"Control Panel\Cursors",槽位,标志,路径`
//!    ——本工具导出的 `[Scheme.Reg]` 与大多数安装器都是这种，段名不限定；
//! 3. AddReg 方案串行 `HKCU,"Control Panel\Cursors\Schemes",名,,"15 段逗号分隔"`
//!    ——按 [`SLOT_DEFS`] 位序取，缺失段留空（决策 3 的读法口径）。
//!
//! 编码：BOM 识别 UTF-16LE/BE 与 UTF-8；无 BOM 按宽松 UTF-8 解码。GBK 无
//! BOM 的文件槽位键名仍是 ASCII、照常解析，只有中文文件名会乱码、对不上
//! 包内文件后按槽位退回文件名推断——不为它引入编码库依赖。
//!
//! 值里的 `%10%` / `%SystemRoot%` / `%CUR_DIR%` 一律不展开：那是「安装后」的
//! 目标路径，与包内布局无关，取最后一段文件名到包里对号即可。

use crate::utils::registry::SLOT_DEFS;

/// 解析 `.inf` 字节，返回 `(槽位键名, 包内文件名)`
///
/// 同一槽位先出现的映射生效；解析不出任何映射时返回空，由调用方退回文件名推断。
pub fn parse_inf(bytes: &[u8]) -> Vec<(&'static str, String)> {
    parse_text(&decode_text(bytes))
}

/// 按优先级合并三种来源：段内直写 > 逐槽位 AddReg > 方案串按位
fn parse_text(text: &str) -> Vec<(&'static str, String)> {
    let mut direct: Vec<(&'static str, String)> = Vec::new();
    let mut addreg: Vec<(&'static str, String)> = Vec::new();
    let mut schemes: Vec<(&'static str, String)> = Vec::new();

    let mut section = String::new();
    for raw in text.lines() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            continue;
        }

        // 写法 ①：`[Control Panel\Cursors]` 段的 `槽位=文件`
        if is_cursors_subkey(&section) {
            if let Some((key, value)) = line.split_once('=') {
                if let Some(slot) = slot_key_of(key) {
                    let file = base_file_name(&unquote(value.trim()));
                    push_once(&mut direct, slot, file);
                }
            }
        }

        // 写法 ②③：任意段里的 AddReg 行（只认 HKCU，与本工具导出口径一致）
        if let Some(fields) = addreg_fields(line) {
            if fields.len() < 3 {
                continue;
            }
            match normalize_subkey(&fields[1]).as_str() {
                "control panel\\cursors" => {
                    if let Some(slot) = slot_key_of(&fields[2]) {
                        if let Some(data) = data_field(&fields) {
                            let file = base_file_name(&data);
                            push_once(&mut addreg, slot, file);
                        }
                    }
                }
                "control panel\\cursors\\schemes" => {
                    if let Some(data) = data_field(&fields) {
                        for (index, entry) in data.split(',').enumerate() {
                            let Some(&(slot, _, _)) = SLOT_DEFS.get(index) else {
                                break;
                            };
                            let file = base_file_name(entry.trim());
                            push_once(&mut schemes, slot, file);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    let mut mapped = direct;
    for (slot, file) in addreg {
        push_once(&mut mapped, slot, file);
    }
    for (slot, file) in schemes {
        push_once(&mut mapped, slot, file);
    }
    mapped
}

/// BOM 识别 UTF-16LE / UTF-16BE / UTF-8；无 BOM 按宽松 UTF-8（GBK 中文会变
/// 替换符，但槽位键名是 ASCII，解析不受影响）
fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16_to_string(
            bytes[2..].chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])),
        );
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16_to_string(
            bytes[2..].chunks_exact(2).map(|p| u16::from_be_bytes([p[0], p[1]])),
        );
    }
    let rest = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF][..])
        .unwrap_or(bytes);
    String::from_utf8_lossy(rest).into_owned()
}

fn utf16_to_string(units: impl Iterator<Item = u16>) -> String {
    char::decode_utf16(units)
        .map(|result| result.unwrap_or('\u{FFFD}'))
        .collect()
}

/// 截掉行内注释：`;` 只在引号外才算注释符
fn strip_comment(line: &str) -> &str {
    let mut in_quotes = false;
    for (index, c) in line.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ';' if !in_quotes => return &line[..index],
            _ => {}
        }
    }
    line
}

/// AddReg 行识别：`HKCU,` 开头（大小写不敏感），按引号感知的逗号切字段
fn addreg_fields(line: &str) -> Option<Vec<String>> {
    let comma = line.find(',')?;
    if !line[..comma].trim().eq_ignore_ascii_case("HKCU") {
        return None;
    }
    Some(split_fields(line))
}

/// 引号感知的逗号切分：引号内的逗号是数据的一部分（方案串就有 14 个），
/// 引号内双写 `""` 是转义的引号
fn split_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(c);
            }
        } else {
            match c {
                '"' => in_quotes = true,
                ',' => {
                    fields.push(current.trim().to_string());
                    current = String::new();
                }
                _ => current.push(c),
            }
        }
    }
    fields.push(current.trim().to_string());
    fields
}

/// AddReg 数据段：标准是第 5 段（root, subkey, 名, flags, data）；
/// 只有 4 段且第 4 段不像 flags 时，第 4 段就是数据
fn data_field(fields: &[String]) -> Option<String> {
    match fields.len() {
        0..=3 => None,
        4 => {
            let value = &fields[3];
            if value.is_empty() || looks_like_flags(value) {
                None
            } else {
                Some(unquote(value))
            }
        }
        // 数据自身含逗号且没加引号时会被切碎，并回去（方案串加了引号，走不到这）
        _ => Some(fields[4..].join(",")),
    }
}

fn looks_like_flags(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("0x") || lower.chars().all(|c| c.is_ascii_hexdigit())
}

/// 去掉一层成对的首尾引号（引号不是值的一部分，`""` 是转义的引号）
fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].replace("\"\"", "\"")
    } else {
        trimmed.to_string()
    }
}

/// 注册表键名归一：大小写、正反斜杠不敏感（Windows 注册表口径）
fn normalize_subkey(name: &str) -> String {
    name.trim().replace('/', "\\").to_lowercase()
}

fn is_cursors_subkey(name: &str) -> bool {
    normalize_subkey(name) == "control panel\\cursors"
}

/// 注册表键名 → 槽位（大小写不敏感）；不是槽位的键（如 SchemeName）返回 None
fn slot_key_of(name: &str) -> Option<&'static str> {
    SLOT_DEFS
        .iter()
        .find(|(key, _, _)| key.eq_ignore_ascii_case(name.trim()))
        .map(|(key, _, _)| *key)
}

/// 从值里取包内文件名：`%10%\%CUR_DIR%\arrow.cur` → `arrow.cur`
fn base_file_name(value: &str) -> String {
    value
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 同一槽位先出现的映射生效；空文件名（方案串的缺失段）不收
fn push_once(mapped: &mut Vec<(&'static str, String)>, slot: &'static str, file: String) {
    if file.is_empty() {
        return;
    }
    if !mapped.iter().any(|(s, _)| *s == slot) {
        mapped.push((slot, file));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::inf_export::build_inf;

    #[test]
    fn 能解析自家导出的_inf() {
        let bytes = build_inf(
            "演示方案",
            &[("Arrow".to_string(), "cur".to_string()), ("Hand".to_string(), "ani".to_string())],
        );
        let mapped = parse_inf(&bytes);

        assert_eq!(mapped.len(), 2, "SchemeName 不是槽位，方案串与逐槽位行去重后只剩两个");
        assert!(mapped.contains(&("Arrow", "arrow.cur".to_string())));
        assert!(mapped.contains(&("Hand", "hand.ani".to_string())));
    }

    #[test]
    fn 能解析直写段并忽略注释与无关键() {
        let text = concat!(
            "[Version]\r\n",
            "signature=\"$CHICAGO$\" ; 标准签名\r\n",
            "[Control Panel\\Cursors]\r\n",
            "Arrow = \"%10%\\%CUR_DIR%\\my arrow.cur\" ; 主箭头\r\n",
            "wait=busy.ani\r\n",
            "SchemeName=不是槽位\r\n",
        );
        let mapped = parse_text(text);

        assert_eq!(mapped.len(), 2);
        assert!(mapped.contains(&("Arrow", "my arrow.cur".to_string())));
        assert!(mapped.contains(&("Wait", "busy.ani".to_string())));
    }

    #[test]
    fn 方案串按位对应且缺失段不收() {
        let mut entries = vec![String::new(); 15];
        entries[1] = "%10%\\Cursors\\T\\help.cur".to_string();
        entries[14] = "hand.ani".to_string();
        let text = format!(
            "[Scheme.Reg]\r\nHKCU,\"Control Panel\\Cursors\\Schemes\",\"演示\",,\"{}\"\r\n",
            entries.join(",")
        );
        let mapped = parse_text(&text);

        assert_eq!(mapped.len(), 2);
        assert!(mapped.contains(&("Help", "help.cur".to_string())));
        assert!(mapped.contains(&("Hand", "hand.ani".to_string())));
        assert!(!mapped.iter().any(|(slot, _)| *slot == "Arrow"), "空段不映射");
    }

    #[test]
    fn 大小写与正斜杠不敏感() {
        let text = "hkcu,control panel/cursors,ARROW,0x00020000,a.cur\r\n";
        let mapped = parse_text(text);

        assert_eq!(mapped, vec![("Arrow", "a.cur".to_string())]);
    }

    #[test]
    fn 四段行不带_flags_时第四段是数据() {
        let text = "HKCU,\"Control Panel\\Cursors\",Wait,,ghost.ani\r\n";
        assert!(parse_text(text).contains(&("Wait", "ghost.ani".to_string())));

        let flags_only = "HKCU,\"Control Panel\\Cursors\",Wait,0x00020000\r\n";
        assert!(parse_text(flags_only).is_empty(), "只有 flags 没有数据就不映射");
    }

    #[test]
    fn 同一槽位先出现的生效() {
        let text = concat!(
            "[Control Panel\\Cursors]\r\n",
            "Arrow=first.cur\r\n",
            "Arrow=second.cur\r\n",
        );
        let mapped = parse_text(text);

        assert_eq!(mapped, vec![("Arrow", "first.cur".to_string())]);
    }

    #[test]
    fn 非法字节不崩且_ascii_键仍可解析() {
        // 模拟 GBK 无 BOM：文件名是 GBK 中文（非法 UTF-8），键名是 ASCII
        let bytes = b"HKCU,\"Control Panel\\Cursors\",Arrow,,\xc4\xe3.cur\r\n";
        let mapped = parse_inf(bytes);

        assert_eq!(mapped.len(), 1, "AddReg 行不依赖段名，乱码值照样映射");
        assert_eq!(mapped[0].0, "Arrow");
        assert!(mapped[0].1.ends_with(".cur"), "乱码只影响文件名主体，实际：{}", mapped[0].1);
    }

    #[test]
    fn 空输入返回空映射() {
        assert!(parse_inf(b"").is_empty());
        assert!(parse_inf(b"\r\n;\xe5\x8f\xaa\xe6\x9c\x89\xe6\xb3\xa8\xe9\x87\x8a\r\n").is_empty());
    }
}
