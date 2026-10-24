# 架构设计 · 鼠标光标主题管理工具

**版本**：v2.1
**日期**：2026-10-25

> 本文描述**代码现在长什么样**，不是愿望清单。没实现的能力统一收在 §9。
> 权威顺序：`mouse-theme决策记录.md` > `mouse-theme需求描述.md` > 本文。
> 仓库根目录的 `AGENTS.md` 是同一套事实的压缩速查版（给 AI 用，每次会话自动注入）；**改架构时两处一起改**，别只改一边。
>
> 上一版是提示词粘贴稿（每段重复两遍、槽位 14 项且顺序错、`sonner`、UAC 复制系统目录），已整体作废。

---

## 1. 总览

| 关注点 | 选型 | 落点 |
|---|---|---|
| 界面 | React 19 + TypeScript 5.8 + Tailwind CSS 4 | `src/` |
| UI 组件 | shadcn/ui（base-nova 风格，底层 `@base-ui/react`） | `src/components/ui/` |
| 状态 | zustand 5 | `src/stores/themeStore.ts` |
| 桌面壳 | Tauri 2（WebView2） | `src-tauri/` |
| 系统能力 | Rust：`winreg` / `windows` / `image` / `zip` | `src-tauri/src/` |
| 构建 | Vite 7 + `tsc` | `vite.config.ts`、`package.json` |

**进程边界**：界面全部跑在 WebView2 里，**不具备任何系统权限**；注册表、文件、光标解码全部在 Rust 侧。两条进程之间只有 Tauri command 一条通路，没有"前端直接读文件"的旁路。

---

## 2. 目录结构（与仓库一致）

```
mouseTool-theme/
├── src/
│   ├── App.tsx                     ← 骨架：侧栏 + 页头 + 当前视图 +（按页）检查器
│   ├── App.css                     ← 设计 token 唯一来源（颜色/字号/间距/动效）
│   ├── components/
│   │   ├── layout/                 ← Sidebar / PageHeader / DataWarning / EmptyState
│   │   ├── views/                  ← GalleryView / MyThemesView / RecentView（三页各自的视图）
│   │   ├── theme/                  ← GalleryCard / ThemeInspector / ThemeNameField / DeleteThemeDialog / CursorGrid
│   │   ├── cursor/                 ← CursorSlotCard / CursorPreviewImage / AniPlayer
│   │   └── ui/                     ← shadcn 组件（button/card/badge/dialog/toast…）
│   ├── hooks/                      ← useCursorPreview / useImportTheme / useExportTheme / useDragDropImport
│   ├── services/
│   │   ├── theme.ts                ← 全部 invoke 封装
│   │   └── mock.ts                 ← 浏览器直开时的假数据（非 Tauri 环境）
│   ├── stores/themeStore.ts        ← 唯一全局状态（页面 / 按页选中 / 搜索 / 警告）
│   ├── lib/                        ← pages（页面清单）、settings-sections（设置分组）、slots（槽位统计）、themes（筛选与分组）、theme-mode、shortcuts、toast、cn()
│   └── types/                      ← 与 Rust 结构体逐字段对应
├── src-tauri/
│   ├── tauri.conf.json             ← 窗口/打包配置（含 --no-sandbox，勿删）
│   ├── capabilities/default.json   ← 前端可用的插件权限
│   └── src/
│       ├── commands/               ← cursor.rs / theme.rs / data.rs / settings.rs / system.rs / backup.rs：命令层
│       ├── models/theme.rs         ← 数据结构
│       └── utils/
│           ├── paths.rs            ← 数据目录唯一来源（主题目录跟随 settings.json 覆盖值）
│           ├── theme_paths.rs      ← 槽位路径相对/绝对转换与 theme.json 重写（决策 17）
│           ├── registry.rs         ← SLOT_DEFS、注册表读写、SPI 刷新
│           ├── cursor.rs           ← .cur/.ico/.ani 解析与缩放
│           ├── importer.rs         ← zip / 文件夹导入、槽位推断（决策 15/16）
│           ├── inf_export.rs       ← 导出 zip 附带的通用 .inf 安装文件（决策 13）
│           ├── inf_parse.rs        ← 导入时解析 .inf 槽位映射（决策 15）
│           ├── history.rs          ← 最近使用读写（含备份合并）
│           ├── settings.rs         ← settings.json（关闭行为/主题目录/开关，决策 14）
│           ├── themes_dir.rs       ← 主题存储目录预检与安全搬迁（暂存/校验/原子切换/回滚，决策 17）
│           ├── autostart.rs        ← HKCU Run 键（开机自启动）
│           ├── tray.rs             ← 托盘图标（关闭到托盘时才存在）
│           └── integration.rs      ← 单实例互斥、--import 转交、.zip 右键菜单
├── scripts/                        ← 无头浏览器验收脚本（设计/动效/交互）
└── docs/
```

