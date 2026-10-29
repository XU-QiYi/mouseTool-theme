# 真机验证脚本（手动跑，不进 CI）

对**真实 Tauri 窗口**验证浏览器 mock 覆盖不到的路径（真实文件系统、真实编码、
真实系统光标）。与 `docs/real-machine-verify/` 的说明文档一一对应。

## 共同前置

1. **应用未在运行**（单实例互斥会让脚本启动的实例直接退出转交）：
   `tasklist | findstr mousetool-theme` 应为空。
2. **vite 已在 1420**：`npm run dev:bg start`（与应用同源加载前端）。
3. Rust 工具链可用（脚本会 `cargo run` 编译并启动应用，用**隔离的
   LOCALAPPDATA 数据根**，不碰用户真实主题 / 备份）。

## 脚本做什么

| 脚本 | 验证 | 输入 |
|---|---|---|
| `verify_theme_scheme.mjs` | 决策 36：UTF-16LE `.theme` 解析、`%SystemRoot%` 展开到真实系统光标、同目录相对路径收编、真机查重成组 | 脚本自造（复制 `C:\Windows\Cursors\aero_*.cur/ani`） |
| `verify_themepack.mjs` | 决策 39：`makecab.exe`（微软自家 MSZIP 压缩器）打包的真实 CAB 解档 + 包内 `.theme` 映射 + DisplayName 优先 | 脚本自造（makecab DDF） |

两脚本都会：启动隔离应用 → CDP 直连 `__TAURI_INTERNALS__.invoke` 断言 →
**按 PID 结束应用**（先取 `tasklist /FO CSV /NH` 的 PID，绝不通配杀）→
清理 `%TEMP%` 下的临时数据根。每条 CDP 消息带 15 秒超时，单点挂起不会卡死。

## 运行

```powershell
npm run dev:bg start
node scripts/real_machine/verify_theme_scheme.mjs
node scripts/real_machine/verify_themepack.mjs
npm run dev:bg stop
```

退出码 0 = 全过。截图落在 `%TEMP%\rm_verify*.png`（不入库）。
