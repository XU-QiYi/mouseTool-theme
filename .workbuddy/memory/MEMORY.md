# 项目长期记忆 — 鼠标光标主题管理工具

## 技术栈
Tauri 2 (Rust) + React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui (base-nova) + zustand

## 踩过的坑（务必遵守）

### 1. zustand selector 不能返回新对象
在 selector 里做 `filter`/`map`/对象字面量 → 每次返回新引用 → `useSyncExternalStore` 判定快照变化 → **无限重渲染，整页白屏崩溃**。
正确做法：selector 只取原始状态（`s.themes`），派生数据写纯函数 + 组件内 `useMemo`。

### 2. Tauri 的 additionalBrowserArgs 会覆盖环境变量
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 被 Tauri 自身设置的 `additionalBrowserArgs` 覆盖，**通过环境变量传 WebView2 参数完全无效**。必须写在 `src-tauri/tauri.conf.json` 的 `app.windows[].additionalBrowserArgs`。

### 3. 本机必须 `--no-sandbox`
WebView2 渲染进程沙箱在本机无法初始化（窗口正常、JS 正常、但不画像素）。配置 `"additionalBrowserArgs": "--no-sandbox"` 解决。

### 4. SPI_SETCURSORS 不能带 SPIF_UPDATEINIFILE
`SystemParametersInfoW(SPI_SETCURSORS, 0, None, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE)` 在本机返回 0x80070006。**只传 `SPIF_SENDCHANGE`**（路径已由 write_cursors 写入注册表，无需系统回写）。

### 5. cargo 联网必须绕过系统代理
系统代理指向未运行的 Clash（127.0.0.1:7897）。命令前缀：
```
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy CARGO_HTTP_PROXY="" cargo ...
```

### 6. PowerShell 脚本
- 一律 pwsh 7；**必须存为 UTF-8 with BOM**，否则 PS 按 ANSI 解码中文变乱码、语法检查报错
- 避免反引号续行（LF 行尾下易解析失败），改用 splatting `@{...}`

### 7. 测试
- 碰注册表的测试必须加全局 `Mutex` 串行，并用 `unwrap_or_else(|e| e.into_inner())` 防中毒连锁失败
- 改用户设置的测试要用「备份 + catch_unwind + 恢复」模式，断言失败也必须还原

## 关键技术决定
- **15 槽位顺序**以 `src-tauri/src/utils/registry.rs` 的 `SLOT_DEFS` 为准（依据 `Schemes` 实测值），顺序错了会导致光标整体串位
- `.cur`/`.ico` 解析：自己读 ICO 目录挑最大尺寸，再把单帧拼成「只含一帧的 ICO」交给 `image` 官方解码器（裸 DIB + AND mask 由库处理）
- `.ani`：手写 RIFF/ACON 解析，从 `LIST/fram` 取 `icon` 块；rate 单位是 1/60 秒
- 光标路径直接指向原位置，不复制到系统目录

## UI 验证工具（无需人眼）
- `node scripts/ui_check.mjs` — 点卡片 + 点应用按钮，截图
- `node scripts/nav_check.mjs` — 依次点三个导航项，输出三栏结构 + 截图
- 依赖 vite 在 1420 运行；必须带 `--force-device-scale-factor=1`（系统 DPI 会把视口压到 756px 导致布局误判）
