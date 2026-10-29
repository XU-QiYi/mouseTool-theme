//! `.theme`（Windows 桌面主题方案）文件解析（决策 36）
//!
//! `.theme` 是 INI 文本，光标方案在 `[Control Panel\Cursors]` 段：键名与
//! `HKCU\Control Panel\Cursors` 的槽位值名同名（Arrow / Wait / NWPen…），
//! 值是光标文件路径——`%SystemRoot%` 这类环境变量展开的绝对路径，或主题包
//! 内相对路径（`.themepack` 解开的目录）；空值 = 该槽位保持系统默认。
//! 解析只认 15 个槽位键与 `[Theme]` 的 `DisplayName`，壁纸 / 声音 / 图标等
//! 其余段不是本工具的业务，一律忽略。
//!
//! 编码与 `.inf` 同一套 BOM 识别（UTF-16LE/BE、UTF-8，无 BOM 按宽松 UTF-8）。

use crate::utils::inf_parse;
use crate::utils::registry::SLOT_DEFS;

/// 方案文件解析结果
pub struct SchemeFile {
    /// 槽位 → 原始值（已去引号与 `,index` 后缀；环境变量未展开）。
    /// 空值槽位（系统默认）不出现；保留文件中的出现顺序。
    pub slots: Vec<(&'static str, String)>,
    /// `[Theme]` 段的 `DisplayName`；缺省或本地化引用（`@dll,-id`）时为 None，
    /// 调用方退回文件名 stem。
    pub display_name: Option<String>,
}

/// 解析 `.theme` 文件字节，提取光标方案与主题名
///
/// 不做文件系统访问：路径解析与存在性检查属于导入流程（`importer`），
/// 这里保持纯函数以便用构造字节直接测试。
pub fn parse_theme_file(bytes: &[u8]) -> SchemeFile {
    let text = inf_parse::decode_text(bytes);
    let mut slots: Vec<(&'static str, String)> = Vec::new();
    let mut display_name: Option<String> = None;
    // None = 还没进任何段；INI 键只属于最近一次声明的段
    let mut section: Option<String> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with(';') {
            continue;
        }
        if let Some(name) = section_header(trimmed) {
            section = Some(name);
            continue;
        }
        let Some((key, value)) = split_entry(trimmed) else {
            continue;
        };
        match section.as_deref() {
            Some("control panel\\cursors") => {
                if let Some(slot) = slot_key_of(key) {
                    let cleaned = clean_value(value);
                    if !cleaned.is_empty() {
                        slots.push((slot, cleaned));
                    }
                }
            }
            Some("theme") if key.eq_ignore_ascii_case("DisplayName") => {
                let cleaned = clean_value(value);
                // @dll,-id 是给系统查本地化字符串的引用，读不出真名字
                if !cleaned.is_empty() && !cleaned.starts_with('@') {
                    display_name = Some(cleaned);
                }
            }
            _ => {}
        }
    }

    SchemeFile {
        slots,
        display_name,
    }
}

/// 识别段头 `[Name]`，返回小写的段名（反斜杠原样保留）
fn section_header(line: &str) -> Option<String> {
    let inner = line.strip_prefix('[')?.strip_suffix(']')?;
    Some(inner.trim().to_ascii_lowercase())
}

/// 拆 `Key=Value`（只按第一个 `=`，路径里可能还有等号的机会极小、按规范不该有）
fn split_entry(line: &str) -> Option<(&str, &str)> {
    let (key, value) = line.split_once('=')?;
    Some((key.trim(), value.trim()))
}

/// 槽位键 → 规范键名（大小写不敏感；`.theme` 键与注册表值名同名）
fn slot_key_of(key: &str) -> Option<&'static str> {
    SLOT_DEFS
        .iter()
        .find(|(name, _, _)| name.eq_ignore_ascii_case(key))
        .map(|(name, _, _)| *name)
}

