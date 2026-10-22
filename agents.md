# Agents — 鼠标光标主题管理工具

> 给 AI 的**速查卡**，不是需求文档。详细内容都在 `docs/`，这里只留"容易踩错、必须马上知道"的。
> 原则：**事实以代码为准**。本文件与代码不一致时改本文件，不要改代码迁就文档；更不要把没实现的东西写成已支持。

**技术栈**：Tauri 2 + React 19 + TypeScript + Vite 7 + Tailwind 4 + shadcn/ui（base-nova / `@base-ui/react`）+ zustand 5 + Rust。
**现状**：功能已跑通，8 个 Tauri 命令全部实现并注册，不是脚手架（没有 `greet` 示例）。

## 先读哪份（冲突时从上往下取）

| 顺序 | 文件 | 管什么 |
|---|---|---|
| 1 | `docs/mouse-theme决策记录.md` | 已拍板的决定，最高权威 |
| 2 | `docs/mouse-theme需求描述.md` | 范围与边界；§8 作废项、§9 未实现 |
| 3 | `docs/mouse-theme架构设计.md` | 目录、命令契约 §5、类型契约 §6、硬约束 §8 |
| 4 | `docs/design-system.md` / `docs/motion.md` | 视觉 token、动效 |

---

## 职责边界（同一仓库，不是独立进程）

- **Frontend**（`src/`）：骨架（侧栏 + 页头）+ 三个独立视图 + 右侧检查器。组件不直接 `invoke`，走 store action；`services/theme.ts` 是唯一 invoke 出口（非 Tauri 环境降级 `mock.ts`）。
- **Backend**（`src-tauri/src/commands/`）：命令编排，错误一律 `Result<T, String>` 且是**用户能照着行动**的中文。
- **Theme**（`utils/importer.rs`、`utils/paths.rs`）：zip 导入、槽位推断、落盘。**仅 `.zip`**，无文件夹导入、无 `.inf` 解析、无拖拽。
- **Cursor**（`utils/cursor.rs`）：`.cur`/`.ico`/`.ani` 解码。自解 ICO 目录挑最大帧、手写 RIFF 取 `LIST/fram`；**不转 GIF**。
- **Registry**（`utils/registry.rs`）：HKCU 读写 + `SPI_SETCURSORS`。
- **Integration**（`models/` ↔ `types/`、`capabilities/`）：前后端字段逐个同名，共用 `snake_case`，不做驼峰转换。

---

## 三个视图（别合并回一张列表）

| 导航 | 视图 | 回答的问题 | 检查器 |
|---|---|---|---|
| 主题图库 | 分组网格（系统方案 / 我的主题 两段） | 挑哪个？ | 有 |
| 我的主题 | 数据表（槽位覆盖 / 导入于 / 导出·删除） | 我导入了什么、要清理哪个？ | 有 |
| 最近使用 | 按自然日分组的时间轴 | 上次用的是哪个？ | **没有** |

- 三页的选中项**各记一份**：`selection: Partial<Record<Page, string | null>>`。切页回来还是原来的上下文，又不会把别的页的选择带过来；页面上不写这个键就等于没有选中（比如将来的市场页，选中的是远程条目，不是本地主题）。
- 切页只清搜索词，不清选中；重载只清「已经不存在的主题」，不清还在列表里的。
- **加页面只改两处**：`lib/pages.ts` 的 `PAGE_META` 加一条（导航文案/页头文案/搜索框/计数口径/有无检查器）+ `App.tsx` 的 `VIEWS` 加一行视图组件。两处都是 `Record<Page, …>`，漏了编译不过 —— 加了页面却忘了视图分支导致中间区域白屏的坑已经堵上。
- 「主题图库」包含「我的主题」的集合——重复是**任务不同**（逛 vs 管），不是数据不同；别为了去重把两页合成一个列表加过滤条件，那正是重构前的毛病。
- 改名只做在 `ThemeNameField` 一处（检查器头部）；表格行内的操作只有导出与删除。槽位统计口径在 `lib/slots.ts`（`SYSTEM_SLOT_TOTAL = 15` 是 `SLOT_DEFS` 的镜像，后端改槽位必须同步改它）。

---

## 三个高频记错点

**① 槽位 15 个，顺序固定**
唯一来源 `utils/registry.rs::SLOT_DEFS`，完整表见决策记录「决策 3」。键名别照系统设置里的显示名猜：是 `Crosshair`（不是 Cross），另有 `NWPen`、`UpArrow`。短名（`no` / `ns` / `we` / `up`）只能做**精确匹配**，放进包含匹配会撞 `normal`、`upload`。

**② 8 个命令**
`get_all_themes` / `get_cursor_preview` / `import_theme` / `apply_theme` / `restore_default` / `delete_theme` / `rename_theme` / `export_theme`。契约见架构设计 §5。两条容易记错：
- `apply_theme` / `export_theme` 收**整个 `CursorTheme`**，不是 ID——系统方案只存在于注册表，没有磁盘目录，只给 ID 拿不到它的文件。
- 没有 `list_themes`（是 `get_all_themes`）；没有 `create_custom_theme`（未实现）。

**③ 注册表写入范围**
只写 `Cursors` 下 15 个槽位值 + `SchemeName`（+ 键默认值），未提供的槽位写**空字符串**。**不写** `Cursors\Schemes`（那是系统"已保存方案"列表，写进去会让用户的下拉框多出条目）。光标文件留在 `%LOCALAPPDATA%` 原地，**不复制进 `C:\Windows\Cursors`**。

