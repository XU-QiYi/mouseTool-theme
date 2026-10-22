# 架构设计 · 鼠标光标主题管理工具

**版本**：v2.0
**日期**：2026-10-22

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
│   ├── lib/                        ← pages（页面清单）、slots（槽位统计）、themes（筛选与分组）、toast、cn()
│   └── types/                      ← 与 Rust 结构体逐字段对应
├── src-tauri/
│   ├── tauri.conf.json             ← 窗口/打包配置（含 --no-sandbox，勿删）
│   ├── capabilities/default.json   ← 前端可用的插件权限
│   └── src/
│       ├── commands/               ← cursor.rs / theme.rs：命令层
│       ├── models/theme.rs         ← 数据结构
│       └── utils/
│           ├── paths.rs            ← 数据目录唯一来源
│           ├── registry.rs         ← SLOT_DEFS、注册表读写、SPI 刷新
│           ├── cursor.rs           ← .cur/.ico/.ani 解析与缩放
│           ├── importer.rs         ← zip 导入、槽位推断
│           └── history.rs          ← 最近使用读写
├── scripts/                        ← 无头浏览器验收脚本（设计/动效/交互）
└── docs/
```

**没有 `pages/`，但有一个 `views/`。** 三个页面各是独立视图（网格 / 表格 / 时间轴），共用同一套骨架：`Sidebar` + `PageHeader` + 内容区 +（图库与我的主题才有的）`ThemeInspector`。它们**刻意不复用同一个列表**——复用列表再叠过滤条件，正是"切页看不出变化"的根因。

**加页面只改两处**：`lib/pages.ts` 的 `PAGE_META`（导航文案 / 页头文案 / 搜索框 / 计数口径 / 有无检查器）+ `App.tsx` 的 `VIEWS`（页面 → 视图组件）。`Page` 类型由 `PAGE_META` 的键推导，`Sidebar` / `PageHeader` / `App` 都从这份表取值，不再各自维护一份导航清单；两处都是 `Record<Page, …>`，漏写视图会编译失败而不是运行时白屏。

---

## 3. 前端分层

```
App.tsx
  ├─ Sidebar                    导航（带计数）、导入入口、常驻「当前光标」状态卡、外观三态
  └─ main
       ├─ PageHeader            标题 / 这一页做什么 / 该页搜索 / 计数
       ├─ DataWarning           部分数据源失败时的常驻提示（可关、可重试）
       └─ [data-view=<page>]    当前视图（换页整块淡入）
            ├─ GalleryView      分组网格 → GalleryCard
            ├─ MyThemesView     表格（槽位覆盖率 + 导入时间 + 导出/删除）
            ├─ RecentView       按自然日分组的时间轴
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
2. `services/` 只做"把 command 包成带类型的中文错误"，不写业务判断。
3. store 内统一 `try/catch`，失败弹 Toast，不向组件抛异常。
4. `hooks/useCursorPreview` 是**只读例外**：它直连 service，但只维护自己的内存缓存，不碰全局状态——预览是纯派生数据，塞进 store 会让主题列表的任何变更都触发全量预览重算。

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

## 5. 命令契约（当前共 8 个）

| Command | 入参（前端写法） | 返回 | 失败场景 |
|---|---|---|---|
| `get_all_themes` | — | `ThemesResult` | 只有聚合本身崩溃才 `Err`；单个来源失败走 `warnings` |
| `get_cursor_preview` | `filePath` | `CursorPreview` | **不失败**，解析不出来返回空帧 |
| `import_theme` | `zipPath` | `CursorTheme` | 超过 50MB、无光标文件、认不出槽位、写盘失败 |
| `apply_theme` | `theme`（整个对象） | `ApplyOutcome` | 注册表写失败；历史写失败只进 `warning` |
| `restore_default` | — | `void` | 清空注册表失败 |
| `delete_theme` | `themeId` | `void` | ID 非法、目录不存在、被占用 |
| `rename_theme` | `themeId`, `newName` | `CursorTheme` | 空名、超 40 字、控制字符、json 损坏 |
| `export_theme` | `theme`, `destPath` | `ExportSummary` | 目标目录不存在、写 zip 失败（会清掉半成品） |

**为什么 `apply_theme` / `export_theme` 收整个 `CursorTheme` 而不是 ID**：系统方案只存在于注册表，没有磁盘目录，但同样有光标文件路径；只传 ID 就到不了它们的文件。

---

## 6. 类型契约

前端 `src/types/` 与 `src-tauri/src/models/theme.rs` **逐字段对齐**，字段名共用 `snake_case`（不做驼峰转换）。