**没有 `pages/`，但有一个 `views/`。** 三个页面各是独立视图（网格 / 表格 / 时间轴），共用同一套骨架：`Sidebar` + `PageHeader` + 内容区 +（图库与我的主题才有的）`ThemeInspector`。它们**刻意不复用同一个列表**——复用列表再叠过滤条件，正是"切页看不出变化"的根因。

**加页面只改两处**：`lib/pages.ts` 的 `PAGE_META`（导航文案 / 页头文案 / 搜索框 / 计数口径 / 有无检查器）+ `App.tsx` 的 `VIEWS`（页面 → 视图组件）。`Page` 类型由 `PAGE_META` 的键推导，`Sidebar` / `PageHeader` / `App` 都从这份表取值，不再各自维护一份导航清单；两处都是 `Record<Page, …>`，漏写视图会编译失败而不是运行时白屏。

---

## 3. 前端分层

```
App.tsx
  ├─ Sidebar                    主形态：导航（带计数）、导入入口、常驻「当前光标」状态卡；
  │                             设置形态：返回 + 五个分组（通用/快捷键/数据/系统集成/关于）
  └─ main
       ├─ PageHeader            标题 / 这一页做什么 / 该页搜索 / 计数（设置页跟随分组标题）
       ├─ DataWarning           部分数据源失败时的常驻提示（可关、可重试）
       └─ [data-view=<page>]    当前视图（换页整块淡入）
            ├─ GalleryView      分组网格 → GalleryCard
            ├─ MyThemesView     表格（槽位覆盖率 + 导入时间 + 导出/删除）
            ├─ RecentView       按自然日分组的时间轴
            ├─ SettingsView     设置：按 settingsSection 切五个分组内容（决策 14），不依赖主题列表
            └─ ThemeInspector   图库/我的主题共用：预览、应用、导出、删除、改名
```

**数据流是单向的：**

```
组件事件 → store action → services/theme.ts → invoke → Rust
                ↑                                        │
                └──────────── set(state) ←───────────────┘
```

**规则**

1. 组件**不直接** `invoke`，也不自己拼路径。要数据就调 store action。
2. `services/`（`theme.ts` / `system.ts`）只做"把 command 包成带类型的中文错误"，不写业务判断。
3. store 内统一 `try/catch`，失败弹 Toast，不向组件抛异常。
4. `hooks/useCursorPreview` 与 `hooks/useDiagnostics` 是**只读例外**：直连 service，但只维护自己的内存状态，不碰全局状态——预览与诊断文本是纯派生展示数据，塞进 store 会让主题列表的任何变更都触发全量重算。

**不要再犯的坑**：zustand selector 里不能 `filter`/`map`/写对象字面量，每次返回新引用会让 `useSyncExternalStore` 判定快照变化，直接无限重渲染白屏。派生数据写纯函数 + 组件内 `useMemo`。

---

## 4. Rust 分层

