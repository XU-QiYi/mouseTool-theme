# 技术决策记录（ADR-lite）

> 本文件记录**已经拍板**的决定。与其他文档冲突时以本文为准，顺序：
> **本文 > `mouse-theme需求描述.md` > `mouse-theme架构设计.md` > `design-system.md` / `motion.md`**（后两者只管视觉与动效，不涉及产品范围）。
>
> 已作废的旧说法在各决策末尾单列，避免有人照着旧稿改回去。

## 决策总览

| # | 议题 | 结论 |
|---|---|---|
| 1 | 主题数据存储位置 | `%LOCALAPPDATA%\CursorStudio\themes\`，历史在 `history.json` |
| 2 | 应用主题是否需要管理员权限 | **不需要**，不写 `C:\Windows\Cursors` |
| 3 | 光标槽位定义 | 15 个标准槽位，顺序见决策 3 |
| 4 | `.ani` 动态光标预览 | Rust 提帧 → base64 → 前端 canvas 播放 |
| 5 | WebView2 沙箱 | 必须 `--no-sandbox`，且只能写在 `tauri.conf.json` |
| 6 | Toast / 浮层组件来源 | 用 `@base-ui/react` 自封装，**不引入 sonner / radix** |
| 7 | 「正在使用」怎么判定 | 只从注册表反推，不落任何本地状态 |
| 8 | 最近使用与导出的兼容性 | `history.json` 独立存储；导出 zip 按槽位重命名 |
| 9 | 导航三项与内容的关系 | 三项对应三种视图（网格 / 表格 / 时间轴），不复用同一张列表 |
| 10 | 自制方案 / 单光标替换 | **不做**；产品收窄为「主题管理器」 |

---

## 决策 1：主题数据存储在 LOCALAPPDATA

**结论**

```
%LOCALAPPDATA%\CursorStudio\
├── themes\
│   └── <theme-uuid>\
│       ├── theme.json
│       └── cursors\
│           ├── arrow.cur
│           └── ...
└── history.json      ← 「最近使用」，独立于主题存在
```

**为什么**

- 光标文件是二进制资源，不是用户文档。放进 `Documents` 会让"文档"目录里莫名多出一堆 `.cur` / `.ani`。
- `Documents` 可能被 OneDrive / 坚果云接管，一个 50MB 主题包会被同步上云并产生冲突副本。`LOCALAPPDATA` 天然不参与同步。
- 卸载后数据保留这一点，两个位置都满足（都在安装目录之外）。
- 代码里只允许存在**一个**根目录来源：`utils/paths.rs::data_root()`。

**代价与补偿**

用户找不到这个隐藏目录 → 需要一个「打开数据目录」入口（`explorer.exe`）。**此项尚未实现**，侧栏「设置」目前是禁用占位，见架构设计 §9。

**作废的旧说法**

- 需求文档 v1.0 的 `Documents/MyCursorTool/Themes/` 作废。
- 早期设想的 `cache\` 目录**不存在**：动态光标只在被查看时解析，结果缓存在前端内存 `Map`，不落盘（见决策 4）。

---

## 决策 2：不写系统 Cursors 目录，不需要管理员权限

**结论**

导入和应用主题时，**不**把光标文件复制到 `C:\Windows\Cursors`。注册表 `HKCU\Control Panel\Cursors` 直接指向 `%LOCALAPPDATA%\CursorStudio\themes\...` 下的绝对路径。

`HKCU` 相关操作全部是普通用户权限，全程无 UAC 弹窗。

**为什么（这条很关键）**

1. `HKCU\Control Panel\Cursors` 的值允许指向任意可读路径，并非必须指向系统目录。系统目录只是第三方安装器的习惯做法。
2. **提权会让拖拽功能失效**。Windows 的 UIPI 机制下，以管理员权限运行的窗口收不到从资源管理器拖入的文件。一旦为复制文件而提权，拖拽就直接废了。这是二选一的取舍，拖拽更重要。

**附注：刷新只传 `SPIF_SENDCHANGE`**

```rust
SystemParametersInfoW(SPI_SETCURSORS, 0, None, SPIF_SENDCHANGE)
```

路径已由 `write_cursors` 直接写进注册表，此时只需让系统重新加载。若再带 `SPIF_UPDATEINIFILE`，系统会回写用户配置，本机实测返回 `0x80070006`（无效句柄），刷新直接失败。**别加回去。**

**已知的与权限无关的限制**

光标主题在**安全桌面**（UAC 提示框、登录界面、锁屏）上不生效，显示的是系统默认光标。这与文件放哪里无关，任何第三方主题工具都一样，不是本项目的缺陷。

**参考：本机现状**

当前系统里已安装的第三方主题文件位于 `C:\Windows\Cursors\荧1.0\`（由别的安装器放入）。本项目不采用这种方式。

---

## 决策 3：光标槽位共 15 个，顺序固定

**结论**

下表为**唯一权威定义**，代码里的 `SLOT_DEFS` 与之一一对应。

顺序只影响两件事：

1. **读** `Cursors\Schemes` 时按位置解析逗号分隔的路径（缺项留空但逗号不能省），位置错一项，整套光标就串位；
2. 导入 / 导出时的文件命名、以及界面上槽位的排列顺序。

**写**的时候按 `registry_key` 逐个写 `Cursors` 下的值，不依赖顺序；当前也**不写** `Schemes`（理由见需求文档 §4）。

| # | 注册表键名 | 中文名 | 英文名 |
|---|-----------|--------|--------|
| 1 | `Arrow` | 正常选择 | Normal Select |
| 2 | `Help` | 帮助选择 | Help Select |
| 3 | `AppStarting` | 后台运行 | Working in Background |
| 4 | `Wait` | 忙 | Busy |
| 5 | `Crosshair` | 精确选择 | Precision Select |
| 6 | `IBeam` | 文本选择 | Text Select |
| 7 | `NWPen` | 手写笔 | Handwriting |
| 8 | `No` | 不可用 | Unavailable |
| 9 | `SizeNS` | 垂直调整大小 | Vertical Resize |
| 10 | `SizeWE` | 水平调整大小 | Horizontal Resize |
| 11 | `SizeNWSE` | 对角线调整 1 | Diagonal Resize 1 |
| 12 | `SizeNESW` | 对角线调整 2 | Diagonal Resize 2 |
| 13 | `SizeAll` | 移动 | Move |
| 14 | `UpArrow` | 候选选择 | Alternate Select |
| 15 | `Hand` | 链接选择 | Link Select |

**顺序依据**

已在本机 `HKCU\Control Panel\Cursors\Schemes\firefly` 实测验证：15 项路径依次对应上述顺序（第 2、7、14 项为空）。解析时按位置取，不按文件名猜。

**槽位推断只对文件名生效**

导入时依次走：先 `EXACT_NAMES` 精确匹配短名（`no` / `ns` / `we` / `up`），再 `SLOT_KEYWORDS` 包含匹配。短名**绝不能**放进包含匹配表——`no` 会撞上 `normal`，`up` 会撞上 `upload`。

**超出 15 项的键**

现代 Windows 10/11 的 `Cursors` 键下还有 `Handwriting`、`Move`、`Location`、`Person`、`Pin` 等值，取值形如 `builtin://move.cur`。这些由系统管理，**本项目不读也不写**。

