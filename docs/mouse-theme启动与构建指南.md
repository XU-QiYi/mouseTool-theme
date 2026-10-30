# 新手启动与构建指南（从零到安装包）

> 本项目：**鼠标光标主题管理工具** —— 一款 Windows 桌面应用，用来导入 / 预览 / 一键应用鼠标光标主题包（.zip），并改写系统注册表让光标立即生效。
>
> 技术栈一句话：**界面用 React + TypeScript + Vite（就是做网页那套），底层系统操作用 Rust，两者用 Tauri 2 粘成一个桌面程序**。
>
> 本指南覆盖：环境准备 → 依赖安装 → 日常启动 → 打包编译 → 运行验证。每一步都写明"这步在干什么"和"新手最容易踩的坑"。

---

## 0. 先看懂：命令一图流

```
npm install                ① 装前端依赖（node_modules）
        │
        ▼
npm run tauri dev          ② 日常开发：热更新 + 实时预览窗口
        │                  （内部自动做了：npm run dev 起网页服务 → 编译 Rust → 弹出桌面窗口）
        ▼
npm run tauri build        ③ 发布打包：出正式安装包
                           （内部自动做了：npm run build 出静态网页 → release 编译 Rust → 生成 .exe 安装包）
```

**记住两条主命令就够了：开发用 `npm run tauri dev`，发布用 `npm run tauri build`。** 其余命令都是它们的零件或辅助工具，下面逐个拆开讲。

---

## 1. 环境准备（只需做一次）

### 1.1 需要装什么

| 工具 | 作用 | 本机验证过的版本 | 检查命令 |
|------|------|------------------|----------|
| **Node.js** | 运行前端构建工具链 | v22（v20+ 均可） | `node -v` |
| **npm** | Node 的包管理器（随 Node 一起装） | 10.x | `npm -v` |
| **Rust 工具链** | 编译 Tauri 的后端（桌面程序本体） | rustc 1.95 | `rustc --version` |
| **cargo** | Rust 的包管理器+构建器（随 Rust 一起装） | 与 rustc 同版本 | `cargo --version` |
| **WebView2 运行时** | 显示界面的浏览器内核 | Win10/11 系统自带 | 见 1.3 |
| **Visual Studio C++ 生成工具** | Windows 上编译 Rust 的 C 依赖 | 仅 Windows 需要 | 见 1.2 |

### 1.2 安装步骤

**① Node.js**

到 https://nodejs.org 下载 LTS 版本（推荐 22.x），一路下一步安装。装完开一个**新的**终端（旧终端读不到新环境变量），执行：

```powershell
node -v   # 应显示 v22.x.x 或更高
npm -v    # 应显示 10.x.x 或更高
```

**② Rust（Windows 用 rustup）**

1. 打开 https://rustup.rs ，下载 `rustup-init.exe` 并运行。
2. 安装时选默认选项（会安装 MSVC 工具链，和 Windows 最合拍）。
3. 装完**关掉终端重新打开**，验证：

```powershell
rustc --version   # rustc 1.95.x 或更高
cargo --version   # cargo 1.95.x 或更高
```

**③ Visual Studio C++ 生成工具（Windows 必装）**

Rust 在 Windows 上编译时要调用微软的 C/C++ 链接器，缺了它 `cargo` 会在编译中途报 `link.exe` 相关错误。

1. 到 https://visualstudio.microsoft.com/visual-cpp-build-tools/ 下载 "Build Tools for Visual Studio"。
2. 安装时勾选工作负荷 **「使用 C++ 的桌面开发」**，其余默认即可（体积约 2–6 GB，这是正常现象）。

**④ WebView2 运行时**

Windows 10（较新版本）和 Windows 11 系统自带，一般不用管。万一程序启动后是白屏/报"找不到 WebView2"，去微软官网搜 "WebView2 Runtime" 下载 Evergreen 安装包装上。

### 1.3 环境自检（一分钟全过）

```powershell
node -v
npm -v
rustc --version
cargo --version
```

四条命令都能输出版本号、不报"不是内部或外部命令"，就可以进入下一步。

> **坑 ①：改完环境变量，旧终端不认新命令。**
> 装完 Node / Rust 后必须**重新开一个终端**再验证，否则还是"找不到命令"。这不是没装上，只是当前终端还没刷新。

---

## 2. 获取项目 + 安装依赖

### 2.1 获取代码

