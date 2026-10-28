//! 回收站命令：列出、恢复、彻底删除、清空
//!
//! 删除主题的入口仍在 `commands::theme::delete_theme`（软删除进回收站）；
//! 这里只处理回收站自身的读写。恢复与彻底删除都会改动主题 / 数据目录，
//! 因此与导入、备份、迁移共用 `ops` 互斥锁，冲突立即失败、不排队。

use crate::utils::{ops, trash};

/// 列出回收站与当前限额（只读，目录不存在返回空列表）
#[tauri::command]
pub async fn list_trash() -> Result<trash::TrashListing, String> {
    tauri::async_runtime::spawn_blocking(trash::list)
        .await
        .map_err(|err| format!("读取回收站任务异常退出（{err}）"))?
}

/// 把一套主题从回收站恢复到当前主题目录
#[tauri::command]
pub async fn restore_from_trash(entry_id: String) -> Result<trash::RestoreOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("恢复主题")?;
        trash::restore(&entry_id)
    })
    .await
    .map_err(|err| format!("恢复主题任务异常退出（{err}）"))?
}

/// 彻底删除一个回收站条目（不可恢复）
#[tauri::command]
pub async fn delete_from_trash(entry_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = ops::try_begin("彻底删除主题")?;
        trash::purge(&entry_id)
    })
    .await
    .map_err(|err| format!("删除回收站条目任务异常退出（{err}）"))?
}

/// 清空回收站；单个条目失败只进 `failed`，其余照常删除
#[tauri::command]
pub async fn empty_trash() -> Result<trash::EmptyOutcome, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let _guard = ops::try_begin("清空回收站")?;
        trash::empty()
    })
    .await
    .map_err(|err| format!("清空回收站任务异常退出（{err}）"))?
}