---

## 决策 4：`.ani` 预览用 Rust 提帧 + 前端 canvas

**结论**

导入时**不**转 GIF。需要预览时按需解析：

```
.ani (RIFF 容器)
  → Rust 拆 RIFF，取 anih 头 / rate 块 / LIST fram
  → 每帧本质是一个 .cur(ICO)，解码为 RGBA
  → 编码 PNG → base64
  → 返回 { is_animated, frames: [base64...], rate_ms, hotspot }
  → 前端 canvas 逐帧播放
```

**为什么**

- 不需要引入 GIF 编码器，也不用在磁盘上额外生成一堆 GIF 文件。
- 能同时拿到每帧的 rate 和热点坐标，播放速度和定位更准。
- 只保留一份原始文件，删主题时不会有残留。

**性能约束**

- 帧列表走 IPC 会占内存 → **缓存在前端内存 `Map`**（`useCursorPreview`，按文件路径去重 + 同请求合并），同一光标只解析一次，不落盘。
- 单帧统一缩放到**最长边 128px** 再编码，避免 256px 高分辨率光标撑爆 IPC。
- 动态光标**最多取 32 帧**，超出截断。
- 解析失败不报错，返回 `{ is_animated: false, frames: [] }`，UI 显示占位图标。

**降级路径**

若某 `.ani` 结构异常解析不出帧，退回显示首帧静态图 + 「动态」角标。

**作废的旧说法**

需求文档 v1.0 的"导入时转 GIF 存盘（方案 A）/ 失败降级（方案 B）"整体作废，只保留"降级显示静态图"这个思路。

---

## 决策 5：WebView2 必须禁用沙箱（`--no-sandbox`）

**结论**

