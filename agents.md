# Agents — 鼠标光标主题管理工具

> 给 AI 的**速查卡**，不是需求文档。详细内容都在 `docs/`，这里只留"容易踩错、必须马上知道"的。
> 原则：**事实以代码为准**。本文件与代码不一致时改本文件，不要改代码迁就文档；更不要把没实现的东西写成已支持。

**技术栈**：Tauri 2 + React 19 + TypeScript + Vite 7 + Tailwind 4 + shadcn/ui（base-nova / `@base-ui/react`）+ zustand 5 + Rust。
**现状**：功能已跑通，30 个 Tauri 命令全部实现并注册；除纯路径计算的 `get_data_dir` 外，I/O 命令都是 `async` + `spawn_blocking`。不是脚手架（没有 `greet` 示例）。

## 先读哪份（冲突时从上往下取）

| 顺序 | 文件 | 管什么 |
|---|---|---|
| 1 | `docs/mouse-theme决策记录.md` | 已拍板的决定，最高权威 |
| 2 | `docs/mouse-theme需求描述.md` | 范围与边界；§8 作废项、§9 未实现 |
| 3 | `docs/mouse-theme架构设计.md` | 目录、命令契约 §5、类型契约 §6、硬约束 §8 |
| 4 | `docs/design-system.md` / `docs/motion.md` | 视觉 token、动效 |

---

## 职责边界（同一仓库，不是独立进程）

