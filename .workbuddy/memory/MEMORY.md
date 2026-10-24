# 项目长期记忆 — 鼠标光标主题管理工具

## 技术栈
Tauri 2 (Rust) + React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui (base-nova) + zustand

## 范围（决策 10/12，均已拍板）
- 产品 = 主题管理器：导入 → 应用 → 管理 → 回溯。**自制方案 / 单光标替换不做**；槽位卡不可点、无 hover 暗示是产品决定不是欠债
- 主题来源只有两条：系统注册表方案、`.zip` 导入（对话框 + 全窗口拖拽共用一条链路）
- 系统级集成走「先做出来看效果」：`.zip` 右键菜单是**试点**（设置页手动注册/移除 HKCU，零 UAC），真机试后定去留；检查更新无版本源不做
- 决策 13（已合 main）：导出 zip 附带通用 `.inf`（`utils/inf_export.rs`，UTF-16LE+BOM，右键安装）；只收 .cur/.ani 槽位；导入端不解析 inf；**装后命令真机否决已移除**——.inf 安装只注册不生效，生效=接收方选一次方案或注销重登
- 决策 14（2026-10-23，feature/settings 分支）：设置五分组 + 行为设置；**语言切换不做**（仅简体中文，用户候选项唯一砍掉的）；外观三态迁入「设置→通用」（修订决策 11）；检查更新接 GitHub Releases（作废决策 12 的「不做」）

## 文档权威顺序
决策记录 > 需求描述 > 架构设计 > design-system/motion。冲突取前者。
- 不得把未实现写成已支持；改交叉引用必跑 `node scripts/doc_ref_check.mjs`（指空退出码 1）
- **视觉变更要双登记**：`design-system.md` §6 变更记录（版本号递增）+ `motion.md` §8，只改一处必漏
- `AGENTS.md`（小写 agents.md）是注入的速查卡，事实必须与代码一致；15 槽位 / LOCALAPPDATA / 不写 Schemes / 15 命令
- 圆角口径：`sm 6 / md 8 / lg 10（按钮）/ xl 14（卡片）/ 4xl 26（徽章）`