```json
// src-tauri/tauri.conf.json
"app": {
  "windows": [{
    "additionalBrowserArgs": "--no-sandbox"
  }]
}
```

**为什么**

本机 WebView2 的渲染进程沙箱无法初始化，表现为：窗口正常打开、进程存活、JS 与 `invoke` 全部正常工作（内核日志能看到 `console.log` 输出），但**不绘制任何像素**，整个窗口纯白。

加 `--no-sandbox` 后立即恢复，连 `.ani` 逐帧预览都正常。

**重要陷阱（务必记住）**

Tauri 自己会设置 `additionalBrowserArgs`，**它会覆盖 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量**。通过环境变量传 `--disable-gpu`、`--force-device-scale-factor`、`--disable-features=...` 等参数**完全无效**，必须写在 `tauri.conf.json` 里。

**安全评估**

`--no-sandbox` 关闭了 Chromium 的进程沙箱。本应用只加载本地打包的页面、不加载任意外部内容，风险可接受。若后续要收紧，可尝试 `--disable-gpu-sandbox` 等更精确的参数，找出最小必要集合。

---

## 决策 6：零新依赖，浮层用 base-ui 自封装

**结论**

`@base-ui/react` 已自带 `toast` / `alert-dialog` / `dialog` / `menu` / `popover`。需要这类能力时，**按 shadcn 风格手写封装**，不安装 sonner、radix 等平行实现。

- Toast 单例：`lib/toast.ts` 用 `Toast.createToastManager()` 建全局 manager，store / service 可直接调用。
- 渲染层：`components/ui/toaster.tsx` 挂在 App 根部。
- `import.meta.env.DEV` 下暴露 `window.__toast`，供自动化脚本触发验证。

**为什么**

同一个界面里不出现两套浮层实现，动效与层级（`z-60` / `z-50`）只需维护一处；也避免为了一个 Toast 多背一个库。

**作废的旧说法**

"Toast 需要安装 `sonner`"作废（架构文档旧稿、早期组件树提示词里都有，已删）。

---

## 决策 7：「正在使用」只从注册表反推

**结论**

`get_all_themes` 额外返回 `active_theme_id`：读 `Cursors` 各槽位当前路径，与所有主题的槽位路径双向比对（路径做大小写归一）。

**为什么**

用内存或 localStorage 记住"上次应用了哪个"必然过期：用户可能在系统设置里换方案、可能重装主题、可能手工改注册表。**注册表才是事实来源**。用本地状态会出现"已经用着的主题还能再点一次应用"这种明显错误。

识别不出时返回 `null`（系统默认光标，或用户手工改过设置），界面不显示"使用中"标记，而不是猜一个。

---

## 决策 8：最近使用独立存储，导出保持可回灌

**结论**

- 历史存 `%LOCALAPPDATA%\CursorStudio\history.json`，**不塞进 `theme.json`**：`{version, entries[]}`，上限 50 条，同 ID 去重置顶，每条只存**名称快照**。
- `apply_theme` 返回 `ApplyOutcome { recent, warning }`：光标切换是主操作，记历史是附属操作。**主操作成功就不回滚**，历史失败只带 warning 回去提示。
- `export_theme` 的包内文件名**按槽位重命名**（`arrow.cur` / `busy.ani`），不是源文件名。

**为什么**

- 主题随时会被改名或删除，历史必须能独立成立；靠 `theme.json` 存历史，删主题就把历史一起带走了。
- 导出必须能"再导入回来"。导入端只认文件名推断槽位，用源文件名（如 `荧光指针-1.cur`）会让回灌后的槽位全丢。同名槽位按 `registry_key` 去重，跳过的项在 `ExportSummary.skipped` 里说清原因。

**细节**

- 写文件失败要清理半成品（空 zip）：先 `drop(writer)` 再 `remove_file`，Windows 上句柄不关删不掉。
- `capabilities/default.json` 用了 `dialog:*` 时，save 需确认 `dialog:allow-save` 在授权内，否则运行时才报权限错。

---

## 决策 9：导航三项对应三种视图，不是同一张列表的三个过滤条件

**结论**

三个导航项各有独立视图与任务，**不复用同一个列表组件**：

| 导航 | 视图 | 任务 | 右侧检查器 |
|---|---|---|---|
| 主题图库 | 分组网格（系统方案 / 我的主题 两段） | 逛、挑 | 有 |
| 我的主题 | 数据表（槽位覆盖 / 导入于 / 导出·删除） | 管 | 有 |
| 最近使用 | 按自然日分组的时间轴 | 回溯 | 没有 |

