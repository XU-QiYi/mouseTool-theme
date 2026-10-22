# 项目长期记忆 — 鼠标光标主题管理工具

## 技术栈
Tauri 2 (Rust) + React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui (base-nova) + zustand

## 范围（2026-10-22 拍板，决策 10）
- 产品 = 主题管理器：导入整套方案 → 应用 → 管理 → 回溯。**自制方案 / 单光标替换不做**（连带不做图片转 .cur、热点编辑）；槽位卡保持不可点、不做 hover 暗示，这是产品决定不是欠债
- 主题来源只有两条：系统注册表方案、`.zip` 导入。市场/在线来源**已搁置**（2026-10-22），需求文档 §0 本来就把"在线主题商店"列为不做；"更多主题"若重启，方向是索引 + 下载安装回到同一条落盘路径，不是应用内生产光标

## 文档权威顺序（2026-10-22 定）
决策记录 > 需求描述（需求基线 v2.0）> 架构设计 > design-system / motion。冲突取前者，别各写一套。
- docs 现有 6 份：决策记录 / 需求描述 / 架构设计 / 启动与构建指南 / design-system.md+html / motion.md；`技术栈.md`（选型对比稿）与 `stitch-ui-prompt.md` 已删（结论并入决策记录附录 A）
- **文档里不得把未实现写成已支持**：自制方案、文件夹导入、拖拽导入、`.inf` 解析、单光标替换、设置页/打开数据目录、窗口窄宽适配
- 写注册表只写 15 槽位 + `SchemeName`，**不写** `Cursors\Schemes`；槽位网格只列实际有的槽位（不补齐 15 格）
- 圆角实际口径：`sm 6 / md 8 / lg 10（按钮·输入框）/ xl 14（卡片·弹窗）/ 4xl 26（徽章=胶囊）`，旧文档写"lg 8px"是错的
- **`productName` 只改显示名/安装包名，不改 exe 文件名**（exe 名来自 `Cargo.toml [package] name`）；要改二进制名才用 `mainBinaryName`。改 productName 是安全的（`cargo check` 即可验）
- `AGENTS.md`（git 跟踪的是小写 `agents.md`，同一文件）是每次会话自动注入的项目指导，**事实必须与代码一致**；2026-10-22 已按 15 槽位 / LOCALAPPDATA / 不写 Schemes / 8 命令 / 未实现清单重写，并压成 103 行速查卡（明细指向 docs，勿再塞回全量表）
- 改了文档交叉引用就跑 `node scripts/doc_ref_check.mjs`（`§x` / `决策 N` 指空会列 `文件:行号` 并退出码 1，不需要 dev server）；重排章节后必跑

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
- `get_all_themes` 签名**保留** `Result<ThemesResult, String>`（用户拍板 2026-10-21）：`Err` 只留给意外的全灭，来源失败一律走 warnings；此题已定，不再反复纠结改成不可失败
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
- **vite 缓存必须落 OS 临时目录**（`vite.config.ts` 的 `cacheDir`，已配）：safe-delete 护栏对项目内批量删除 >50 文件 fail-closed，vite 重优化删旧 deps（70+ 文件）会把进程炸掉；临时目录是护栏豁免区（视为可再生缓存）。**禁止把 cacheDir 改回 `node_modules/.vite`**
- **后台起 dev server 只用 `npm run dev:bg` / `node scripts/dev_bg.mjs`**：stdio 接日志文件、detached、带 start/stop/status（PID 落 `.dev-server.pid`）。**禁止 `npm run dev | head` 之类管道后台启动**——管道一关 EPIPE 直接杀死 vite；`vite.config.ts` 已加 EPIPE 守护兜底，但仍以 dev_bg 为准
- **dev server 跨命令会被回收**：`dev_bg.mjs start` 起的 vite 在 bash 命令结束即静默消失（日志无 error，端口只余 TIME_WAIT）。**启动与验证必须写进同一条 bash 命令**，否则验证脚本拿到 502 并报一堆「按钮 NOT_FOUND」假失败
- **改名只改 theme.json 的 name，目录名保持 UUID**（改目录会让正在使用的光标路径失效）；`updated_at` 承担「导入于」语义，改名不动它
- 原地编辑类交互（重命名）：autoFocus + onFocus 全选，Enter 保存 / Esc 取消 / 失焦保存，值未变不发请求；**草稿必须用 ref 存**，否则 Esc 与 blur 的 setState 竞态会把「取消」变成「保存」
- **导出 zip 的包内文件名必须按槽位重命名**（`sizenwse.cur`），因为导入靠文件名反推槽位；用源文件名会破坏「导出→再导入」闭环
- `export_theme` 接收整个 `CursorTheme` 而非 id：系统方案（注册表）没有磁盘目录，但同样有光标文件路径，这样才能一起导出
- 写文件失败要清理半成品（空 zip）：先 `drop(writer)` 再 `remove_file`，Windows 上句柄不关删不掉
- `capabilities/default.json` 用了 `dialog:*` 时，save 需确认 `dialog:allow-save` 在授权内，否则运行时才报权限错
- **「正在使用」只能从注册表反推**：`get_all_themes` 返回 `active_theme_id`（`read_current_slots` + 双向槽位比对 + 路径大小写归一）。禁止用内存/本地存储记 active——重开即过期，会让已应用的主题还能再点一次「应用」
- **盒外 ring / box-shadow 与 overflow 容器冲突**：滚动列表首尾必须留 ≥2px padding，否则 ring 被裁、卡片像缺边；`design_check.mjs` 已加硬断言守住

