//! 归档读取的统一限额与安全解包工具
//!
//! 主题包与备份包共用这一套：条目数、嵌套深度、单文件大小、解压总量，
//! 以及条目名白名单。任何超限都返回可行动的中文错误，由调用方清理临时产物。
//! 读文件一律走分块复制，不把整个条目读进内存。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// 分块复制的大小
const CHUNK: usize = 64 * 1024;

/// 预览图源文件上限：超过这个尺寸不解析，避免一次 IPC 读入超大文件
pub const MAX_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;

/// 单个光标文件上限（导入、导出、应用共用）
pub const MAX_CURSOR_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// 一套归档的限额
#[derive(Debug, Clone, Copy)]
pub struct ArchiveLimits {
    /// 报错时的称呼（主题包 / 备份）
    pub label: &'static str,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_entries: usize,
    pub max_depth: usize,
    /// 条目完整路径长度上限（字符数）
    pub max_name_chars: usize,
}

/// 主题包：50MB 总量、单文件 20MB、512 个条目、目录最多 8 层
pub const THEME_LIMITS: ArchiveLimits = ArchiveLimits {
    label: "主题包",
    max_total_bytes: 50 * 1024 * 1024,
    max_file_bytes: 20 * 1024 * 1024,
    max_entries: 512,
    max_depth: 8,
    max_name_chars: 240,
};

/// 备份包：1GiB 总量、单文件 64MB、4096 个条目、目录最多 10 层
pub const BACKUP_LIMITS: ArchiveLimits = ArchiveLimits {
    label: "备份",
    max_total_bytes: 1024 * 1024 * 1024,
    max_file_bytes: 64 * 1024 * 1024,
    max_entries: 4096,
    max_depth: 10,
    max_name_chars: 240,
};

impl ArchiveLimits {
    pub fn total_hint(&self) -> String {
        format!("{}MB", self.max_total_bytes / 1024 / 1024)
    }

    pub fn file_hint(&self) -> String {
        format!("{}MB", self.max_file_bytes / 1024 / 1024)
    }
}

/// 条目预算：先记条目数，再按实际复制字节记账
pub struct ArchiveBudget<'a> {
    limits: &'a ArchiveLimits,
    entries: usize,
    total: u64,
}

impl<'a> ArchiveBudget<'a> {
    pub fn new(limits: &'a ArchiveLimits) -> Self {
        Self {
            limits,
            entries: 0,
            total: 0,
        }
    }

    /// 进入一个文件条目（目录不计）
    pub fn note_entry(&mut self) -> Result<(), String> {
        self.entries += 1;
        if self.entries > self.limits.max_entries {
            return Err(format!(
                "{}里的文件太多（超过 {} 个），已停止导入",
                self.limits.label, self.limits.max_entries
            ));
        }
        Ok(())
    }

    /// 本条最多允许写入的字节数：单文件上限与剩余总量的较小值
    pub fn allowance(&self) -> u64 {
        self.limits
            .max_file_bytes
            .min(self.limits.max_total_bytes.saturating_sub(self.total))
    }

    /// 复制完成后记账；超出总量时返回错误（调用方负责清理）
    pub fn commit(&mut self, bytes: u64) -> Result<(), String> {
        self.total = self.total.saturating_add(bytes);
        if self.total > self.limits.max_total_bytes {
            return Err(format!(
                "{}解压后超过 {} 上限，已停止导入",
                self.limits.label,
                self.limits.total_hint()
            ));
        }
        Ok(())
    }

    pub fn total(&self) -> u64 {
        self.total
    }
}

/// 分块复制，最多写 `cap` 字节；超出立即失败（不把剩余内容读进内存）
pub fn copy_bounded<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cap: u64,
    limits: &ArchiveLimits,
) -> Result<u64, String> {
    let mut written = 0u64;
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("读取内容失败（{err}）"))?;
        if read == 0 {
            break;
        }
        written += read as u64;
        if written > cap {
            return Err(format!(
                "{}里有文件解压后超过上限（单文件 {}、总计 {}），已停止导入",
                limits.label,
                limits.file_hint(),
                limits.total_hint()
            ));
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|err| format!("写入文件失败（{err}）"))?;
    }
    Ok(written)
}

/// 读取最多 `max` 字节的文本（用于 `.inf` / `theme.json` / `history.json`）
pub fn read_text_bounded(path: &Path, max: u64) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|err| format!("读不到文件信息（{err}）"))?;
    if meta.len() > max {
        return Err(format!("文件过大（{} 字节，上限 {max}）", meta.len()));
    }
    let bytes = fs::read(path).map_err(|err| format!("读取文件失败（{err}）"))?;
    String::from_utf8(bytes).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())
}

