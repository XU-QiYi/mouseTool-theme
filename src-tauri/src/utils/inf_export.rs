//! 生成 Windows 原生的光标方案安装文件（`.inf`）
//!
//! 接收方没装本软件也能用：解压导出的 zip 后，右键 `.inf` →「安装」，
//! Windows 会把光标复制到 `%SystemRoot%\Cursors\<方案名>\`，并把方案写进
//! `HKCU\Control Panel\Cursors\Schemes`（控制面板「鼠标 → 指针」的方案下拉）。
//! 这是 Win98 起的系统原生通道，也是社区光标包几十年来的通用格式（决策 13）。
//!
//! 两个编码层面的硬要求：
//! - **UTF-16LE + BOM**：ANSI 会把中文方案名在非中文系统的机器上写成乱码；
//! - **CRLF**：Windows 安装器按行解析。
//!
//! 导入端不解析 `.inf`（未实现清单），本模块只服务导出。

use crate::utils::registry::SLOT_DEFS;

/// 清洗后的方案名长度上限：保护 `C:\Windows\Cursors\<名>\<槽位>.cur` 的路径长度
const NAME_LIMIT: usize = 60;

/// 清洗方案名，使它能同时充当 zip 内文件名、安装目标目录名与 INF 字符串
///
/// - Windows 文件名非法字符与控制字符 → `_`；
/// - `%` 与 `;` 也一并替换：前者是 INF 的变量转义符，后者是注释符，
///   出现在方案名里会破坏 AddReg 行；
/// - 结尾的 `.` 和空格去掉（Windows 目录名不允许）；
/// - 清洗后为空时回退「鼠标主题方案」；撞上保留设备名（CON/NUL 等）加前缀。
pub fn sanitize_scheme_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_was_space = false;
    for ch in raw.trim().chars() {
        if matches!(
            ch,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '%' | ';'
        ) || ch.is_control()
        {
            out.push('_');
            last_was_space = false;
        } else if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }

    let mut name = out.trim().trim_end_matches(['.', ' ']).to_string();
    if name.chars().count() > NAME_LIMIT {
        name = name.chars().take(NAME_LIMIT).collect();
        name = name
            .trim_end()
            .trim_end_matches(['.', ' '])
            .to_string();
    }

    if name.is_empty() {
        return "鼠标主题方案".to_string();
    }

    // CON / NUL 这类保留设备名带任意扩展名都不能当目录名
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&name)) {
        name.insert(0, '_');
    }

    name
}