- **Frontend**（`src/`）：骨架（侧栏 + 页头）+ 四个独立视图（含设置）+ 右侧检查器。组件不直接 `invoke`，走 store action；`services/`（`theme.ts` / `system.ts` / `settings.ts`）是唯一 invoke 出口（非 Tauri 环境降级 mock）。
- **Backend**（`src-tauri/src/commands/`）：命令编排，错误一律 `Result<T, String>` 且是**用户能照着行动**的中文。所有 I/O 走 `spawn_blocking`；导入 / 备份 / 迁移，以及删除主题 / 恢复 / 彻底删除 / 清空回收站，取 `utils/ops.rs` 的 `try_begin` 互斥锁并发 `*-progress` 事件（决策 19/26）。前端传来的结构先过 `utils/validation.rs`（槽位白名单、路径包含、`dest_path`、`theme.id`），归档读取只走 `utils/limits.rs`（决策 18）。
- **Theme**（`utils/importer.rs`、`utils/inf_parse.rs`、`utils/paths.rs`、`utils/theme_paths.rs`）：zip / 文件夹导入、槽位映射、落盘。**收 `.zip` 与整个主题文件夹两个入口共用同一条链路**（`importer::import_source` 分发，决策 16；侧栏对话框只收 `.zip`，拖拽两种都收）；包内带 `.inf` 时槽位按说明书映射、优先于文件名推断，没带或解析失败才退回文件名推断（`inf_parse.rs`，决策 15）。导出 zip 附带通用 `.inf` 安装文件（`utils/inf_export.rs`，决策 13），接收方右键即可安装。**磁盘上的 `theme.json` 只存相对主题目录的槽位路径**（`cursors/arrow.cur`），运行时统一由 `theme_paths::resolve_theme` 拼绝对路径；旧绝对路径兼容读取，备份导出/恢复也走同一套相对化（决策 17）。主题存储目录可换（`utils/themes_dir.rs`）：暂存复制 + 内容校验 + 原子切换 + 失败回滚，详见硬约束 18。
- **Trash**（`utils/trash.rs`）：删除即软删除，整目录移入数据根 `trash\<条目 UUID>\` 并写 `.trash.json` 快照（决策 26）。**条目 ID 与主题 ID 分开**：同一主题可删多次、删完恢复再删也不撞目录；恢复前复核快照 / `theme.json` / 目标目录；上限 20 套或 512 MB，超限按删除时间自动清最早；跨盘 `rename` 失败走复制 + 文件数与字节数校验 + 删源。`trash\` 不参与主题列表、备份与目录迁移。
- **Cursor**（`utils/cursor.rs`）：`.cur`/`.ico`/`.ani` 解码。自解 ICO 目录挑最大帧、手写 RIFF 取 `LIST/fram`；**不转 GIF**。
- **Registry**（`utils/registry.rs`）：HKCU 读写 + `SPI_SETCURSORS`。
- **行为设置**（`utils/settings.rs` / `tray.rs` / `autostart.rs`）：`settings.json` 存关闭行为/主题目录/开关/自动切换映射（Rust 与前端共用）；关闭到托盘时托盘图标动态创建移除；自启动写 `HKCU\...\Run`。外观三态留 `localStorage`（`lib/theme-mode.ts`，首帧落色要同步读）。跟随系统深浅色自动切换主题的**切换逻辑在前端** `lib/auto-switch.ts`（决策 25）：主题 ID 补丁用**空串表示清空**（serde_json 分不清 null 与缺省）。
- **系统集成**（`utils/integration.rs`）：单实例互斥（`CreateMutexW`）、`--import` 转交（`pending_import.json`，领取即删）、`.zip` 右键菜单注册（试点，决策 12）。**窗口激活按标题查找**——改窗口标题必须同步 `WINDOW_TITLE` 常量。
- **Integration**（`models/` ↔ `types/`、`capabilities/`）：前后端字段逐个同名，共用 `snake_case`，不做驼峰转换。
- **安装器**（`src-tauri/installer/` + `tauri.conf.json` 的 `bundle` 段）：NSIS 走**整窗自绘模板** `installer/template/installer.nsi`（设计源 `docs/安装器原型/setup-ui-prototype.html`：欢迎 / 已安装维护 / 安装选项 / 进度 / 完成五页；常驻侧栏步骤高亮、自绘页脚、品牌渐变进度）。UI 位图由 `installer/src/make_ui_assets.ps1`（`npm run installer:assets`）生成到 `installer/ui`（通用图 1x/2x，按钮与进度填充另出 125/150/175/200%），模板在 MUI 的 `MUI_CUSTOMFUNCTION_GUIINIT` 钩子里 `File /r` 解到 `$PLUGINSDIR` 下的 `ui` 目录。**`installer/ui` 已 .gitignore、不入库**（侧栏把版本号烘进了位图，入库会在升版本时留下旧图）：打包前先 `npm run installer:assets`，缺文件 makensis 会直接报错、不会静默用旧图；`npm run installer:build` = 生成资源 + `tauri build --bundles nsis`。颜色只能给 `SetCtlColors` 传**十六进制字面量**（经变量或十进制都会被按十六进制误解析，偏色甚至整页黑）；**NSIS 的 `;` 是注释，命令必须逐行写**。可点卡片/文字/圆点必须用 `nsDialogs::CreateControl` 创建（raw `CreateWindowEx` 的 ID 0 控件挂不上 `${NSD_OnClick}`），卡片文字还要带 `SS_NOTIFY`；原生单选/勾选做成 20×20 完全压在自绘圆点下（缩到 1px 会露出系统蓝边），只负责状态/键盘/自动化；焦点环位图 32×32、离圆点 2px。进度页复用原生 InstFiles 页对话框当画布（控件在 `Section UiBuild` 里建，show 回调时页面对话框还没创建）；**InstFiles 对话框不认控件首帧的 `SetCtlColors` 背景**（文字变黑、深色底变白块），自绘控件建完必须 `RedrawWindow` 整树重绘一次；完成页的“完成”要 PostMessage 原生 Close 按钮的 `BM_CLICK`，直接 `WM_COMMAND` 不关窗。截图 QA 用置顶 + 24bpp 屏幕拷贝（`PrintWindow` 对位图页会丢 alpha 截成黑块）。改许可文本跑 `make_license_rtf.mjs`；QA 脚本 `capture_setup_window.ps1` / `walkthrough_capture.ps1` / `verify_install_cycle.ps1`。容易踩的：许可页按原型裁掉了（MIT 全文靠 `bundle.resources` 的 `LICENSE.txt` 进安装目录）；主程序名是 Cargo 包名 `mousetool-theme` 不是 productName；自启动注册表值名是 **`CursorStudio`**（`autostart.rs` 的 `RUN_NAME`，安装器与卸载器都写/删这个值）；模板里 `System::Call` 不求值 `|` 表达式（先 IntOp）且 `LoadImage` 在 **user32**；makensis 工作目录是 `target/release/nsis/x64`（模板里的相对 `File` 路径按四级上级算）；bundler 会自己给模板加 UTF-8 BOM（模板文件本身不要带）。MSI 需 `wix.language: "zh-CN"` 才能装下中文 productName。安装器另有两个坑：Edit 的路径初值必须等页面显示后的首帧再 `WM_SETTEXT`（创建阶段写进去不绘制）；步骤文字底色不能用 `-1` 透明（STATIC 会画成白块），品牌色块按原型做成 220×220、只露右下角，避开步骤文字。改 `installer/` 会让 `tauri dev` 重启调试窗口，`src-tauri/.taurignore` 已忽略该目录（重启 dev 后生效）。

---

## 三个内容视图 + 设置（别合并回一张列表）

| 导航 | 视图 | 回答的问题 | 检查器 |
|---|---|---|---|
| 主题图库 | 分组网格（系统方案 / 我的主题 两段） | 挑哪个？ | 有 |
| 我的主题 | 数据表（槽位覆盖 / 导入于 / 导出·删除） | 我导入了什么、要清理哪个？ | 有 |
| 最近使用 | 按自然日分组的时间轴 | 上次用的是哪个？ | **没有** |
| 设置 | 五个分组（通用/快捷键/数据/系统集成/关于），侧栏切成分组导航 | 行为怎么配、数据在哪、怎么自查？ | **没有** |

- 前三页是**内容三视图**，互不重叠；设置页是**管理面板**（行为设置 + 维护锚点），不是第四个列表页。
- 三页的选中项**各记一份**：`selection: Partial<Record<Page, string | null>>`。切页回来还是原来的上下文，又不会把别的页的选择带过来；页面上不写这个键就等于没有选中（比如将来的市场页，选中的是远程条目，不是本地主题）。设置页没有选中概念，不写这个键。
- 切页只清搜索词，不清选中；重载只清「已经不存在的主题」，不清还在列表里的。
- **诊断与批量导入是任务层弹窗、备份历史与回收站是「数据」子页，都不是第五个页面**（决策 23/26）：不进 `PAGE_META` / `VIEWS`，不加导航、不加设置分组。单文件导入（侧栏按钮 / Ctrl+O / 拖 1 个）保持原链路不动；拖 2–20 个进 `importStore` 队列，串行执行、失败可单独重试。
- **加页面只改两处**：`lib/pages.ts` 的 `PAGE_META` 加一条（导航文案/页头文案/搜索框/计数口径/有无检查器）+ `App.tsx` 的 `VIEWS` 加一行视图组件。两处都是 `Record<Page, …>`，漏了编译不过 —— 加了页面却忘了视图分支导致中间区域白屏的坑已经堵上。**加设置分组同规**：`lib/settings-sections.ts` + `SettingsView.tsx` 的 `SECTIONS`。
- **设置页 `dependsOnThemes: false`**：整体读取失败时照常渲染——「打开数据目录」正是加载失败时的排查入口，不能被 LoadErrorState 顶掉。
- **设置五分组**（决策 14）：通用 = 应用主题三态（从侧栏迁入）/ 跟随系统切换主题（浅/深配对，决策 25）/ 开机自启动 / 关闭行为（直接退出·最小化到托盘）/ 主题存储目录 / 自动检查更新；快捷键 = 应用内快捷键一览 + 开关；数据 = 数据目录 + 数据备份（导出/合并恢复）+ 回收站（恢复 / 彻底删除 / 清空，决策 26）+ 诊断信息；系统集成 = 鼠标属性面板直达 + 右键菜单开关（试点）；关于 = 版本 / 开源地址 / 检查更新（GitHub Releases）。进设置后侧栏整体切成「返回 + 分组」，页头跟随分组标题。
- 「主题图库」包含「我的主题」的集合——重复是**任务不同**（逛 vs 管），不是数据不同；别为了去重把两页合成一个列表加过滤条件，那正是重构前的毛病。
- 改名只做在 `ThemeNameField` 一处（检查器头部）；表格行内的操作只有导出与删除。槽位统计口径在 `lib/slots.ts`（`SYSTEM_SLOT_TOTAL = 15` 是 `SLOT_DEFS` 的镜像，后端改槽位必须同步改它）。

---

## 三个高频记错点

**① 槽位 15 个，顺序固定**
唯一来源 `utils/registry.rs::SLOT_DEFS`，完整表见决策记录「决策 3」。键名别照系统设置里的显示名猜：是 `Crosshair`（不是 Cross），另有 `NWPen`、`UpArrow`。短名（`no` / `ns` / `we` / `up`）只能做**精确匹配**，放进包含匹配会撞 `normal`、`upload`。

**② 30 个命令**
主题类 `get_all_themes` / `get_active_state` / `get_cursor_preview` / `import_theme` / `apply_theme` / `restore_default` / `delete_theme` / `rename_theme` / `export_theme`；回收站 `list_trash` / `restore_from_trash` / `delete_from_trash` / `empty_trash`；数据与系统类 `get_data_dir` / `open_data_dir` / `get_windows_version` / `open_mouse_panel` / `get_zip_menu_registered` / `set_zip_menu` / `take_pending_import`；设置类 `get_settings` / `update_settings` / `get_autostart` / `set_autostart` / `preview_themes_dir` / `set_themes_dir` / `export_backup` / `import_backup` / `list_backups` / `delete_backup`。契约见架构设计 §5。几条容易记错：
- `apply_theme` / `export_theme` 收**整个 `CursorTheme`**，不是 ID——系统方案只存在于注册表，没有磁盘目录，只给 ID 拿不到它的文件。
- `import_theme` 收 `sourcePath`（**zip 或整个主题文件夹**，决策 16，后端权威校验），返回 `{ theme, warnings }`——目录里的链接 / 目录联接会被跳过并说明原因；包内带 `.inf` 时槽位按说明书映射、**优先于文件名推断**，没带或解析失败退回文件名推断、不缺槽位（决策 15，`utils/inf_parse.rs`），`.inf` 与光标文件共用 `ScanBudget`。
- `get_active_state` 是聚焦用的轻量重查（决策 24）：只读注册表 + 主题清单比对，不读历史、不取 `ops` 锁；失败直接 `Err`，前端静默保留旧状态。`get_all_themes` 的 `ThemesResult` 相应多出 `current_slots_filled` / `active_external`（槽位非空但匹配不到任何主题 = 被系统设置改写）。
- 没有 `list_themes`（是 `get_all_themes`）；没有 `create_custom_theme`（未实现）。
- `delete_theme` 是**软删除**（决策 26）：整目录移入 `trash\`，返回 `{ auto_purged, warning }`；回收站上限 20 套 / 512 MB，超出自动清最早。`restore_from_trash` 会复核快照 / `theme.json` / 目标目录（同 ID 已存在就拒绝），`delete_from_trash` / `empty_trash` 才真正删文件；损坏条目列出但不可恢复。`list_trash` 返回条目 + 限额，前端不硬编码。
- `export_backup` 的 `destPath` 可空：空 = 写入数据目录 backups 目录自动命名（进「备份历史」），传路径 = 导出到任意位置（不受历史管理）；返回含 `saved_path` / `bytes`。`list_backups` 只读 zip 中央目录列应用内备份（时间倒序、上限 200），`delete_backup` 只收文件名、拒绝越出备份目录。
- `get_data_dir` 只读不建目录；`open_data_dir` 才 `ensure_dir` + 调 opener。前端**禁止**用 `localDataDir()` 自己拼 `CursorStudio`（硬约束 1）。
- `take_pending_import` 领取即删除（右键菜单 `--import` 转交通路），App 在启动与聚焦两个时机调用；`take_pending_import` 损坏返回 null 不报错。
- `update_settings` 是**补丁语义**（只传要改的字段）；关闭行为变更会同步托盘有无。`preview_themes_dir` 只校验与统计、不碰文件；`set_themes_dir` 返回 `{ settings, report }`，执行中通过 `themes-dir-progress` 事件报阶段，整体成功前不改设置；`import_backup` 是合并恢复，不覆盖已有。
- 除纯路径计算的 `get_data_dir` 外，所有命令都是 `async` + `spawn_blocking`；`import_theme` / `export_backup` / `import_backup` / `set_themes_dir` / 删除主题 / 回收站恢复 / 彻底删除 / 清空额外取 `ops::try_begin` 锁，并分别发 `import-progress` / `backup-progress` / `themes-dir-progress`。第二个重操作会立刻失败，不要改成排队。

**③ 注册表写入范围**
只写 `Cursors` 下 15 个槽位值 + `SchemeName`（+ 键默认值），未提供的槽位写**空字符串**；「还原默认」会顺带清空 Win11 新指针键 `Pin` / `Person` 的残留（值已存在才清，不凭空创建，决策 24）。**不写** `Cursors\Schemes`（那是系统"已保存方案"列表，写进去会让用户的下拉框多出条目；经典面板对本应用主题恒显「(无)」就是这个原因，别当 bug 修）。光标文件留在 `%LOCALAPPDATA%` 原地，**不复制进 `C:\Windows\Cursors`**。

---

## 硬约束（违反会出事故）

1. 数据目录只认 `utils/paths.rs::data_root()`，禁止别处硬编码。
2. `SPI_SETCURSORS` **只传 `SPIF_SENDCHANGE`**；带 `SPIF_UPDATEINIFILE` 本机返回 `0x80070006`，刷新直接失败。
3. `--no-sandbox` 不能从 `tauri.conf.json` 删：本机 WebView2 沙箱初始化失败会整窗纯白；Tauri 会覆盖同名环境变量，只能改 JSON。
4. 「正在使用」只从注册表反推（`active_theme_id`），不存内存 / localStorage。
5. 导出 zip 的文件名**按槽位命名**（导入端先看 `.inf` 映射、没有再靠文件名反推槽位；两种来源结果一致，否则"导出→再导入"必丢槽位）。
6. 重命名只改 `theme.json`，目录名保持 UUID；`updated_at` 不动（界面当"导入于"用）。
7. 删改类命令必须先 `Uuid::parse_str` 校验——`theme_dir(id)` 是字符串拼接，传 `../` 能越出数据目录。
8. 多来源必须部分成功：注册表读不到不能让用户主题一起消失，失败进 `warnings`。
9. **不加新依赖**；Toast/浮层用 `@base-ui/react` 自封装，不引 sonner / radix。
10. 动效只写 `duration-(--motion-*)` + `ease-standard/ease-exit`，禁裸数字时长、禁 `transition-all`。**唯一例外 Toast 倒计时条**：时长=toast timeout（内联注入）、缓动必须 `linear` —— 它是剩余时间的读数，改缓动=读数失真（详见 motion.md §2）。
11. zustand selector **不能返回新对象**（`filter`/`map`/字面量）→ 无限重渲染白屏；派生数据用纯函数 + `useMemo`。
12. 后台起 dev server 只用 `npm run dev:bg`，且**启动与验证写进同一条命令**；禁止 `npm run dev | head`（管道一关 EPIPE 直接杀死 vite）。
13. 可滚动容器一律加 `scroll-thin`：6px、轨道透明、拇指**平时完全隐形**、指针进入容器才浮出（`::-webkit-scrollbar`）。**别用 `scrollbar-width: thin`**——Chromium 里它仍走经典样式（带箭头、常显），在 320px 面板里会被当成进度条；也别自绘轨道或改滚动手感。
14. 检查器宽度由 `InspectorResizer` 拖动（280–560、双击复位、`←/→` 16px），**只在会话内有效、不落盘**：面板宽度是"此刻怎么摆"，存下来会在改了默认值后留下一个没人维护的旧数字。
15. `minWidth: 1080` / `minHeight: 640` 别从 `tauri.conf.json` 删：侧栏 224 + 检查器最小 280 + 正文 440，窄于此三栏会互相挤压（`design_check` 会断言这两个值）。
16. 外观三态（跟随系统 / 浅色 / 深色）只由 `lib/theme-mode.ts` 管：`html.dark` + 落盘 `cursorstudio.theme-mode` + `setTheme` 同步标题栏。**组件里不写 `dark:` 前缀**，颜色全走 token；手选浅/深后不再跟系统，选回「跟随系统」才恢复。控件在「设置 → 通用」（决策 14，已从侧栏迁走）；改这段先看 `design_check` 的 18 条断言。
17. 设置的持久化分三处，别做大一统：行为类 `settings.json`（Rust 也要读：关闭行为、主题目录、开关）、外观 `localStorage`（首帧同步读）、自启动 `HKCU\...\Run`（注册表即真相）。
18. 主题槽位路径**磁盘存相对、运行时用绝对**：`theme.json` / 备份 zip 里只准出现相对主题目录的路径（`utils/theme_paths.rs` 的 `to_storage` / `write_theme_json`），读盘后必须 `resolve_theme` 再交给预览/应用。主题目录迁移只走 `utils/themes_dir.rs`：目标先 canonicalize，拒绝 UNC / 重解析点 / 数据目录内部（默认除外）/ 祖先 / 互相嵌套 / 非空目录（含同名主题）；内容先写同级 `.cursorstudio-migrate-<uuid>` 暂存区、逐文件哈希校验后原子改名；注册表重绑或设置写入失败必须回滚，源目录只在全部成功后删除。
19. 归档与文本读取只走 `utils/limits.rs`：主题包 `THEME_LIMITS`（50MB / 单文件 20MB / 512 条目 / 8 层）、备份 `BACKUP_LIMITS`（1GiB / 64MB / 4096 / 10 层）共用 `ArchiveBudget`、`copy_bounded`（64KB 流式）、`safe_relative_parts`；文件夹导入用 `ScanBudget`，`.inf` 也占同一份额度；备份恢复第一遍必须先按条目声明大小做整包预检。所有 JSON 文本读走 `read_text_bounded`（`theme.json` 1MB，`settings.json` / `history.json` 512KB）；编码不定的 `.inf` 走 `read_bytes_bounded`（1MB）后直接交给 `inf_parse`，禁止先按 UTF-8 解码。禁止 `fs::read_to_string`。目录遍历一律用 `is_reparse_entry` 跳过 symlink / junction / 其它重解析点并 warning。**禁止一次性读整个条目**，超限必须清理解压临时目录与半成品主题目录。预览源文件 8MB、光标文件 20MB 上限同理。
20. 前端传来的 `CursorTheme` / 路径一律视为不可信：槽位必须命中 15 个白名单、`theme.id` 必须是规范 UUID 且等于目录名与 `theme.json` 里的 id；用户主题的光标 canonicalize 后必须落在**这套主题自己的目录**内（系统方案才允许任意目录，预览路径允许主题根目录或系统光标目录）；`dest_path` 父目录存在且后缀正确。校验只在 `utils/validation.rs` 做，别在组件里复制。
21. 重操作必须后台 + 互斥：导入、备份导出 / 恢复、主题目录迁移、删除主题 / 回收站恢复 / 彻底删除 / 清空都要 `spawn_blocking` + `ops::try_begin`（`try_lock` 立即失败，不排队）+ 阶段进度事件；`spawn_blocking` 的 JoinError 也要转成中文错误，不能 `.unwrap()`。
22. 前端安全基线：`main.tsx` 必须保留 `ErrorBoundary`；外链只走 `lib/open-external.ts` 的 `https://github.com` 白名单；检查更新必须 8 秒超时；busy 按 `动作:ID` 记且 `finally` 释放；导出默认文件名必须过 `sanitizeFileName`（Windows 非法字符 / 保留名）。
23. 无障碍基线：标题 `h1 → h2 → h3` 不跳级；`Segmented` 保持 radiogroup + roving tabindex（方向键 / Home / End）；`.ani` 播放必须响应 `prefers-reduced-motion`（降级画一帧）；装饰性预览图 `alt=""`；时间用 `<time dateTime>`。
24. 测试**不碰真实环境**：数据根用 `paths::use_test_roots` 指向临时目录，注册表测试用 `TEST_CURSORS_KEY`（`Software\CursorStudio.Tests\...`，结束删除），光标用 `test_support` 生成 fixture；注册表用例仍全局串行。CI 五道闸 `build` / `cargo test` / `clippy -D warnings` / `design_audit` / `doc_ref_check` 不得删减（clippy 警告基线为零，新警告直接拦下）。
25. CSP 与 capability 别放宽：生产 `csp` 只放行 `self` / `data:` / `blob:` / asset / `https://api.github.com`，Vite HMR 的 `ws://localhost:1420/1421` 与 inline/eval 只写在 `devCsp`；opener 只给 `opener:allow-open-url` + `https://github.com/*`，dialog 只给 `allow-open` / `allow-save`。**不要恢复 `csp: null`、`opener:default`、`dialog:default`，也不要删 `--no-sandbox`**（决策 22、硬约束 3）。
26. 回收站与主题库分开：条目目录名是**回收站条目 UUID**（不是主题 ID），命令只收规范 UUID；恢复前复核快照、`theme.json` 与当前主题目录；`trash\` 不参与主题扫描、备份与迁移（决策 26）。

---

## 未实现（别写成已支持）

| 项 | 现状 |
|---|---|
| （当前无缺口） | 原「文件夹导入」「`.inf` 槽位映射」已实现（决策 15/16），别再当未实现 |

**已拍板不做**（决策 10，别当"待排期"重新提）：自制方案（逐槽位上图）、单光标替换。槽位卡保持纯展示、不可点、不做 hover 暗示 —— 这是产品决定，不是没做完。

**窗口不是缺口**：`minWidth: 1080` / `minHeight: 640` 兜底，仍**不做响应式断点**（窄窗下不重排、不收起任何一栏）。

---

## 改完怎么验

```powershell
npm run build              # tsc + vite，类型错会拦下
cd src-tauri; cargo check  # 后端快速反馈
cargo test                 # 单元测试；数据根与注册表都已隔离，不碰真实光标（决策 21）
```

cargo 拉包被系统代理挡住时（本机 Clash 常关）：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy CARGO_HTTP_PROXY="" cargo test
```