/// 校验归档条目名并拆成安全段列表
///
/// - `Ok(Some(parts))`：可写；
/// - `Ok(None)`：系统垃圾/隐藏条目，静默跳过；
/// - `Err`：路径穿越、盘符、非法字符或层级过深 —— 整个归档拒绝。
pub fn safe_relative_parts(
    raw: &str,
    limits: &ArchiveLimits,
) -> Result<Option<Vec<String>>, String> {
    let name = raw.replace('\\', "/");
    if name.trim().is_empty() {
        return Ok(None);
    }
    if name.len() > limits.max_name_chars {
        return Err(format!(
            "{}里有条目名过长（超过 {} 个字符），已停止导入",
            limits.label, limits.max_name_chars
        ));
    }
    if name.starts_with('/') || name.contains(':') || name.contains('\0') {
        return Err(format!("{}里有不合法的条目名：{raw}", limits.label));
    }

    let mut parts = Vec::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(format!("{}里有试图跳出目标目录的条目：{raw}", limits.label));
        }
        if part.chars().any(|c| {
            c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*')
        }) {
            return Err(format!("{}里有包含非法字符的条目名：{raw}", limits.label));
        }
        if part.ends_with(' ') || part.ends_with('.') {
            return Err(format!("{}里有 Windows 无法保存的条目名：{raw}", limits.label));
        }
        if is_reserved_name(part) {
            return Err(format!("{}里有 Windows 保留名称：{raw}", limits.label));
        }
        parts.push(part.to_string());
    }

    if parts.is_empty() {
        return Ok(None);
    }
    if parts.len() > limits.max_depth {
        return Err(format!(
            "{}里的目录层级过深（超过 {} 层），已停止导入",
            limits.label, limits.max_depth
        ));
    }
    if parts.iter().any(|part| part == "__MACOSX") || parts[0].starts_with('.') {
        return Ok(None);
    }
    Ok(Some(parts))
}

fn is_reserved_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5"
            | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

/// 段列表 → 目标路径；调用方仍需保证根目录可信
pub fn join_parts(root: &Path, parts: &[String]) -> PathBuf {
    let mut out = root.to_path_buf();
    for part in parts {
        out.push(part);
    }
    out
}

/// 递归扫描的深度/条目/体积守卫（文件夹导入用）
pub struct ScanBudget<'a> {
    limits: &'a ArchiveLimits,
    files: usize,
    bytes: u64,
}

impl<'a> ScanBudget<'a> {
    pub fn new(limits: &'a ArchiveLimits) -> Self {
        Self {
            limits,
            files: 0,
            bytes: 0,
        }
    }

    pub fn check_depth(&self, depth: usize) -> Result<(), String> {
        if depth > self.limits.max_depth {
            return Err(format!(
                "文件夹的目录层级过深（超过 {} 层），已停止导入",
                self.limits.max_depth
            ));
        }
        Ok(())
    }

    pub fn note_file(&mut self, size: u64) -> Result<(), String> {
        self.files += 1;
        if self.files > self.limits.max_entries {
            return Err(format!(
                "文件夹里的文件太多（超过 {} 个），已停止导入",
                self.limits.max_entries
            ));
        }
        if size > self.limits.max_file_bytes {
            return Err(format!(
                "文件夹里有单个文件超过 {} 上限，已停止导入",
                self.limits.file_hint()
            ));
        }
        self.bytes = self.bytes.saturating_add(size);
        if self.bytes > self.limits.max_total_bytes {
            return Err(format!(
                "文件夹里的光标共超过 {} 上限，请删掉多余的文件后再导入",
                self.limits.total_hint()
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 拒绝路径穿越与绝对路径() {
        for bad in ["../evil.cur", "a/../../evil.cur", "/abs.cur", "C:/evil.cur", "a\\..\\evil.cur"] {
            assert!(safe_relative_parts(bad, &THEME_LIMITS).is_err(), "{bad:?} 应被拒绝");
        }
    }

    #[test]
    fn 隐藏与系统条目静默跳过() {
        assert!(safe_relative_parts(".DS_Store", &THEME_LIMITS).unwrap().is_none());
        assert!(safe_relative_parts("__MACOSX/a.cur", &THEME_LIMITS).unwrap().is_none());
        assert!(safe_relative_parts("cursors/arrow.cur", &THEME_LIMITS)
            .unwrap()
            .is_some());
    }

    #[test]
    fn 深度与条目数受限() {
        let deep = std::iter::repeat("a").take(THEME_LIMITS.max_depth + 1).collect::<Vec<_>>().join("/");
        assert!(safe_relative_parts(&deep, &THEME_LIMITS).is_err());

        let mut budget = ArchiveBudget::new(&THEME_LIMITS);
        for _ in 0..THEME_LIMITS.max_entries {
            budget.note_entry().unwrap();
        }
        assert!(budget.note_entry().is_err());
    }

    #[test]
    fn 流式复制超限即停止() {
        let data = vec![0u8; 1024];
        let mut out = Vec::new();
        let err = copy_bounded(&mut data.as_slice(), &mut out, 100, &THEME_LIMITS).unwrap_err();
        assert!(err.contains("上限"), "实际：{err}");
        assert!(out.len() <= 100, "超限内容不能继续落盘");
    }
}
