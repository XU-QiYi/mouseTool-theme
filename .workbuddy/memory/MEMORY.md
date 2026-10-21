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
- **多数据源聚合必须部分成功**：`get_all_themes` 返回 `models::ThemesResult{themes, warnings}`，来源失败进 warnings 不整体失败（`merge_sources` 纯函数 + 回归测试）；`read_user_themes` 返回 `(themes, warnings)`，坏了的主题只跳过不消失
- **数据目录**：`%LOCALAPPDATA%\CursorStudio\themes\<uuid>\{theme.json, cursors/}`，唯一来源是 `utils/paths.rs::data_root()`，禁止别处硬编码
- **槽位推断两段式**：先 `EXACT_NAMES` 精确匹配短名（`no`/`ns`/`we`/`up`），再 `SLOT_KEYWORDS` 包含匹配。短名绝不能放进包含匹配表（`no` 会撞 `normal`）
- **15 槽位顺序**以 `src-tauri/src/utils/registry.rs` 的 `SLOT_DEFS` 为准（依据 `Schemes` 实测值），顺序错了会导致光标整体串位
- `.cur`/`.ico` 解析：自己读 ICO 目录挑最大尺寸，再把单帧拼成「只含一帧的 ICO」交给 `image` 官方解码器（裸 DIB + AND mask 由库处理）
- `.ani`：手写 RIFF/ACON 解析，从 `LIST/fram` 取 `icon` 块；rate 单位是 1/60 秒
- 光标路径直接指向原位置，不复制到系统目录

## UI 验证工具（无需人眼）
- `node scripts/ui_check.mjs` — 点卡片 + 点应用按钮，截图
- `node scripts/nav_check.mjs` — 依次点三个导航项，输出三栏结构 + 截图
- 依赖 vite 在 1420 运行；必须带 `--force-device-scale-factor=1`（系统 DPI 会把视口压到 756px 导致布局误判）

## 设计规范（2026-10-21 建立）
- 文档：`docs/design-system.md`（可检索）+ `docs/design-system.html`（可视化，可切明暗）
- token 唯一来源 `src/App.css`：已补 `success/warning/info`、`preview-bg/checker`、`elev-*→shadow-*`、`text-3xs/2xs`、`ease-standard`
- 自建 utility：`focus-ring`（键盘焦点环）、`preview-surface`（透明光标用的棋盘格底，尚未启用）
- **有意偏离 shadcn 上游**：`--ring` 由 `oklch(0.708)` 调深到 `oklch(0.55)`，且 button/badge/input 的 `focus-visible:ring-ring/50` 去掉了 `/50`——半透明焦点环实测仅约 1.3:1，不达 WCAG 3:1。**重新 `shadcn add` 组件后必须重打**
- 滚动条统一用系统原生，`ScrollArea` 停用（桌面端平台一致性优先于自绘）
- 硬规则：间距必须落 2px 网格；字号禁用 `text-[Npx]`；禁止 `transition-all`；状态色不承载主操作
- 验收脚本：`design_check.mjs`（Tab 走查 + 焦点环实测 + 截图，不点应用）、`design_audit.mjs`（取值审计）、`ui_ratio.mjs`（组件比例）
- 口径教训：`text-*` 同时承载字号/颜色/对齐，统计必须分开归类；图标要分「内联」和「占位图形」两组，否则会把合理差异误判成混乱

## 组件选型与交互约定（2026-10-21）
- **零新依赖原则**：`@base-ui/react` 已自带 `toast` / `alert-dialog` / `dialog` / `menu` / `popover` 等，P1 类需求优先用它手写 shadcn 风格封装，**不要装 sonner / radix**
- Toast：`lib/toast.ts` 用 `Toast.createToastManager()` 建全局 manager，store/service 可直接调；渲染层 `components/ui/toaster.tsx` 挂在 App 根部；`import.meta.env.DEV` 下暴露 `window.__toast` 便于自动化验证
- **删除类命令必须 `Uuid::parse_str` 校验 id**：`theme_dir(id)` 是字符串拼接，未校验时传 `../` 可越出数据目录
- 不能删除「正在使用」的主题（注册表仍指向其文件），三层防护：UI disabled → store 校验 → 后端路径校验
- 错误文案规范：中文主句说人话，技术细节放括号；能指导下一步就写进主句
- **vite dev 崩溃排查**：新增依赖触发重优化时，vite 删 `node_modules/.vite/deps_temp_*` 会被 safe-delete shim 拦截（>50 文件）→ 手动 `rm -rf node_modules/.vite` 重启。另：后台起 dev server **不能接 `| head`**，SIGPIPE 会让它 16s 后退出
