# 真机验证截图：备份内容浏览与单主题恢复

**日期**：2026-10-29
**分支**：`feature/backup-content-integrity`（基于 `feature/backup-content-restore` / 决策 34）
**环境**：Windows 真实桌面 + Tauri 2 debug 二进制（worktree 代码）+ WebView2，不是浏览器 mock。

## 隔离方式

验证时把 App 进程的 `LOCALAPPDATA` 指向临时根
`F:\forge\mouse-theme\real-verify-data`，数据实际落在其下的 `CursorStudio\`。
真实 `%LOCALAPPDATA%\CursorStudio` 未被写入：验证结束后仍只有原有的 5 套主题与 1 份自动备份，临时主题 ID / 备份名一个都不存在。

备份包里的「全缺文件」与「缺 1 个文件」场景由临时目录内的手工 zip 构造；完整备份通过界面「立即备份」真实生成。为了让“主题不在库、备份里还有”成立，临时主题目录用文件系统移出主题库（可逆），而不是点界面删除。

## 截图与结论

| 截图 | 验证内容 |
|---|---|
| `03-settings-data.png` | 界面显示的数据目录是临时根 `F:/forge/mouse-theme/real-verify-data\CursorStudio`，证明隔离生效 |
| `05-worktree-gallery.png` | 真实窗口加载 worktree 代码，临时主题「真机验证·极光」在主题图库中 |
| `06-backup-history-real.png` | 设置 → 数据 → 备份历史；每行出现「查看内容」入口与新的说明文案 |
| `07-backup-history-with-full.png` | 点「立即备份」生成完整备份（35.2 KB / 6 个文件），历史变为 3 份 |
| `08-full-backup-content-local.png` | 打开完整备份内容，主题标「已在主题库」、不提供恢复按钮 |
| `09-my-themes-before-delete.png` | 移出主题库前，「我的主题」里能看到临时主题 |
| `10-backup-history-after-theme-moved.png` | 主题移出库后，3 份备份仍在，完整备份可继续查看 |
| `11-full-backup-content-restorable.png` | 完整备份内容里的同一主题变为可恢复，按钮可用 |
| `12-full-backup-restored.png` | 点恢复后真实落盘：Toast「已恢复「真机验证·极光」共 5 个槽位」，行变为「已在主题库」 |
| `13-partial-backup-content.png` | 缺文件备份：行内显示「2 个槽位 · 2 个文件 · 缺 1 个文件」，仍提供恢复按钮 |
| `14-partial-restored-warning.png` | 恢复缺文件主题后：Toast 明说「恢复后的主题有 1 个槽位文件缺失（忙），应用时这些槽位会被写成空」，行变为「已在主题库」 |
| `16-empty-only-history.png` | 只留全缺文件备份时的备份历史 |
| `17-empty-backup-content.png` | 全缺文件备份内容：标「缺 1 个文件」与「没有可用文件」，**不提供恢复按钮** |
| `18-restored-partial-gap.png` | 回到图库，恢复出的缺文件主题被选中；检查器点名缺失槽位「忙」并说明应用后果 |
| `19-my-themes-gap.png` | 「我的主题」行内显示「缺 1 个文件」，与决策 31 的完整性口径一致 |

## 关联自动化

- Rust 单测：`备份内容标出缺文件主题且恢复后提示缺口`、`全缺文件主题恢复失败并清理`（`src-tauri/src/commands/backup.rs`）
- 浏览器验收：`node scripts/backup_content_check.mjs`（22/22，含 `?mock-backup-partial=1`）