| 层 | 职责 | 约束 |
|---|---|---|
| `commands/` | 接参数、编排、返回 | 每个函数标 `#[tauri::command]`，错误统一 `Result<T, String>`（中文） |
| `models/` | `struct` 定义 | 全部 `Serialize + Deserialize`，字段名即前后端契约（`snake_case`） |
| `utils/` | 纯技术操作 | 不知道"主题"的业务语义，只管注册表/文件/二进制 |

`utils` 只被 `commands` 调用，不反向依赖。注册表相关的测试必须**全局串行**（`Mutex`），且用 `unwrap_or_else(|e| e.into_inner())` 防中毒连锁失败。

---

## 5. 命令契约（当前共 23 个）

| Command | 入参（前端写法） | 返回 | 失败场景 |
|---|---|---|---|
| `get_all_themes` | — | `ThemesResult` | 只有聚合本身崩溃才 `Err`；单个来源失败走 `warnings` |
| `get_cursor_preview` | `filePath` | `CursorPreview` | **不失败**，解析不出来返回空帧 |
| `import_theme` | `sourcePath` | `CursorTheme` | 不是 .zip 也不是文件夹、超过 50MB、无光标文件、认不出槽位（且 .inf 无映射）、写盘失败 |
| `apply_theme` | `theme`（整个对象） | `ApplyOutcome` | 注册表写失败；历史写失败只进 `warning` |
| `restore_default` | — | `void` | 清空注册表失败 |
| `delete_theme` | `themeId` | `void` | ID 非法、目录不存在、被占用 |
| `rename_theme` | `themeId`, `newName` | `CursorTheme` | 空名、超 40 字、控制字符、json 损坏 |
| `export_theme` | `theme`, `destPath` | `ExportSummary` | 目标目录不存在、写 zip 失败（会清掉半成品） |
| `get_data_dir` | — | `String`（展示路径） | **不失败**（只读 `data_root()`，不创建目录） |
| `open_data_dir` | — | `String`（实际打开的路径） | 建目录失败、系统文件管理器打开失败 |
| `get_windows_version` | — | `String` | 读不到注册表版本键（诊断信息降级为「未知」） |
| `open_mouse_panel` | — | `void` | rundll32 启动失败（曾试 `ms-settings:mouse` 跳新版设置页，该页面别名在本机不解析——cmd start / explorer / ShellExecuteW / Win+R 四条通路全回落主页，故收敛为经典面板） |
| `get_zip_menu_registered` | — | `ZipMenuStatus` | **不失败**（读不到就当未注册） |
| `set_zip_menu` | `register`（布尔） | `void` | 注册表写失败（试点功能，决策 12） |
| `take_pending_import` | — | `String \| null` | **不失败**（无待导入 / 文件损坏都返回 null，领取即删除） |
| `get_settings` | — | `SettingsSnapshot` | **不失败**（文件缺失/损坏都退回默认值） |
| `update_settings` | `closeBehavior?`, `autoCheckUpdate?`, `shortcutsEnabled?`（只传要改的） | `SettingsSnapshot` | 不认识的关闭行为值、写盘失败；关闭行为变更会同步托盘有无 |
| `get_autostart` | — | `AutostartStatus` | **不失败**（读不到就当未注册） |
| `set_autostart` | `enable`（布尔） | `AutostartStatus` | Run 键写/删失败；状态以注册表回读为准 |
| `preview_themes_dir` | `path?`（字符串 \| null） | `ThemesDirPlan` | 目标不是绝对路径 / UNC / 经过重解析点 / 数据目录内部（默认除外）/ 祖先 / 互相嵌套 / 非空目录；只校验统计，**不搬文件** |
| `set_themes_dir` | `path`（字符串 \| null） | `ThemesDirChangeResult` | 预检失败；复制 / 校验 / 切换 / 重绑注册表 / 写设置任一步失败都会回滚（源目录与设置保持原样），执行中通过 `themes-dir-progress` 事件报阶段 |
| `export_backup` | `destPath` | `ExportBackupSummary` | 目标目录不存在、没有可备份内容、写 zip 失败；`theme.json` 改写成相对路径，无法改写的进 `warnings` |
| `import_backup` | `zipPath` | `ImportBackupSummary` | 不是有效 zip、写盘失败（清掉半成品主题目录）；恢复后按新根重写相对路径，失败项进 `warnings` |