---

## 硬约束（违反会出事故）

1. 数据目录只认 `utils/paths.rs::data_root()`，禁止别处硬编码。
2. `SPI_SETCURSORS` **只传 `SPIF_SENDCHANGE`**；带 `SPIF_UPDATEINIFILE` 本机返回 `0x80070006`，刷新直接失败。
3. `--no-sandbox` 不能从 `tauri.conf.json` 删：本机 WebView2 沙箱初始化失败会整窗纯白；Tauri 会覆盖同名环境变量，只能改 JSON。
4. 「正在使用」只从注册表反推（`active_theme_id`），不存内存 / localStorage。
5. 导出 zip 的文件名**按槽位命名**（导入端靠文件名反推槽位，否则"导出→再导入"必丢槽位）。
6. 重命名只改 `theme.json`，目录名保持 UUID；`updated_at` 不动（界面当"导入于"用）。
7. 删改类命令必须先 `Uuid::parse_str` 校验——`theme_dir(id)` 是字符串拼接，传 `../` 能越出数据目录。
8. 多来源必须部分成功：注册表读不到不能让用户主题一起消失，失败进 `warnings`。
9. **不加新依赖**；Toast/浮层用 `@base-ui/react` 自封装，不引 sonner / radix。
10. 动效只写 `duration-(--motion-*)` + `ease-standard/ease-exit`，禁裸数字时长、禁 `transition-all`。
11. zustand selector **不能返回新对象**（`filter`/`map`/字面量）→ 无限重渲染白屏；派生数据用纯函数 + `useMemo`。
12. 后台起 dev server 只用 `npm run dev:bg`，且**启动与验证写进同一条命令**；禁止 `npm run dev | head`（管道一关 EPIPE 直接杀死 vite）。
13. 可滚动容器一律加 `scroll-thin`：6px、轨道透明、拇指**平时完全隐形**、指针进入容器才浮出（`::-webkit-scrollbar`）。**别用 `scrollbar-width: thin`**——Chromium 里它仍走经典样式（带箭头、常显），在 320px 面板里会被当成进度条；也别自绘轨道或改滚动手感。
14. 检查器宽度由 `InspectorResizer` 拖动（280–560、双击复位、`←/→` 16px），**只在会话内有效、不落盘**：面板宽度是"此刻怎么摆"，存下来会在改了默认值后留下一个没人维护的旧数字。
15. `minWidth: 1080` / `minHeight: 640` 别从 `tauri.conf.json` 删：侧栏 224 + 检查器最小 280 + 正文 440，窄于此三栏会互相挤压（`design_check` 会断言这两个值）。
16. 外观三态（跟随系统 / 浅色 / 深色）只由 `lib/theme-mode.ts` 管：`html.dark` + 落盘 `cursorstudio.theme-mode` + `setTheme` 同步标题栏。**组件里不写 `dark:` 前缀**，颜色全走 token；手选浅/深后不再跟系统，选回「跟随系统」才恢复。改这段先看 `design_check` 的 18 条断言。

---

## 未实现（别写成已支持）

| 项 | 现状 |
|---|---|
| 文件夹导入 / 拖拽 `.zip` | 只有侧栏按钮 + 文件对话框 |
| `.inf` 槽位映射 | 仅文件名推断 |
| 设置页 / 打开数据目录 | 侧栏「设置」是 `disabled` 占位 |

**已拍板不做**（决策 10，别当"待排期"重新提）：自制方案（逐槽位上图）、单光标替换。槽位卡保持纯展示、不可点、不做 hover 暗示 —— 这是产品决定，不是没做完。

**窗口不是缺口**：`minWidth: 1080` / `minHeight: 640` 兜底，仍**不做响应式断点**（窄窗下不重排、不收起任何一栏）。

---

## 改完怎么验

```powershell
npm run build              # tsc + vite，类型错会拦下
cd src-tauri; cargo check  # 后端快速反馈
cargo test                 # 单元测试；注册表用例会短暂改光标，自带备份/恢复
```

cargo 拉包被系统代理挡住时（本机 Clash 常关）：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy CARGO_HTTP_PROXY="" cargo test
```

界面/动效脚本跑在浏览器里、走 mock，不写系统光标；**必须与 dev server 同一条命令**：

```powershell
node scripts/dev_bg.mjs start; node scripts/nav_check.mjs; node scripts/design_check.mjs; node scripts/motion_check.mjs; node scripts/dev_bg.mjs stop
```

`design_audit.mjs` / `ui_ratio.mjs` 只扫源码；`nav_check` / `design_check` / `recent_check` / `ui_check` 走交互链路。`nav_check` 逐页断言**结构签名**（网格 / 表格 / 时间轴、有无检查器与搜索框），三页同构会直接失败——这是防止"切页看不出变化"回潮的那道闸。
碰注册表的测试必须全局 `Mutex` 串行（`unwrap_or_else(|e| e.into_inner())` 防中毒），改用户设置的用例用"备份 + `catch_unwind` + 恢复"，断言失败也要还原。

动了文档、尤其是本文件的 `§x` / `决策 N` 引用，跑 `node scripts/doc_ref_check.mjs`：指空会列出 `文件:行号` 并以退出码 1 失败（不需要 dev server）。

---

## 其余口径

Windows 10/11 x64；全程无 UAC；应用主题 < 500ms；预览单帧最长边 128px、最多 32 帧；数据在 `%LOCALAPPDATA%\CursorStudio\`（`themes/` + `history.json`），卸载不删；仅简体中文，不做多语言。