把项目克隆/拷贝到本地，然后进入项目根目录（就是能看到 `package.json` 的那一层）：

```powershell
cd F:\forge\mouse-theme\mouseTool-theme
```

### 2.2 装前端依赖

```powershell
npm install
```

**这步在干什么？** npm 读取 `package.json` 里列的清单，把 React、Vite、Tailwind、Tauri CLI 等所有前端依赖下载到项目下的 `node_modules` 文件夹里。这个文件夹不进 git（见 `.gitignore`），所以**每个人拿到代码后都要跑一次**。

装完可以确认一下：

```powershell
npm ls --depth=0
```

看到一排依赖列表即为成功。

> **坑 ②：网络问题导致 install 很慢或失败。**
> 这一步要联网下载几百个包。公司代理/加速器环境下若报超时，可以临时指定国内镜像源：
>
> ```powershell
> npm install --registry=https://registry.npmmirror.com
> ```
>
> 装 Rust 依赖（首次 `tauri dev`/`tauri build` 时）同理，见 3.2 的坑 ④。

---

## 3. 日常开发：启动（最常用）

### 3.1 一条命令启动完整桌面应用

```powershell
npm run tauri dev
```

**这步在干什么？** 它像一条流水线，按顺序自动做三件事：

1. **起前端开发服务器**（`npm run dev`，即 Vite）—— 把界面跑在 `http://localhost:1420`；
2. **编译 Rust 后端** —— 首次编译较慢（几分钟），之后增量编译只要几秒；
3. **弹出桌面窗口** —— 窗口加载第 1 步的网页地址，并通过 Tauri 桥接调用 Rust（改注册表、读光标文件等）。

之后改 `src/` 下的前端代码（界面），保存后**窗口里内容自动热更新**，不用重启；改 `src-tauri/src/` 下的 Rust 代码（系统能力），Tauri 会自动重新编译并重启窗口，稍等片刻即可。

**停止运行：** 在终端按 `Ctrl + C`。

### 3.2 只看界面、不跑桌面壳（可选）

```powershell
npm run dev
```

只启动 Vite，用浏览器打开 `http://localhost:1420` 就能看到界面。适合只调样式、不动系统功能时快速预览。

> ⚠️ 浏览器里**没有** Tauri 后端：所有调用 Rust 的按钮（应用主题、导入 .zip 等）会失败或无响应，这不是 bug，是因为桌面壳没启动。

### 3.3 其他辅助命令

| 命令 | 作用 | 什么时候用 |
|------|------|-----------|
| `npm run build` | 仅做前端构建（TypeScript 检查 + 打包出静态文件到 `dist/`） | 想单独确认前端代码能编译通过 |
| `npm run preview` | 本地预览构建产物（`dist/`） | 打包前确认发布版界面无误 |
| `npm run dev:bg` / `npm run dev:stop` | 后台起 / 停 Vite：stdout 接日志文件、进程脱离终端，PID 记在 `.dev-server.pid` | 跑自动化验收脚本时（见 5.2） |
| `npm run tauri <子命令>` | 调用 Tauri CLI（如 `npm run tauri dev` / `build` / `info`） | 一般不用单独敲 |