/// 生成 `.inf` 全文，编码为 UTF-16LE + BOM 字节
///
/// `files` 是 `(槽位键名, 扩展名)`，必须只含 `.cur`/`.ani`（`.ico` 无法被
/// Windows 当作光标加载，写进方案串会让安装出的方案该槽位失效）；
/// 顺序随意，内部按 [`SLOT_DEFS`] 的位序整理。
pub fn build_inf(scheme_name: &str, files: &[(String, String)]) -> Vec<u8> {
    let name = sanitize_scheme_name(scheme_name);

    // 只保留已知槽位并按 SLOT_DEFS 顺序排，未知键名直接丢弃
    let mut present: Vec<(&str, &str)> = Vec::new();
    for (key, _, _) in SLOT_DEFS.iter() {
        if let Some((_, ext)) = files.iter().find(|(k, _)| k == key) {
            present.push((key, ext.as_str()));
        }
    }

    let packaged = |key: &str, ext: &str| format!("{}.{}", key.to_lowercase(), ext);
    let installed =
        |key: &str, ext: &str| format!("%10%\\%CUR_DIR%\\{}", packaged(key, ext));

    let mut lines: Vec<String> = Vec::new();

    // —— 头部注释：给接收方看的安装说明与槽位对照表 ——
    push_comment(&mut lines, "================================================================");
    push_comment(&mut lines, &format!("光标方案「{name}」 - 安装文件"));
    push_comment(&mut lines, "由「鼠标主题工具」导出，无需安装任何软件即可使用。");
    push_comment(&mut lines, "");
    push_comment(&mut lines, "使用方法：");
    push_comment(&mut lines, "  1. 把压缩包里的所有文件解压到同一个文件夹；");
    push_comment(
        &mut lines,
        "  2. 右键本 .inf 文件 → 「安装」（Windows 11 若看不到，先点「显示更多选项」）；",
    );
    push_comment(&mut lines, "     安装时系统可能弹出管理员确认，选「是」即可；");
    push_comment(
        &mut lines,
        "  3. 安装完成后会自动打开「鼠标属性 → 指针」窗口，此时新方案已就位，",
    );
    push_comment(&mut lines, "     点「确定」即可生效。");
    push_comment(
        &mut lines,
        "     若窗口没有弹出：打开 控制面板 → 鼠标 → 指针，在「方案」下拉里",
    );
    push_comment(
        &mut lines,
        "     选择本方案 → 应用；或注销后重新登录（登录时会自动生效）。",
    );
    push_comment(&mut lines, "");
    push_comment(
        &mut lines,
        "安装做两件事：把光标文件复制到 %SystemRoot%\\Cursors\\<方案名>\\，",
    );
    push_comment(&mut lines, "并把方案写入当前用户的注册表（不影响电脑上的其它用户）。");
    push_comment(&mut lines, "");
    push_comment(&mut lines, "本方案包含的槽位（「未提供」的槽位将沿用系统默认光标）：");
    for (key, cn, _) in SLOT_DEFS.iter() {
        match present.iter().find(|(k, _)| *k == *key) {
            Some((_, ext)) => push_comment(&mut lines, &format!("  - {cn} ({key})：{}", packaged(key, ext))),
            None => push_comment(&mut lines, &format!("  - {cn} ({key})：未提供")),
        }
    }
    push_comment(&mut lines, "================================================================");

    lines.push(String::new());
    lines.push("[Version]".to_string());
    lines.push("signature=\"$CHICAGO$\"".to_string());
    lines.push(String::new());
    lines.push("[DefaultInstall]".to_string());
    lines.push("CopyFiles = Scheme.Copies".to_string());
    lines.push("AddReg = Scheme.Reg".to_string());
    // 装完自动弹出「鼠标属性 → 指针」：逐槽位值此时已写入注册表，弹出的窗口
    // 里新方案就是当前值，用户点「确定」即触发 SPI_SETCURSORS 立即生效。
    // 没有这一步的话，安装只注册方案，光标要等注销重新登录才变。
    // RunPreSetupCommands / RunPostSetupCommands 是微软文档记载的
    // DefaultInstall 官方指令，右键「安装」会执行（命令同步执行，对话框
    // 关闭后安装才算完成；命令失败不影响已完成的复制与注册）。
    lines.push("RunPostSetupCommands = Finish.Commands".to_string());
    lines.push(String::new());
    lines.push("[DestinationDirs]".to_string());
    lines.push("Scheme.Copies = 10,\"%CUR_DIR%\"".to_string());
    lines.push(String::new());
    lines.push("[Scheme.Copies]".to_string());
    for (key, ext) in &present {
        lines.push(packaged(key, ext));
    }
    lines.push(String::new());
    lines.push("[Scheme.Reg]".to_string());

    // 方案串：控制面板「方案」下拉里的一项，15 个槽位按位对应，缺失留空段
    let scheme_data: Vec<String> = SLOT_DEFS
        .iter()
        .map(|(key, _, _)| {
            present
                .iter()
                .find(|(k, _)| *k == *key)
                .map(|(k, e)| installed(k, e))
                .unwrap_or_default()
        })
        .collect();
    lines.push(format!(
        "HKCU,\"Control Panel\\Cursors\\Schemes\",\"%SCHEME_NAME%\",,\"{}\"",
        scheme_data.join(",")
    ));

    // 逐槽位值：只写本方案提供的槽位，不动接收方现有的其它光标
    for (key, ext) in &present {
        lines.push(format!(
            "HKCU,\"Control Panel\\Cursors\",{key},,\"{}\"",
            installed(key, ext)
        ));
    }

    // 方案名与 `apply_theme` 的落盘状态对齐（注册表里多一个可读的名字）
    lines.push("HKCU,\"Control Panel\\Cursors\",SchemeName,,\"%SCHEME_NAME%\"".to_string());

    lines.push(String::new());
    lines.push("[Finish.Commands]".to_string());
    lines.push("rundll32.exe shell32.dll,Control_RunDLL main.cpl,,1".to_string());

    lines.push(String::new());
    lines.push("[Strings]".to_string());
    lines.push(format!("CUR_DIR = \"Cursors\\{name}\""));
    lines.push(format!("SCHEME_NAME = \"{name}\""));

    let text = format!("{}\r\n", lines.join("\r\n"));
    encode_utf16le_with_bom(&text)
}

fn push_comment(lines: &mut Vec<String>, text: &str) {
    lines.push(format!("; {text}").trim_end().to_string());
}