**为什么 `apply_theme` / `export_theme` 收整个 `CursorTheme` 而不是 ID**：系统方案只存在于注册表，没有磁盘目录，但同样有光标文件路径；只传 ID 就到不了它们的文件。

**`export_theme` 的包内清单**：光标文件按槽位重命名（`arrow.cur` / `busy.ani`），另附 `<方案名>.inf`（决策 13，`utils/inf_export.rs` 生成，UTF-16LE + BOM）——接收方没装本软件也能右键安装。导入端只收 `.cur/.ani/.ico` 当光标；`.inf` 由 `utils/inf_parse.rs` 解析槽位映射（决策 15，2026-10-24 起），「导出 → 再导入」闭环不受影响——包内文件本就按槽位命名，`.inf` 映射与文件名推断结果一致。

**设置三来源**（决策 14）：行为类落 `settings.json`（`utils/settings.rs`，Rust 与前端共用，`update_settings` 是补丁语义）；外观三态留 `localStorage`（首帧落色要同步读）；开机自启动的真相在 `HKCU\...\Run`。`import_backup` 是**合并**语义：本地已有主题整套跳过、记录本地优先按主题去重，只补回缺失的。

**槽位路径与迁移**（决策 17）：磁盘上的 `theme.json` 与备份 zip 里只写相对主题目录的路径（`utils/theme_paths.rs`），读盘后由 `resolve_theme` 统一拼绝对路径；旧绝对路径按「主题目录前缀 → 主题 UUID 段 → 主题内唯一同名文件」兼容映射。`set_themes_dir` 不是直接搬目录：目标先 canonicalize 并拒绝 UNC / 重解析点 / 数据目录内部（默认除外）/ 祖先 / 互相嵌套 / 非空目录；内容复制到目标同级 `.cursorstudio-migrate-<uuid>` 暂存区，改写相对路径并逐文件校验（非 `theme.json` 用 FNV-1a 哈希，`theme.json` 校验 ID、槽位键与相对路径可解析）后原子 `rename`；随后重绑注册表、最后写设置，任一步失败反向重绑 + 删新目录回滚，全部成功后才删源目录（删不掉只进 `warnings`）。

---

## 6. 类型契约

前端 `src/types/` 与 `src-tauri/src/models/theme.rs` **逐字段对齐**，字段名共用 `snake_case`（不做驼峰转换）。

| 类型 | 关键字段 | 说明 |
|---|---|---|
| `CursorSlot` | `registry_key`、`display_name`、`english_name`、`file_path`、`file_type` | `file_path` 运行时是绝对路径（直接写注册表）；**落盘到 `theme.json` / 备份 zip 时只存相对主题目录的路径**（决策 17） |
| `CursorTheme` | `id`、`name`、`description`、`created_at`、`updated_at`、`is_built_in`、`cursors` | `id`：`sys_<名>` 或 UUID |
| `ThemesResult` | `themes`、`warnings`、`active_theme_id`、`recent` | 部分成功的载体 |
| `ApplyOutcome` | `recent`、`warning` | 主操作成功就不回滚 |
| `CursorPreview` | `is_animated`、`image`、`frames`、`rate_ms`、`hotspot` | base64 不含 `data:` 前缀 |
| `HistoryEntry` | `theme_id`、`name`、`is_built_in`、`applied_at` | 名称是**快照** |
| `ExportSummary` | `file_count`、`skipped` | 跳过原因给界面提示 |
| `ExportBackupSummary` / `ImportBackupSummary` | 主题/文件/记录计数、`warnings` | 备份恢复是合并语义；路径改写等非致命问题进 `warnings` |
| `ThemesDirPlan` | `source`、`target`、`is_default`、`theme_count`、`file_count`、`total_bytes`、`warnings` | 迁移确认框的数据源，只读不搬 |
| `ThemesDirChangeResult` | `settings`、`report` | `report` 含 `rebound_slots` 与 `warnings` |
| `ThemesDirProgress` | `phase`、`current`、`total`、`message` | `phase` 固定为 copy / verify / switch / registry / settings / cleanup / done |

