//! 发布版持久日志（决策 46）
//!
//! 发布版是 `windows_subsystem = "windows"`，没有控制台，`eprintln!` 的输出
//! 全部丢失；托盘切换失败、右键菜单转交失败这类后台事件用户根本看不到，
//! 报问题时也拿不出「当时发生了什么」。这里提供数据根 `logs\` 下的追加写
//! 日志：单文件超限轮转、保留少量历史，诊断中心可一键打开目录。
//!
//! 原则：日志系统自己绝不能把业务搞挂——写失败一律静默吞掉；只记事件与
//! 原因，不写主题内容；日志只留本机，与 README「不上传任何本地数据」一致。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::paths;

/// 数据根下的日志目录名（`logs\`，不参与存储统计——诊断开销，不是用户数据）
pub const DIR_NAME: &str = "logs";
const FILE_NAME: &str = "mousetool.log";
/// 单文件上限：日志是排查线索不是档案，超限就轮转
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// 连当前文件在内保留几份（当前 + 2 份历史）
const KEEP_FILES: usize = 3;

/// 日志目录：`<数据根>\logs`（只认 `paths::data_root()`，硬约束 1）
pub fn log_dir() -> Result<PathBuf, String> {
    Ok(paths::data_root()?.join(DIR_NAME))
}

/// 写入端互斥：调用方散布在 `spawn_blocking` 线程池的各个线程，并发追加不能交错
static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // 中毒的锁也照用：日志写入没有需要恢复的不变量，拿不到锁才是真问题
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

/// 追加一条日志。任何失败都静默：日志是辅助设施，不能反过来弄坏业务。
///
/// `level` 用 "info" / "warn" / "error"；`module` 是短标签（如 "tray"）。
pub fn write(level: &str, module: &str, message: &str) {
    let _guard = lock();

    let line = format!(
        "[{}] [{level}] [{module}] {message}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );

    // 数据根不可用（LOCALAPPDATA 缺失等）就整个放弃，没有更好的去处
    let Ok(dir) = log_dir() else {
        return;
    };
    if paths::ensure_dir(&dir).is_err() {
        return;
    }
    let file = dir.join(FILE_NAME);
    if rotate_if_oversized(&file).is_err() {
        return;
    }
    if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(&file) {
        let _ = handle.write_all(line.as_bytes());
    }

    // 开发版保留控制台输出：`npm run tauri dev` 时不用翻文件
    #[cfg(debug_assertions)]
    eprint!("{line}");
}

pub fn info(module: &str, message: &str) {
    write("info", module, message);
}

pub fn warn(module: &str, message: &str) {
    write("warn", module, message);
}

pub fn error(module: &str, message: &str) {
    write("error", module, message);
}

/// 当前文件超限就轮转：`.log → .1 → .2`，最老的直接删。
/// Windows 的 `rename` 不覆盖已存在的目标，所以每一跳都先删后改。
fn rotate_if_oversized(file: &Path) -> Result<(), String> {
    let oversized = fs::metadata(file)
        .map(|meta| meta.len() >= MAX_FILE_BYTES)
        .unwrap_or(false);
    if !oversized {
        return Ok(());
    }
    for i in (1..KEEP_FILES - 1).rev() {
        let from = rotated_path(file, i);
        if from.exists() {
            let to = rotated_path(file, i + 1);
            let _ = fs::remove_file(&to);
            let _ = fs::rename(&from, &to);
        }
    }
    let _ = fs::remove_file(rotated_path(file, 1));
    fs::rename(file, rotated_path(file, 1)).map_err(|err| format!("轮转日志失败（{err}）"))
}

fn rotated_path(file: &Path, n: usize) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{n}"));
    file.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::paths::use_test_roots;

    /// 日志测试必须留在持测试根的线程上：`data_root()` 的测试重定向是
    /// thread-local，跨线程会把日志写进真实数据根（硬约束 24）
    fn with_sandbox(run: impl FnOnce(&Path)) {
        let sandbox = tempfile::tempdir().expect("临时目录");
        let _guard = use_test_roots(sandbox.path().to_path_buf(), sandbox.path().join("themes"));
        run(sandbox.path());
    }

    #[test]
    fn 日志落在数据根的_logs_目录() {
        with_sandbox(|root| {
            warn("tray", "创建托盘图标失败：测试");
            let file = root.join(DIR_NAME).join(FILE_NAME);
            let text = fs::read_to_string(&file).expect("日志文件应存在");
            assert!(text.contains("[warn] [tray] 创建托盘图标失败：测试"));
            // 时间戳在最前面
            assert!(text.starts_with('['));
        });
    }

    #[test]
    fn 追加不覆盖() {
        with_sandbox(|root| {
            info("importer", "第一条");
            info("importer", "第二条");
            let text = fs::read_to_string(root.join(DIR_NAME).join(FILE_NAME)).expect("日志文件");
            assert!(text.contains("第一条") && text.contains("第二条"));
        });
    }

    #[test]
    fn 超限轮转并只保留_两份历史() {
        with_sandbox(|root| {
            let file = root.join(DIR_NAME).join(FILE_NAME);
            // 一条 ~1.1KB，写满三轮（每轮 > 512KB）触发三次轮转
            let body = "x".repeat(1024);
            for round in 0..1600 {
                info("stress", &format!("{round:04} {body}"));
            }
            assert!(rotated_path(&file, 1).exists(), "应有一份历史");
            assert!(rotated_path(&file, 2).exists(), "应有两份历史");
            assert!(!rotated_path(&file, 3).exists(), "不应有第三份历史");
            // 当前文件重新从较小开始
            let len = fs::metadata(&file).expect("当前日志").len();
            assert!(len < MAX_FILE_BYTES, "轮转后当前文件应重新起头：{len}");
        });
    }
}