/// UTF-16LE + BOM：Windows 安装器识别 Unicode INF 的唯一可靠方式
fn encode_utf16le_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() * 2 + 2);
    bytes.extend_from_slice(&[0xFF, 0xFE]);
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_files() -> Vec<(String, String)> {
        vec![
            ("Arrow".to_string(), "cur".to_string()),
            ("Hand".to_string(), "ani".to_string()),
        ]
    }

    fn decode(bytes: &[u8]) -> String {
        assert_eq!(&bytes[..2], &[0xFF, 0xFE], "必须以 UTF-16LE BOM 开头");
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .collect();
        String::from_utf16(&units).expect("必须是合法 UTF-16")
    }

    #[test]
    fn 清洗方案名() {
        assert_eq!(sanitize_scheme_name("我的主题"), "我的主题");
        assert_eq!(
            sanitize_scheme_name(r#"a<b>:"/\|?*c"#),
            "a_b________c",
            "9 个 Windows 非法文件名字符被替换，合法字符 b 保留"
        );
        assert_eq!(sanitize_scheme_name("进度 50%"), "进度 50_", "% 会破坏 INF 变量转义");
        assert_eq!(sanitize_scheme_name("备注; 注释"), "备注_ 注释", "; 是 INF 注释符");
        assert_eq!(sanitize_scheme_name("结尾点. .."), "结尾点");
        assert_eq!(sanitize_scheme_name("   "), "鼠标主题方案", "全空时要有回退名");
        assert_eq!(sanitize_scheme_name("con"), "_con", "保留设备名要避开");
        assert_eq!(sanitize_scheme_name("多  个  空格"), "多 个 空格");
        assert_eq!(sanitize_scheme_name("a\nb"), "a_b", "控制字符不能进 INF");
        assert!(sanitize_scheme_name(&"字".repeat(80)).chars().count() <= NAME_LIMIT);
    }

    #[test]
    fn inf_包含安装必需的段落与文件() {
        let text = decode(&build_inf("我的主题", &sample_files()));

        assert!(text.contains("[Version]"));
        assert!(text.contains("signature=\"$CHICAGO$\""));
        assert!(text.contains("[DestinationDirs]"));
        assert!(text.contains("Scheme.Copies = 10,\"%CUR_DIR%\""));
        assert!(text.contains("[Scheme.Copies]"));
        assert!(text.contains("\r\narrow.cur\r\n"), "光标文件要进 CopyFiles 清单");
        assert!(text.contains("\r\nhand.ani\r\n"));
        assert!(text.contains("[Scheme.Reg]"));
        assert!(
            text.contains("RunPostSetupCommands = Finish.Commands"),
            "装完要自动弹出指针设置，否则安装后光标不生效"
        );
        assert!(text.contains("[Finish.Commands]"));
        assert!(text.contains("rundll32.exe shell32.dll,Control_RunDLL main.cpl,,1"));
        assert!(
            text.contains("HKCU,\"Control Panel\\Cursors\",SchemeName,,\"%SCHEME_NAME%\""),
            "方案名要与 apply_theme 的落盘状态对齐"
        );
        assert!(
            text.contains("HKCU,\"Control Panel\\Cursors\",Arrow,,\"%10%\\%CUR_DIR%\\arrow.cur\""),
            "提供的槽位要有逐槽位注册行"
        );
        assert!(
            text.contains("HKCU,\"Control Panel\\Cursors\",Hand,,\"%10%\\%CUR_DIR%\\hand.ani\"")
        );
        assert!(
            !text.contains("\"Control Panel\\Cursors\",Wait"),
            "未提供的槽位不该写，避免覆盖接收方现有光标"
        );
        assert!(text.contains("CUR_DIR = \"Cursors\\我的主题\""));
        assert!(text.contains("SCHEME_NAME = \"我的主题\""));
        assert!(text.contains("右键"), "头部注释要写清使用方法");
        assert!(text.contains("点「确定」即可生效"), "注释要说明弹出窗口怎么用");
    }

    #[test]
    fn schemes_串按15槽位按位排且缺失留空段() {
        let text = decode(&build_inf("demo", &sample_files()));
        let line = text
            .lines()
            .find(|l| l.starts_with("HKCU,\"Control Panel\\Cursors\\Schemes\""))
            .expect("方案串必须存在");

        // 取最后一个引号包裹的数据段（数据段自身不含引号）
        let data = line.rsplit('"').nth(1).expect("数据段应被引号包裹");
        let entries: Vec<&str> = data.split(',').collect();
        assert_eq!(entries.len(), 15, "方案串必须按 15 个槽位按位排列");

        assert_eq!(entries[0], "%10%\\%CUR_DIR%\\arrow.cur", "Arrow 在第 1 位");
        assert_eq!(entries[14], "%10%\\%CUR_DIR%\\hand.ani", "Hand 在第 15 位");
        assert_eq!(entries[3], "", "Wait 未提供应留空段");
        assert_eq!(entries[13], "", "UpArrow 未提供应留空段");
    }

    #[test]
    fn 字节层面是_BOM_UTF16LE_CRLF() {
        let bytes = build_inf("测试", &sample_files());
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);

        let text = decode(&bytes);
        assert!(text.ends_with("\r\n"));
        assert!(
            !text.replace("\r\n", "").contains('\n'),
            "不应出现裸 LF，安装器按行解析"
        );
    }

    #[test]
    fn 未知槽位名被丢弃() {
        let files = vec![
            ("Arrow".to_string(), "cur".to_string()),
            ("Bogus".to_string(), "cur".to_string()),
        ];
        let text = decode(&build_inf("x", &files));
        assert!(text.contains("arrow.cur"));
        assert!(!text.contains("bogus.cur"));
    }
}