> **坑 ③：端口 1420 被占用，启动直接报错。**
> 本项目的 Vite 配置写死了 `port: 1420` 且 `strictPort: true`（因为 Tauri 要求固定端口）。如果你先跑了 `npm run dev` 又再跑 `npm run tauri dev`，或者上次进程没关干净，会报端口冲突。解决：把占用 1420 的进程关掉（任务管理器里搜 node），或重启终端再启动。
>
> **坑 ④：首次编译 Rust 时卡住/报网络错误（代理机器常见）。**
> cargo 首次会联网下载 crates。如果本机开着系统代理（比如 Clash），而代理端口没在运行，cargo 会一直转圈或报 `failed to fetch`。绕过系统代理再跑：
>
> ```powershell
> # PowerShell 写法（临时清除代理变量后再启动）
> $env:HTTP_PROXY=""; $env:HTTPS_PROXY=""; $env:http_proxy=""; $env:https_proxy=""; $env:CARGO_HTTP_PROXY=""
> npm run tauri dev
> ```
>
> （Git Bash 下等价写法：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy CARGO_HTTP_PROXY="" npm run tauri dev`）
>
> **坑 ⑤：窗口弹出来了但一片空白/不渲染（个别机器）。**
> 本项目已在 `src-tauri/tauri.conf.json` 的 `app.windows[0].additionalBrowserArgs` 里加了 `"--no-sandbox"`。这是本机 WebView2 沙箱初始化失败的已知解法，**不要删掉这个配置**；同时注意 Tauri 会覆盖同名环境变量，所以只能改这个 JSON 文件，不能靠设环境变量传参。

---

## 4. 打包编译：生成正式安装包

### 4.1 一条命令出安装包

```powershell
npm run tauri build
```

**这步在干什么？** 同样是一条流水线：

1. **前端发布构建**（`beforeBuildCommand` 配置的 `npm run build`）—— 先跑 TypeScript 类型检查（`tsc`），再用 Vite 把界面打包成静态文件，输出到项目根的 `dist/`；任何类型错误都会在这一步拦下，构建终止；
2. **Rust 发布编译** —— 用 `release` 模式编译后端，比开发模式慢得多（首次可能 5–15 分钟），但产物体积小、运行快；
3. **生成安装包** —— 在 Windows 上打包为安装程序（`bundle.targets` 为 `"all"`，产出 NSIS 安装包 `.exe` 等）。

### 4.2 产物在哪里

构建成功后，到这个目录找成品：

```
src-tauri\target\release\bundle\
├── nsis\           ← 双击即装的安装包（.exe 安装程序），发给用户就用这个
└── ...             （按配置可能还有其他格式）
```

程序本体（不打包、直接运行）在：

```
src-tauri\target\release\mousetool-theme.exe
```

### 4.3 构建前的检查清单

- [ ] `npm install` 已跑过（`node_modules` 存在）；
- [ ] 前端能单独通过检查：`npm run build` 不报错；
- [ ] 没有残留进程占用 1420 端口；
- [ ] （代理机器）已按坑 ④ 清除代理变量；
- [ ] 磁盘剩余空间充足（`src-tauri/target` 可能占用数 GB）。

> **坑 ⑥：`tsc` 报类型错误，构建直接失败。**
> `npm run build` = `tsc && vite build`，TypeScript 检查是硬门槛。看着能跑 ≠ 类型过关，改完代码记得先本地跑一次 `npm run build` 把类型错误清掉再打包。
>
> **坑 ⑦：改了 Rust 依赖或配置，构建时间暴涨。**
> 属于正常现象。增量编译快，全量/首次编译慢。构建过程中终端长时间没输出不代表卡死，请耐心等待；若报网络错误按坑 ④ 处理。
>
> **坑 ⑧：安装包在别的电脑上装完打不开/白屏。**
> 目标机器需要 WebView2 运行时（Win10/11 基本自带）。另外本工具依赖 Windows 注册表与光标 API，**只支持 Windows**，在 macOS/Linux 上无法运行，也不要在非 Windows 环境打包。

---

## 5. 运行验证（确认没跑坏）

### 5.1 手动冒烟测试（3 分钟）

用 `npm run tauri dev` 启动（或安装包装好后运行），按顺序确认：

| # | 操作 | 预期结果 |
|---|------|---------|
| 1 | 程序启动 | 出现 1200×800 窗口，界面正常渲染、无白屏 |
| 2 | 左侧主题列表 | 至少能看到主题卡片/空状态提示，不报错 |
| 3 | 点击一个主题卡片 | 右侧出现该主题各光标槽位（Arrow/Wait/Hand…）的预览 |
| 4 | 点击"应用此主题" | 系统鼠标指针立即切换为新主题（无需重启/管理员权限） |
| 5 | 点击"恢复默认" | 系统光标回到 Windows 默认 |
| 6 | 导入一个 `.zip` 主题包 | 主题出现在列表中，预览可播放 `.ani` 动画 |

### 5.2 自动化 UI 验证脚本（项目自带）

`scripts/` 下是项目自带的验收脚本：一部分用无头 Edge + CDP 驱动界面（前提是 `http://localhost:1420` 可访问，用 `dev:bg` 后台起最稳；前台 `npm run tauri dev` 也行，但会占住一个终端），另一部分只扫源码。

下表是日常最常用的最小集；完整验收链（含维护、批量、导入等）见 [`AGENTS.md`](../AGENTS.md) 的「改完怎么验」。