| 类型 | 关键字段 | 说明 |
|---|---|---|
| `CursorSlot` | `registry_key`、`display_name`、`english_name`、`file_path`、`file_type` | `file_path` 是绝对路径，直接写进注册表 |
| `CursorTheme` | `id`、`name`、`description`、`created_at`、`updated_at`、`is_built_in`、`cursors` | `id`：`sys_<名>` 或 UUID |
| `ThemesResult` | `themes`、`warnings`、`active_theme_id`、`recent` | 部分成功的载体 |
| `ApplyOutcome` | `recent`、`warning` | 主操作成功就不回滚 |
| `CursorPreview` | `is_animated`、`image`、`frames`、`rate_ms`、`hotspot` | base64 不含 `data:` 前缀 |
| `HistoryEntry` | `theme_id`、`name`、`is_built_in`、`applied_at` | 名称是**快照** |
| `ExportSummary` | `file_count`、`skipped` | 跳过原因给界面提示 |

---

## 7. 关键流程

**启动**：`loadThemes()` → `get_all_themes` → 后端分别读「注册表方案」与「磁盘主题」，任一来源失败只降级为 warning → 拼成一张列表 → 读注册表当前槽位，双向比对反推 `active_theme_id`（读不到就置 `null` 并追加 warning）→ 读 `history.json` → 一次性返回 `ThemesResult`。

**应用**：点「应用此主题」→ `apply_theme(theme)` → 按 `SLOT_DEFS` 写 15 个槽位值 + `SchemeName`（不写 `Schemes`）→ `SPI_SETCURSORS`（只 `SPIF_SENDCHANGE`）→ 追加 `history.json` → 返回最新 `recent` → store 更新 `activeThemeId` + `recent`。

**导入**：对话框选 `.zip` 或拖入窗口任意位置（Tauri drag-drop 事件给路径，前端只做数量/扩展名校验，拖入时有全窗遮罩反馈）→ `import_theme` → 解压到临时目录 → 扫 `.cur/.ani` → 文件名推断槽位 → 落盘 `themes/<uuid>/`（失败时连半成品目录一起清理）→ 返回主题 → store 追加并选中。

**删除**：按钮禁用（使用中/系统方案）→ store 二次拦截 → 后端 `Uuid::parse_str` 校验 → `remove_dir_all`。

---

## 8. 硬约束（改代码前先读）

1. **槽位唯一来源**是 `utils/registry.rs` 的 `SLOT_DEFS`（15 项，顺序固定）。解析系统方案的逗号路径时按位置取，顺序错一项就会整套串位；导入、导出、界面排列也都以它为序。
2. **数据目录唯一来源**是 `utils/paths.rs::data_root()`。任何地方硬编码 `%LOCALAPPDATA%\CursorStudio` 都算 bug。
3. **多来源必须部分成功**：`get_all_themes` 不能因为注册表读不到就让用户主题一起消失。
4. **`active_theme_id` 只从注册表反推**。内存或 localStorage 记的 active 一重启就过期，会让已应用的主题还能再点一次「应用」。
5. **删改类命令必须校验 UUID**：`theme_dir(id)` 是字符串拼接，不校验时传 `../` 就能越出数据目录。
6. **导出包内文件名按槽位重命名**，因为导入端靠文件名反推槽位；用源文件名会破坏"导出→再导入"闭环。
7. **重命名只改 `theme.json`**，目录名保持 UUID。
8. **预览不落盘**：单帧最长边 128px、动态光标最多 32 帧，缓存是前端内存 `Map`（按路径去重 + 请求合并）。
9. **不加新依赖**：`@base-ui/react` 已覆盖 toast/dialog/menu/popover，优先手写封装（决策 6）。
10. **`--no-sandbox` 不能删**：本机 WebView2 沙箱初始化失败会表现为"窗口正常但纯白不绘制"（决策 5）。

---

## 9. 未实现 / 已知缺口

| 项 | 当前状态 |
|---|---|
| 文件夹导入 | `import_theme` 只吃 `.zip` 路径（拖拽与对话框一致） |
| `.inf` 槽位映射解析 | 只有文件名推断 |
| 设置页 / 打开数据目录 | 侧栏「设置」是 `disabled` 占位（决策 1 的补偿项尚未落地） |

> 自制方案与单光标替换**已拍板不做**（决策 10），不在缺口清单里，别当"待排期"重新提。
> 窗口自适应也不是缺口：`tauri.conf.json` 已设 `minWidth: 1080` / `minHeight: 640` 兜底，**仍不做响应式断点**（窄窗下不重排、不收起任何一栏）。
> 表内这些缺口在 `mouse-theme需求描述.md` §9 有对应的"开工前要先定什么"，别在文档里写成"已支持"。

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-06-17 | 初稿：按 4 层前端 / 3 层 Rust / 组件树 / 7 阶段顺序写的提示词稿 |
| 2026-10-22 | v2.0 重写：删掉全篇重复的提示词块；槽位由错误的 14 项改为 `SLOT_DEFS` 的 15 项；技术栈改为 React 19；移除 `sonner` 与"复制到 `C:\Windows\Cursors` 需 UAC"；补命令契约、类型契约、硬约束与未实现清单 |