界面/动效脚本跑在浏览器里、走 mock，不写系统光标；**必须与 dev server 同一条命令**：

```powershell
node scripts/dev_bg.mjs start; node scripts/nav_check.mjs; node scripts/design_check.mjs; node scripts/motion_check.mjs; node scripts/migration_check.mjs; node scripts/recent_check.mjs; node scripts/ui_check.mjs; node scripts/dnd_check.mjs; node scripts/future_check.mjs; node scripts/auto_switch_check.mjs; node scripts/trash_check.mjs; node scripts/dev_bg.mjs stop
```

`design_audit.mjs` / `ui_ratio.mjs` 只扫源码；`nav_check` / `design_check` / `recent_check` / `ui_check` / `dnd_check` / `migration_check` / `future_check` / `auto_switch_check` / `trash_check` 走交互链路。`future_check` 验收三个维护界面：诊断中心（设置 → 数据 → 运行诊断）、备份历史（mock 至少 2 行、往返切换）、导入中心（`__importStore.enqueue` 两条 → 串行成功 → 主题数 +2）。`trash_check` 验收回收站：删除 → 条目出现 → 恢复回列表 → 彻底删除 → 清空 → 损坏条目禁用恢复（`?mock-trash-damaged`）。`migration_check` 用浏览器 mock 注入预检失败与设置写入失败（`?mock-migrate-error` / `?mock-migrate-fail=settings`），断言确认框信息、执行期锁、进度、失败回滚与恢复默认。`nav_check` 逐页断言**结构签名**（网格 / 表格 / 时间轴 / 设置面板、有无检查器与搜索框），页面间同构会直接失败——这是防止"切页看不出变化"回潮的那道闸。
碰注册表的测试只写隔离键（`Software\CursorStudio.Tests\...`；自启动 / 右键菜单用各自的 `TEST_KEY`），数据根指向临时目录，不备份 / 还原用户设置；隔离键让用例可以并行，只有共享同一个键的用例才需自行串行（防中毒取回锁：`unwrap_or_else(|e| e.into_inner())`）。

动了文档、尤其是本文件的 `§x` / `决策 N` 引用，跑 `node scripts/doc_ref_check.mjs`：指空会列出 `文件:行号` 并以退出码 1 失败（不需要 dev server）。`node scripts/design_audit.mjs` 发现违规同样以退出码 1 失败。

CI 在 `.github/workflows/ci.yml`：`windows-latest` 上跑 `npm ci` → `npm run build` → `cargo test` → `cargo clippy --all-targets -- -D warnings` → `design_audit` → `doc_ref_check`。

---

## 其余口径

Windows 10/11 x64；全程无 UAC；应用主题 < 500ms；预览单帧最长边 128px、最多 32 帧；数据在 `%LOCALAPPDATA%\CursorStudio\`（`themes/` + `trash/` 回收站 + `history.json` + `backups/` 应用内备份），卸载不删；主题包 50MB / 备份 1GiB 上限，预览源文件 8MB；仅简体中文，不做多语言。