| 脚本 | 验什么 | 会点「应用」吗 |
|---|---|---|
| `node scripts/design_check.mjs` | 按 Tab 走查键盘焦点、`aria` 属性、三栏结构，并存截图 | 不会 |
| `node scripts/design_audit.mjs` | 静态扫描：间距/字号/图标是否出现阶梯外的值、有没有裸写时长或 `transition-all` | 不启动浏览器 |
| `node scripts/ui_ratio.mjs` | 统计 JSX 元素构成：shadcn / 业务组件 / 原生标签 / 图标 的比例 | 不启动浏览器 |
| `node scripts/motion_check.mjs` | 逐帧采样 Toast 与弹窗的进出场：时长、中间态、倒计时条、降级是否生效（33 项断言） | 不会 |
| `node scripts/recent_check.mjs` | 「最近使用」排序、应用后置顶、删除后的提示 | 会（mock，不写系统） |
| `node scripts/ui_check.mjs` | 点第一个主题卡 + 点应用按钮，截图 | 会（mock，不写系统） |
| `node scripts/nav_check.mjs` | 逐页断言结构签名（网格 / 表格 / 时间轴 / 设置面板、有无检查器与搜索框） | 不会 |
| `node scripts/dnd_check.mjs` | 拖放导入的遮罩、反馈与「两种入口共用一条链路」 | 不会 |
| `node scripts/migration_check.mjs` | 主题目录迁移的确认框、执行期锁、进度、失败回滚与恢复默认（`?mock-migrate-error` / `?mock-migrate-fail=settings` 注入失败） | 不会 |

> 改文档时另有一条不依赖浏览器的检查：`node scripts/doc_ref_check.mjs`。它校验 `AGENTS.md` 与 `docs/*.md` 里的 `§x` / `决策 N` 是否还指得着（章节重排后最容易静默失效），指空会列出 `文件:行号` 并以退出码 1 失败。

```powershell
# 推荐写法：起服务 → 验证 → 停服务，一条命令走完
node scripts/dev_bg.mjs start; node scripts/design_check.mjs; node scripts/dev_bg.mjs stop
```

**这步在干什么？** 脚本用无头 Edge 通过 CDP 打开页面 → 模拟点击/Tab → 采数据 → 截图存到 `%TEMP%`（如 `mousetool_click.png`、`design_focus.png`），相当于"替你点一遍"。改完界面或动效后跑一遍，比肉眼可靠。

> **为什么脚本点「应用」也安全**：脚本跑的是普通浏览器里的 `localhost:1420`，没有 Tauri 后端。`services/theme.ts` 检测到非 Tauri 环境会切到 `mock.ts` 的示例数据，点「应用」只弹一条"开发模式：未真正写入系统"的提示，**不会改你的光标**。要验真实系统效果，只能在 `npm run tauri dev` 窗口或安装包里手动点。

> **坑 ⑨：脚本截图里布局判断失真（如视口宽度变成 756px）。**
> 系统 DPI 缩放会影响无头浏览器视口。脚本已内置 `--force-device-scale-factor=1` 参数来规避，自己仿写脚本时**务必带上这个参数**。
>
> **坑 ⑩：脚本报找不到 Edge。**
> 脚本写死了 Edge 路径 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。若你的 Edge 装在别处，改脚本开头的 `EDGE` 常量即可。
>
> **坑 ⑪：后台起的 dev server"过一会儿就没了"。**
> 用 `dev_bg.mjs start` 起的 vite，在**当前 bash 命令结束时**会被回收——日志里没有 error，端口只剩 `TIME_WAIT`，接着验证脚本拿到 502 并报一堆"按钮 NOT_FOUND"的假失败。所以**启动和验证必须写进同一条命令**（见上面的推荐写法）。
> 另外**绝不要**用 `npm run dev | head` 这类管道方式起后台：管道一关，vite 写 stdout 拿到 EPIPE 会直接退出。`dev_bg.mjs` 把 stdout 接到日志文件就是为了避开这一点。

### 5.3 Rust 侧验证（改后端时）

```powershell
# 编译自检（不启动窗口，只验证 Rust 代码能过编译）
cd src-tauri
cargo check
```

改动了注册表/光标相关 Rust 代码（`src-tauri/src/utils/registry.rs`、`commands/` 等）时，先 `cargo check` 秒级反馈，再启动完整应用验证真实效果。

---

## 6. 常见问题速查表

