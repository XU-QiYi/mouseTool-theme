# 技术决策记录（ADR-lite）

> 本文件记录已经拍板的决定。**当它与 `mouse-theme需求描述.md` 或 `mouse-theme架构设计.md` 冲突时，以本文为准。**

## 决策总览

| # | 议题 | 结论 |
|---|------|------|
| 1 | 主题数据存储位置 | `%LOCALAPPDATA%\CursorStudio\themes\` |
| 2 | 应用主题是否需要管理员权限 | **不需要**，不写入 `C:\Windows\Cursors` |
| 3 | 光标槽位定义 | 15 个标准槽位，顺序见下表 |
| 4 | `.ani` 动态光标预览 | Rust 提帧 → base64 → 前端 canvas 播放 |

---

## 决策 1：主题数据存储在 LOCALAPPDATA

**结论**

```
%LOCALAPPDATA%\CursorStudio\
├── themes\
│   └── <theme-id>\
│       ├── theme.json
│       └── cursors\
│           ├── arrow.ani
│           └── ...
└── cache\          ← 预览帧缓存，可随时删除
```

**为什么**

- 光标文件是二进制资源，不是用户文档。放进 `Documents` 会让「文档」目录里莫名多出一堆 `.cur` / `.ani`。
- `Documents` 可能被 OneDrive / 坚果云等工具接管，一个 50MB 主题包会被同步到云端并产生冲突副本。`LOCALAPPDATA` 天然不参与同步。
- 卸载软件后数据保留这一点，两个位置都满足（都在安装目录之外）。
- 代码里只允许存在**一个**根目录常量，禁止任何地方硬编码路径。

**代价与补偿**

用户手动找不到这个隐藏目录 → 设置页必须提供「打开数据目录」按钮（调 `explorer.exe` 打开该路径）。

**废弃的旧说法**

需求文档中的 `Documents/MyCursorTool/Themes/` 作废。

---

## 决策 2：不写系统 Cursors 目录，不需要管理员权限

**结论**

导入和应用主题时，**不**把光标文件复制到 `C:\Windows\Cursors`。注册表 `HKCU\Control Panel\Cursors` 直接指向 `%LOCALAPPDATA%\CursorStudio\themes\...` 下的绝对路径。

`HKCU` 相关操作全部是普通用户权限，全程无 UAC 弹窗。

**为什么（这条很关键）**

1. `HKCU\Control Panel\Cursors` 的值允许指向任意可读路径，并非必须指向系统目录。系统目录只是第三方安装器的习惯做法。
2. **提权会让拖拽功能失效**。Windows 的 UIPI 机制下，以管理员权限运行的窗口收不到从资源管理器拖入的文件。而需求文档明确要求「拖拽 .zip 导入」——一旦为了复制文件而提权，拖拽就直接废了。这是二选一的取舍，拖拽更重要。

**已知的与权限无关的限制**

光标主题在**安全桌面**（UAC 提示框、登录界面、锁屏）上不生效，显示的是系统默认光标。这与文件放哪里无关，任何第三方主题工具都一样，不是本项目的缺陷。

**参考：本机现状**

当前系统里已安装的第三方主题文件位于 `C:\Windows\Cursors\荧1.0\`（由别的安装器放入）。本项目不采用这种方式。

---

## 决策 3：光标槽位共 15 个，顺序固定

**结论**

下表为**唯一权威定义**。写入 `Cursors\Schemes` 时，逗号分隔的路径顺序必须严格按此排列，缺项留空字符串但**不能省略逗号**。

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

**重要修正**

`mouse-theme架构设计.md` 模块一给出的 14 项顺序是**错的**（把 `AppStarting` 排在第 2、`Help` 排在第 4、`SizeAll` 排在第 8）。照那份列表写入会整体错位，导致应用后所有光标串位。以本表为准。

**超出 15 项的键**

现代 Windows 10/11 的 `Cursors` 键下还有 `Handwriting`、`Move`、`Location`、`Person`、`Pin` 等值，取值形如 `builtin://move.cur`。这些由系统管理，**本项目不读也不写**。

---

## 决策 4：`.ani` 预览用 Rust 提帧 + 前端 canvas

**结论**

导入时**不**转 GIF。调用时按需解析：

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

- 帧列表走 IPC 会占内存 → 结果按 `(文件路径, 修改时间, 大小)` 缓存到 `cache/`，同一光标只解析一次。
- 单帧统一缩放到 **最大 128px** 再编码，避免 256px 高分辨率光标撑爆 IPC。
- 解析失败不报错，返回 `{ is_animated: false, frames: [] }`，UI 显示占位图标。

**降级路径**

若某 `.ani` 结构异常解析不出帧，退回显示第一帧静态图 + 「动态」角标（需求文档中的方案 B）。

---

## 附：其他已确认的小事

| 项 | 结论 |
|---|---|
| React 版本 | 实际是 **19**，架构文档写的 18 是笔误 |
| 状态管理 | 需要安装 `zustand` |
| Toast | 需要安装 `sonner` |
| `scripts/clean_c_drive.ps1|py` | 与本项目无关，属遗留脚本，不删除但也不引用 |
| 窗口 `transparent: true` + `decorations: true` | 已改为 `transparent: false` |

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

Tauri 自己会设置 `additionalBrowserArgs`，**它会覆盖 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量**。
通过环境变量传 `--disable-gpu`、`--force-device-scale-factor`、`--disable-features=...` 等参数**完全无效**，必须写在 `tauri.conf.json` 里。

**安全评估**

`--no-sandbox` 关闭了 Chromium 的进程沙箱。本应用只加载本地打包的页面、不加载任意外部内容，风险可接受。若后续要收紧，可尝试 `--disable-gpu-sandbox` 等更精确的参数，找出最小必要集合。
