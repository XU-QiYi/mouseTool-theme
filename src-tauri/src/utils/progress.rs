//! 长耗时任务的进度载荷
//!
//! 阶段是给界面看的字符串，不参与逻辑判断；`current/total` 可能为 0（收尾阶段）。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TaskProgress {
    /// 阶段标识：extract / persist / scan / write / done
    pub stage: String,
    pub current: usize,
    pub total: usize,
    /// 中文说明，界面直接展示
    pub message: String,
}

impl TaskProgress {
    pub fn new(stage: &str, current: usize, total: usize, message: impl Into<String>) -> Self {
        Self {
            stage: stage.to_string(),
            current,
            total,
            message: message.into(),
        }
    }
}

/// 只保留最后一次进度，避免解压大包时每 64KB 都碰一次状态
pub struct ProgressThrottle {
    last_percent: i32,
    total: usize,
}

impl ProgressThrottle {
    pub fn new(total: usize) -> Self {
        Self {
            last_percent: -1,
            total,
        }
    }

    /// 每完成一项调用；百分比没变化时返回 false
    pub fn step(&mut self, current: usize) -> bool {
        let percent = if self.total == 0 {
            100
        } else {
            ((current as f64 / self.total as f64) * 100.0) as i32
        };
        if percent == self.last_percent {
            return false;
        }
        self.last_percent = percent;
        true
    }
}