/// 清理条目值：去成对引号、去尾部 `,index` 后缀（注册表默认值格式防御性兼容）
fn clean_value(value: &str) -> String {
    let mut out = value.trim().to_string();
    if out.len() >= 2 && out.starts_with('"') && out.ends_with('"') {
        out = out[1..out.len() - 1].trim().to_string();
    }
    // `@file,index` 与 `path,index` 只出现在注册表方案串里，但手工编辑的
    // .theme 可能照抄；有逗号且尾段是纯数字就剥掉，否则当路径的一部分
    if let Some((head, tail)) = out.rsplit_once(',') {
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            out = head.to_string();
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    const SPORTS: &str = "[Theme]\r\nDisplayName=Sports\r\n\
        [Control Panel\\Cursors]\r\n\
        Arrow=%SystemRoot%\\sports_arrow.cur\r\n\
        Wait=%SystemRoot%\\sports_busy.ani\r\n\
        NWPen=\r\n\
        DefaultValue=Sports scheme\r\n\
        Link=\r\n";

    #[test]
    fn 能解析光标段并忽略无关键() {
        let parsed = parse_theme_file(SPORTS.as_bytes());
        assert_eq!(
            parsed.slots,
            vec![
                ("Arrow", "%SystemRoot%\\sports_arrow.cur".to_string()),
                ("Wait", "%SystemRoot%\\sports_busy.ani".to_string()),
            ]
        );
        assert_eq!(parsed.display_name.as_deref(), Some("Sports"));
    }

    #[test]
    fn utf16le_与_ansi_都能解析() {
        let from_utf16 = parse_theme_file(&utf16le(SPORTS));
        let from_ansi = parse_theme_file(SPORTS.as_bytes());
        assert_eq!(from_utf16.slots.len(), 2);
        assert_eq!(from_ansi.slots.len(), 2);
        assert_eq!(from_utf16.display_name, from_ansi.display_name);
    }

    #[test]
    fn 键名大小写不敏感且映射到规范名() {
        let text = "[Control Panel\\Cursors]\r\narrow=a.cur\r\nWAIT=b.ani\r\n";
        let parsed = parse_theme_file(text.as_bytes());
        assert_eq!(
            parsed.slots,
            vec![("Arrow", "a.cur".to_string()), ("Wait", "b.ani".to_string())]
        );
    }

    #[test]
    fn 未知槽位与未知段一律忽略() {
        let text = "[Control Panel\\Cursors]\r\nPerson=x.cur\r\nHand=h.cur\r\n\
            [Control Panel\\Desktop]\r\nWallpaper=bg.jpg\r\n";
        let parsed = parse_theme_file(text.as_bytes());
        assert_eq!(parsed.slots, vec![("Hand", "h.cur".to_string())]);
        assert_eq!(parsed.display_name, None);
    }

    #[test]
    fn 空值槽位不出现且不会留下上一段的键() {
        let text = "[Theme]\r\nDisplayName=\r\n[Control Panel\\Cursors]\r\nArrow=\r\n";
        let parsed = parse_theme_file(text.as_bytes());
        assert!(parsed.slots.is_empty());
        assert_eq!(parsed.display_name, None);
    }

    #[test]
    fn 本地化的显示名退回文件名() {
        let text = "[Theme]\r\nDisplayName=@themeui.dll,-2013\r\n";
        let parsed = parse_theme_file(text.as_bytes());
        assert_eq!(parsed.display_name, None);
    }

    #[test]
    fn 去引号与逗号后缀() {
        let text = "[Control Panel\\Cursors]\r\nArrow=\"my arrow.cur\"\r\nWait=busy.ani,0\r\n";
        let parsed = parse_theme_file(text.as_bytes());
        assert_eq!(
            parsed.slots,
            vec![("Arrow", "my arrow.cur".to_string()), ("Wait", "busy.ani".to_string())]
        );
    }

    #[test]
    fn 分号整行注释被跳过() {
        let text = "; a comment\r\n[Control Panel\\Cursors]\r\n; another\r\nArrow=a.cur\r\n";
        let parsed = parse_theme_file(text.as_bytes());
        assert_eq!(parsed.slots, vec![("Arrow", "a.cur".to_string())]);
    }
}