---

## 7. 关键流程

**启动**：`loadThemes()` → `get_all_themes` → 后端分别读「注册表方案」与「磁盘主题」，任一来源失败只降级为 warning → 磁盘主题的槽位相对路径经 `resolve_theme` 拼成绝对路径 → 拼成一张列表 → 读注册表当前槽位，双向比对反推 `active_theme_id`（读不到就置 `null` 并追加 warning）→ 读 `history.json` → 一次性返回 `ThemesResult`。

**应用**：点「应用此主题」→ `apply_theme(theme)` → 按 `SLOT_DEFS` 写 15 个槽位值 + `SchemeName`（不写 `Schemes`）→ `SPI_SETCURSORS`（只 `SPIF_SENDCHANGE`）→ 追加 `history.json` → 返回最新 `recent` → store 更新 `activeThemeId` + `recent`。

**导入**：对话框选 `.zip`（对话框只收 zip），或把 `.zip` / 整个主题文件夹拖进窗口（Tauri drag-drop 事件给完整路径，前端只拦多件拖入，zip / 文件夹 / 其它文件由后端权威校验，拖入时有全窗遮罩反馈）→ `import_theme`（`importer::import_source` 分发：文件夹直接用，zip 解压到临时目录，两者走同一条落盘流程，决策 16）→ 扫 `.cur/.ani/.ico` → 包里带 `.inf` 时先按说明书映射槽位（决策 15），剩余槽位退回文件名推断 → 落盘 `themes/<uuid>/`（失败时连半成品目录一起清理）→ `theme.json` 只写相对槽位路径（决策 17）→ 返回主题（内存里已 resolve 成绝对路径）→ store 追加并选中。

**迁移主题目录**：设置里选目录 → `preview_themes_dir` 做 canonicalize 与统计，返回源 / 目标 / 主题数 / 文件数 / 体积 / warnings → 确认框展示，确认后锁操作 → `set_themes_dir` 在 `spawn_blocking` 中执行：暂存复制并改写相对路径 → 逐文件校验 → 原子切换 → 重绑注册表槽位 → 写设置 → 删源目录，阶段经 `themes-dir-progress` 推给前端进度条 → 成功刷新设置与主题列表；失败保留对话框，可重试或关闭，源目录与设置不变。

**备份**：导出 `export_backup` 把 `themes/`（每个 `theme.json` 先改写成相对路径）与 `history.json` 打成一个 zip；恢复 `import_backup` 先按合并语义补回缺失主题，再按**新根目录**重写每个新增主题的 `theme.json`，最后返回计数与 warnings。备份包里的旧绝对路径也在这一步落到新根。

**删除**：按钮禁用（使用中/系统方案）→ store 二次拦截 → 后端 `Uuid::parse_str` 校验 → `remove_dir_all`。

---

## 8. 硬约束（改代码前先读）