| 症状 | 原因 | 解法 |
|------|------|------|
| `node`/`npm` 不是内部命令 | 环境变量未生效 / 没装 | 重开终端；重装 Node |
| `cargo`/`rustc` 不是内部命令 | 没装 Rust 或终端未刷新 | rustup.rs 安装；重开终端 |
| 编译报 `link.exe` 找不到 | 缺 VS C++ 生成工具 | 装 "使用 C++ 的桌面开发" 工作负荷 |
| `npm install` 超时 | 网络/镜像问题 | 加 `--registry=https://registry.npmmirror.com` |
| 启动报端口 1420 占用 | 旧 dev 进程没关 | 结束 node 进程后重启 |
| cargo 拉包失败/一直转圈 | 系统代理挡住了 cargo | 按坑 ④ 清除代理变量 |
| 窗口白屏 | WebView2 沙箱问题 | 确认 `additionalBrowserArgs: "--no-sandbox"` 在配置里 |
| `tauri build` 报 TS 错误 | 类型检查不通过 | `npm run build` 清零类型错误后重打 |
| 装到别的电脑无法运行 | 缺 WebView2 / 非 Windows | 目标机装 WebView2；仅支持 Windows |
| 应用主题后光标没变 | 属于系统级功能，需在桌面版操作 | 确认是 `tauri dev`/安装包运行，而非浏览器预览 |
| 验收脚本报 502 或一堆"按钮找不到" | dev server 已被回收（不是脚本坏了） | 按坑 ⑪，用 `dev:bg` 且把启动与验证写在同一条命令里 |

---

## 7. 项目结构速查（找代码用）

```
mouseTool-theme/
├── package.json            ← 前端依赖与 npm 脚本（dev/build/preview/tauri/dev:bg）
├── vite.config.ts          ← Vite 配置（固定端口 1420；cacheDir 已挪到系统临时目录）
├── index.html              ← 界面入口
├── src/                    ← 前端源码（React + TS + Tailwind）
│   ├── App.tsx             ← 三栏骨架 + 页面切换
│   ├── App.css             ← 设计 token 唯一来源（颜色/字号/间距/动效）
│   ├── components/
│   │   ├── layout/         ← 侧栏导航
│   │   ├── theme/          ← 主题列表、卡片、详情、槽位网格
│   │   ├── cursor/         ← 光标预览图、.ani 播放器、槽位卡
│   │   └── ui/             ← shadcn 组件（button/card/badge/dialog/toast…）
│   ├── stores/             ← zustand 全局状态
│   ├── services/           ← 所有 invoke 封装 + 浏览器 mock
│   ├── hooks/              ← 预览请求去重与缓存
│   ├── types/              ← 与 Rust 结构体对应的类型
│   └── lib/                ← toast 单例、cn()
├── src-tauri/              ← Rust 后端（Tauri 桌面壳）
│   ├── tauri.conf.json     ← 窗口/打包配置（含 --no-sandbox，勿删）
│   ├── Cargo.toml          ← Rust 依赖
│   └── src/
│       ├── commands/       ← 前端可调用的 Tauri 命令（34 个）
│       ├── models/         ← 数据结构（前后端契约）
│       └── utils/          ← paths 数据目录 / registry 注册表 / cursor 解析 / importer 导入 / history 历史
├── scripts/                ← 验收脚本（设计/动效/交互/文档引用/后台起服务）
└── docs/                   ← 项目文档（本文件所在）
```

各目录之间怎么通信、每条命令收什么参数，见 `mouse-theme架构设计.md`。

---

## 8. 给初学者的三条建议（留下印象就记这个）

1. **两个命令走天下**：日常 `npm run tauri dev`，发布 `npm run tauri build`。其余命令都是这两条的零件。
2. **报错先看是"前端层"还是"Rust 层"**：界面白屏/样式错 → 查 `src/`；功能按钮没反应/注册表不生效 → 查 `src-tauri/src/`。`npm run build` 和 `cargo check` 是各自的快速体检命令。
3. **环境问题占新手坑的一多半**：终端要重开、C++ 工具链要装、代理要绕、端口要空——把本文的坑 ①～⑪ 过一遍，能少走几天弯路。

---

*文档版本：2026-10-22，基于项目当前实际配置（Tauri 2 / React 19 / Vite 7 / Rust 1.95）整理；脚本清单、目录结构与 `package.json` / `tauri.conf.json` 已逐项核对。配置如有变更请同步更新本文。*