## 踩过的坑（务必遵守）
1. **zustand selector 不能返回新对象**（filter/map/字面量）→ 无限重渲染白屏；派生数据用纯函数 + useMemo
2. **additionalBrowserArgs 只能写在 tauri.conf.json**，环境变量会被 Tauri 覆盖
3. **本机必须 `--no-sandbox`**，否则 WebView2 整窗纯白
4. **SPI_SETCURSORS 只传 SPIF_SENDCHANGE**（带 UPDATEINIFILE 返回 0x80070006）
5. **cargo 联网绕代理**：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy CARGO_HTTP_PROXY="" cargo …`
6. pwsh 7 脚本必须 UTF-8 with BOM；避免反引号续行，用 splatting
7. 碰注册表的测试全局 Mutex 串行 + 防中毒；改用户设置用「备份 + catch_unwind + 恢复」
8. **dev_bg 冷启动首跑脚本会假失败**（vite 首次 dep 优化拖慢加载，nav 全 NOT_FOUND / design 刷新断言超时）——重跑即绿，别当回归查
9. `w!` 宏只吃字面量，常量字符串传 Win32 API 用 `HSTRING`；windows 0.56 的 `FindWindowW` 直接返回 HWND（零值=没找到），CreateMutexW 要 `Win32_Security` feature 才生成

## 关键技术决定
- **多来源部分成功**：`ThemesResult{themes,warnings,active_theme_id,recent}`，来源失败进 warnings；`read_user_themes` 返回 `(themes, warnings)`
- **数据目录** `%LOCALAPPDATA%\CursorStudio\{history.json, pending_import.json, themes/<uuid>/{theme.json, cursors/}}`，唯一来源 `utils/paths.rs::data_root()`，前端禁止自拼
- **槽位推断两段式**：EXACT_NAMES 精确匹配短名（no/ns/we/up）→ SLOT_KEYWORDS 包含匹配；短名进包含匹配会撞 normal/upload
- **15 槽位顺序**以 `utils/registry.rs::SLOT_DEFS` 为准；`.cur/.ico` 自解 ICO 挑最大帧；`.ani` 手写 RIFF 取 LIST/fram，rate 单位 1/60 秒
- **光标路径指向原位置**，不复制进系统目录 → 正在使用的主题不能删（三层防护）
- **单实例 + 右键菜单转交**（决策 12）：CreateMutexW 命名互斥；二实例写 `pending_import.json`→FindWindowW 拉前台→退出；活实例启动+聚焦时 `take_pending_import` 领取（领取即删）。**改窗口标题必须同步 `WINDOW_TITLE`**

## 导航与视图结构（2026-10-23 更新）
- **四项导航 = 三个内容视图 + 设置页**：图库=分组网格 · 我的主题=表格 · 最近使用=时间轴（无检查器）· 设置=五分组管理面板（进设置后侧栏切「返回+分组」，`dependsOnThemes: false`，加载失败也渲染）
- **设置五分组**（`settings-sections.ts` + `SettingsView` 的 Record）：通用=应用主题三态/自启动/关闭行为(退出·托盘)/主题存储目录(可搬迁)/自动检查更新 · 快捷键=Ctrl+1~4/Ctrl+O/Ctrl+F+开关 · 数据=目录+备份(合并恢复)+诊断 · 系统集成=鼠标面板+右键菜单(试点) · 关于=版本/开源/检查更新
- **设置持久化三来源**：行为类 `settings.json`（Rust 也要读，update_settings 补丁语义）· 外观 localStorage（首帧同步读）· 自启动真相在 HKCU Run；托盘按关闭行为动态创建移除，二次启动对隐藏窗先 ShowWindow(SW_RESTORE)
- **22 个命令**：主题 8 + `get_data_dir`/`open_data_dir` + `get_windows_version`/`open_mouse_panel`/`get_zip_menu_registered`/`set_zip_menu`/`take_pending_import` + `get_settings`/`update_settings`/`get_autostart`/`set_autostart`/`set_themes_dir`/`export_backup`/`import_backup`
- 加页面只改两处：`PAGE_META` + `VIEWS`（Record<Page,…> 漏写编译失败）；**加设置分组同规**：`settings-sections.ts` + `SettingsView` 的 `SECTIONS`；选中按页各记 `selection: Partial<Record<Page,string|null>>`
- services/ 拆 theme.ts + system.ts；`useCursorPreview`/`useDiagnostics` 是只读例外（直连 service）
- 检查器 280–560 拖动不落盘；滚动容器一律 `scroll-thin`（6px、拇指 hover 才显）；窗口最小 1080×640，不做响应式
- 外观三态只在 `lib/theme-mode.ts`（落盘 `cursorstudio.theme-mode` + setTheme 同步标题栏），组件零 `dark:` 前缀；**控件在 设置→通用**（侧栏不再放）
- `ThemeList/ThemeCard/ThemeDetail` 已删；侧栏品牌位用 BrandMark（单色指针），别用完整图标

## 设计与动效要点
- token 唯一来源 `src/App.css`；间距 2px 网格、禁 `text-[Npx]`、禁 `transition-all`、动效只写 `duration-(--motion-*)`
- `--ring` 调深到 oklch(0.55) 且焦点环不带 /50（重 add shadcn 组件后要重打）
- 动效四档 `--motion-fast/base/slow/exit` = 120/180/240/160ms；base-ui toast 前插栈顶，FLIP 用 offsetParent+top
- Toast 倒计时条是**读数不是装饰**：时长=toast timeout（内联 `animation-duration`）、必须 `linear` —— §2 硬规则唯一例外；挂起必须和 base-ui 计时器同进退（`data-expanded` + `toaster.tsx` 的窗口焦点镜像），否则"条走完了 toast 还在"
- 验收：`nav_check`（四页结构签名）、`design_check`、`motion_check`（33 项）、`design_audit`；**必须与 dev_bg 同一条命令**

## 组件与流程坑
- vite cacheDir 在 OS 临时目录，**禁止改回 node_modules/.vite**；dev server 只用 `npm run dev:bg`，启动+验证同一条命令
- 改名只改 theme.json 的 name，目录保 UUID，updated_at 不动；草稿用 ref 存（Esc/blur 竞态）
- 导出 zip 包内文件名按槽位命名（导入靠文件名反推）；写文件失败要清半成品
- 删改类命令先 `Uuid::parse_str`；滚动列表首尾留 ≥2px 防 ring 被裁
- 错误文案：中文主句说人话，细节进括号

## 提交拆分
- 一提交一件事；同文件混两件事做 hunk 拆分（中间态二进制读写 → 临时文件放 %TEMP% 绝对路径 → add → 提交 → 恢复终态）
- 每个提交单独 checkout 能过 `tsc --noEmit` + doc_ref_check；提交后核对内容零差异