## 动效（2026-10-21）
- 四档 token：`--motion-fast/base/slow/exit` = 120/180/240/160ms，配 `ease-standard` / `ease-exit`；组件只写 `duration-(--motion-*)`，禁止裸数字与 `transition-all`
- base-ui 的 toast **前插到栈顶**：新增不推动已有项，「移除最旧一条」才需要 FLIP 让位
- FLIP 位置 = `offsetParent.rect.top + offsetTop`：BCR 会吃进自身 translate，单看 offsetTop 会漏掉容器整体位移
- 退场时长不能为 0：base-ui 靠 `transitionend` 卸载节点；reduced-motion 只能压到 0.01ms
- 验收 `scripts/motion_check.mjs`（28 项逐帧断言）；规范 `docs/motion.md`；`design_audit.mjs` 会查裸写时长与全量 `transition-all`

## 最近使用（2026-10-22）
- 历史存 `%LOCALAPPDATA%\CursorStudio\history.json`（不是 theme.json）：`{version,entries[]}`，50 条上限，同 id 去重置顶，记名称快照
- `apply_theme` 返回 `ApplyOutcome{recent,warning}`：主操作成功就不回滚，历史失败只 warning；`ThemesResult.recent` 随启动加载，坏了只进 warnings
- 时间轴每条 = 时刻 + 名称 + 槽位数；被删主题仍占一条、标「已删除」且不给「再次应用」

## 导航与视图结构（2026-10-22 重构，已实现）

- 三项 = 三视图，**不共用列表**：图库=分组网格（系统方案/我的主题两段）· 我的主题=表格（槽位覆盖/导入于/导出·删除）· 最近使用=按天分组时间轴（无检查器）
- **加页面只改两处**：`lib/pages.ts::PAGE_META` 加一条 + `App.tsx` 的 `VIEWS` 加一行视图；`Page = keyof typeof PAGE_META`，两处都是 `Record<Page,…>`，漏写编译即失败
- 选中按页各记一份 `selection: Partial<Record<Page,string|null>>`（页面不写键=没有选中，别给每页强塞槽位）；切页只清搜索词，重载只清已不存在的 id
- 检查器由图库与我的主题共用（应用/导出/删除/改名）；改名只在 `ThemeNameField` 一处，表格行内只放导出/删除
- 选中强反馈：图库用 2px ring，表格用整行高 2px 竖线（`accent` 与底仅 3% 明度差，单靠底色不够）
- 侧栏底部常驻「当前光标」状态卡，「还原系统默认」只此一处；`lib/slots.ts::SYSTEM_SLOT_TOTAL=15` 是 SLOT_DEFS 镜像，后端改槽位要同步
- 检查器宽度由 `InspectorResizer` 拖动（280–560、双击复位、←→16px，被 `innerWidth-224-440` 夹住，**不落盘**）；滚动容器一律 `scroll-thin`：6px、轨道透明、**拇指默认隐形、hover 才浮出**（`::-webkit-scrollbar`；`scrollbar-width: thin` 在 Chromium 里仍是带箭头的经典条，别用）
- 外观三态（跟随系统/浅/深）只在 `lib/theme-mode.ts`：`html.dark` + 落盘 `cursorstudio.theme-mode` + `setTheme` 同步标题栏（权限 `core:window:allow-set-theme`，改完要重编）；组件零 `dark:` 前缀；手选浅/深后不再跟系统，选回 system 才恢复
- 检查器内容压到 **462px**（15 槽位在 1200×760 不出现滚动条）：别再往头部塞徽章行、往底部塞多行 dl
- `ThemeList`/`ThemeCard`/`ThemeDetail` 已删除，别再按"列表+详情+过滤条件"加页面
- 窗口最小 1080×640（`tauri.conf.json`，224+280+440=944 的依据）；**不做响应式断点**，窄窗不重排不收起；`design_check` 会断言这两个值
- 验收：`nav_check` 断言三页结构签名（同构即失败）；`design_check` 覆盖表格/时间轴/删除链 + 检查器宽度/不溢出/最小窗口；均已跑绿