- 选中项**按页各记一份**（`selection: Record<Page, string | null>`）：切页回来还是原来的上下文，又不会把别的页的选择带过来。切页只清搜索词，不清选中。
- 全局「当前光标」状态卡常驻侧栏底部，「还原系统默认」只在这一处提供，不散落在详情区。

**为什么**

- 重构前三个页面共用 `ThemeList` + `ThemeCard` + `ThemeDetail`，差异只有一个 `filter` 和一句空状态文案 —— 点导航后中间区域几乎不动，用户会以为切换失灵。**这是结构问题，不是样式问题**，只改视觉救不回来。
- 同一个集合用两种视图看并不冗余：图库回答"哪个好看"，我的主题回答"我导入了什么、覆盖了几个槽位、要不要清掉"。Photos 的「图库 / 相簿」是同一个道理。
- 「最近使用」刻意不挂检查器：它只有时间这一条结构，多一栏只会把时间轴挤窄，也让人误以为可以在这里编辑。

**作废**：`ThemeList` / `ThemeCard` / `ThemeDetail` 三个组件已删除。新增页面时不要退回"一个列表 + 一个详情 + 过滤条件"的旧结构。

---

## 决策 10：不做自制方案与单光标替换

**结论**

- 产品定位收窄为「主题管理器」：**导入整套方案 → 应用 → 管理 → 回溯**。不提供在应用内制作或修改光标的能力。
- 连带不做：逐槽位上图、单光标替换、图片转 `.cur`、热点编辑。槽位卡保持纯展示、不可点，也**不做 hover 暗示** —— 别用视觉反馈引导用户去点一个点不动的东西。
- 主题来源只有两条：系统注册表里已有的方案、`.zip` 导入。

**为什么**

- 自制方案要同时新增三块能力：图片 → `.cur` 的写入与热点、15 个槽位的装配界面、以及"创建"这条与导入不同的落盘路径。成本远高于主线，而主线（浏览 / 应用 / 管理）才是这个工具存在的理由。
- 单光标替换与"主题不可变"直接冲突：改完要决定 `updated_at` 动不动、正在使用的主题要不要重新写注册表。为一个边缘功能引入一套状态语义，不划算。

**作废**：别再按"先做编辑器，主题自然就有了"规划。要解决"主题从哪来"，方向是**更多可导入的来源**（授权内容、索引 + 下载安装），最终仍然回到 `import_theme` 那条落盘路径，而不是在应用内生产光标。

---

## 附录 A：技术栈定格

**Tauri 2 + React 19 + TypeScript + Vite + Tailwind CSS 4 + shadcn/ui（base-nova / `@base-ui/react`）+ zustand + Rust**。

选型理由（当年四选一的结论，其余方案不再考虑）：

| 方案 | 结论 |
|---|---|
| **Tauri（选中）** | 复用系统 WebView2，产物只有几 MB；前端生态直接可用；系统调用交给 Rust |
| Python + CustomTkinter/PySide6 | 开发最快，但打包 50–100MB，界面特效上限低 |
| C# + WPF/WinUI 3 | 最原生，但 XAML 学习成本高，且与现有前端代码零复用 |
| Electron | 生态最好，但内置整个 Chromium，体积与内存都不可接受 |

> 原 `mouse-theme技术栈.md` 是选型期的四方案对比稿，已完成使命，2026-10-22 删除，结论收敛到本表。

---

## 附录 B：其他已确认的小事

| 项 | 结论 |
|---|---|
| React 版本 | **19**（早期文档写的 18 是笔误，已改） |
| 状态管理 | zustand 5 |
| 主题卡封面 | 取 `cursors[0]`；槽位按标准顺序排列，正常就是「正常选择」 |
| 光标槽位卡 | **不可点**，也不做 hover 暗示（不可点的东西不该长得像能点） |
| 重命名 | 只改 `theme.json` 的 `name`，目录名保持 UUID；`updated_at` 不动，它承担"导入于"语义 |
| 删除保护 | 使用中不可删（UI 禁用 → store 拦截 → 后端 UUID 校验）；系统方案不可删 |
| 主题包大小 | 50MB 上限，超出直接拒绝并说明怎么减小 |
| `scripts/clean_c_drive.ps1` / `.py` | 与本项目无关的遗留脚本，文档不引用；建议尽快从仓库移除 |
| 窗口配置 | `transparent: false` + `decorations: true`（曾试过透明窗口，已放弃） |
| dev server | 前台用 `npm run tauri dev`；后台验证只用 `npm run dev:bg` / `dev:stop`，禁止 `npm run dev \| head` 这类管道启动 |
