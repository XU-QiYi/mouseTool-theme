//! 重操作互斥：导入、备份恢复、主题目录迁移不能同时跑
//!
//! 用 `try_lock` 立即失败而不是排队：用户连点两下「导入」时，第二下应该得到
//! 一句「另一个操作正在进行」，而不是默默排进队列、过一会儿又弹一次结果。

use std::sync::{Mutex, TryLockError};

static HEAVY_OPERATION: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub struct OperationGuard {
    _guard: std::sync::MutexGuard<'static, ()>,
}

/// 尝试进入一个重操作；已有操作在跑时返回可直接展示的中文错误
pub fn try_begin(label: &str) -> Result<OperationGuard, String> {
    match HEAVY_OPERATION.try_lock() {
        Ok(guard) => Ok(OperationGuard { _guard: guard }),
        Err(TryLockError::WouldBlock) => Err(format!(
            "另一个操作正在进行（导入 / 恢复 / 迁移），请等它完成后再{label}"
        )),
        // 前一个操作 panic 后锁中毒：恢复内层，不让一次失败永久堵死后续操作
        Err(TryLockError::Poisoned(err)) => Ok(OperationGuard {
            _guard: err.into_inner(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同一时间只允许一个重操作() {
        let first = try_begin("导入").expect("第一次应成功");
        let err = try_begin("导入").unwrap_err();
        assert!(err.contains("另一个操作"), "实际：{err}");
        drop(first);
        assert!(try_begin("导入").is_ok(), "前一个结束后应能再次进入");
    }
}