1. **槽位唯一来源**是 `utils/registry.rs` 的 `SLOT_DEFS`（15 项，顺序固定）。解析系统方案的逗号路径时按位置取，顺序错一项就会整套串位；导入、导出、界面排列也都以它为序。
2. **数据目录唯一来源**是 `utils/paths.rs::data_root()`。任何地方硬编码 `%LOCALAPPDATA%\CursorStudio` 都算 bug。
3. **多来源必须部分成功**：`get_all_themes` 不能因为注册表读不到就让用户主题一起消失。
4. **`active_theme_id` 只从注册表反推**。内存或 localStorage 记的 active 一重启就过期，会让已应用的主题还能再点一次「应用」。
5. **删改类命令必须校验 UUID**：`theme_dir(id)` 是字符串拼接，不校验时传 `../` 就能越出数据目录。
6. **导出包内文件名按槽位重命名**，因为导入端要靠它还原槽位（带 `.inf` 的包按说明书映射，但包内文件按槽位命名时两种来源结果一致）；用源文件名会破坏"导出→再导入"闭环。
7. **重命名只改 `theme.json`**，目录名保持 UUID。
8. **预览不落盘**：单帧最长边 128px、动态光标最多 32 帧，缓存是前端内存 `Map`（按路径去重 + 请求合并）。
9. **不加新依赖**：`@base-ui/react` 已覆盖 toast/dialog/menu/popover，优先手写封装（决策 6）。
10. **`--no-sandbox` 不能删**：本机 WebView2 沙箱初始化失败会表现为"窗口正常但纯白不绘制"（决策 5）。
11. **槽位路径磁盘相对、内存绝对**：`theme.json` 与备份 zip 里出现绝对路径就是 bug；写盘一律走 `theme_paths::to_storage` / `write_theme_json`，读盘一律 `resolve_theme` 后再用于预览/应用/注册表比对。
12. **迁移不直接搬目录**：只走 `utils/themes_dir.rs`，顺序固定为「预检 → 暂存复制 → 内容校验 → 原子切换 → 重绑注册表 → 写设置 → 清理源」。非空目标（尤其含同名主题）必须拒绝且不删任何文件；设置或重绑失败必须回滚到源目录原样。
13. **备份必须可再迁移**：导出与恢复都执行相对路径重写，恢复后路径以**新根目录**为基准；旧备份的绝对路径不得原样留在新 `theme.json` 里。

---

## 9. 未实现 / 已知缺口

> **无**（2026-10-24）：原缺口「文件夹导入」「`.inf` 槽位映射解析」均已实现（决策 16 / 决策 15），现状见 `mouse-theme需求描述.md` §9。
>
> 自制方案与单光标替换**已拍板不做**（决策 10），不在缺口清单里，别当"待排期"重新提。
> 窗口自适应也不是缺口：`tauri.conf.json` 已设 `minWidth: 1080` / `minHeight: 640` 兜底，**仍不做响应式断点**（窄窗下不重排、不收起任何一栏）。

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-06-17 | 初稿：按 4 层前端 / 3 层 Rust / 组件树 / 7 阶段顺序写的提示词稿 |
| 2026-10-22 | v2.0 重写：删掉全篇重复的提示词块；槽位由错误的 14 项改为 `SLOT_DEFS` 的 15 项；技术栈改为 React 19；移除 `sonner` 与"复制到 `C:\Windows\Cursors` 需 UAC"；补命令契约、类型契约、硬约束与未实现清单 |
| 2026-10-22 | 设置模块落地：导航增至四项，新增 `get_data_dir` / `open_data_dir`（决策 11），命令契约 8 → 10，设置页从 §9 缺口清单移除 |
| 2026-10-22 | 决策 12：设置页第二批锚点（诊断信息 / Windows 快捷入口）+ `.zip` 右键菜单试点与单实例转交；命令契约 10 → 15，`services/` 拆出 `system.ts`，只读例外补 `useDiagnostics` |
| 2026-10-23 | 决策 14：设置分组化（通用/快捷键/数据/系统集成/关于），新增设置存储（settings.json）、自启动、托盘关闭行为、主题目录迁移、备份、快捷键、检查更新；命令契约 15 → 22，`services/` 拆出 `settings.ts`，外观三态从侧栏迁入「通用」 |
| 2026-10-25 | 决策 17：槽位路径相对化（磁盘相对 / 运行时绝对），备份导出恢复与改名统一重写；主题目录迁移改为预检 + 暂存 + 校验 + 原子切换 + 回滚，新增 `preview_themes_dir`（命令契约 22 → 23）、迁移确认框与进度事件；命令表与类型契约同步 |
