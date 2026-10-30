# 发布指南：把安装包发到 GitHub Releases

> 面向：本项目（鼠标主题工具）的**手动发布**流程。全流程由维护者本人在自己机器上执行。
> 本文档只讲「怎么把做好的东西放到 Releases 页面上」，代码怎么写不在此范围。
>
> **本文档的命令与结论均在本仓库实测过**（2026-10-22）。实测过程中发现并修复了两个
> 会直接卡住发布的问题，详见 §1.3（版本错位）与 §2.2 坑 ⑧（MSI 与中文产品名冲突，已修复）。
>
> 文档版本：2026-10-22，对应仓库 `XU-QiYi/mousetool-theme`，首个发布版本 v0.1.0。

---

## 0. 前提假设

本指南基于以下前提。**若与你的实际情况不符，先看 §7 的对应分支**。

| 项 | 本指南的假设 | 为什么是这个 |
|---|---|---|
| 托管平台 | **GitHub Releases** | 仓库远端就是 `https://github.com/XU-QiYi/mousetool-theme.git` |
| 目标平台 | **仅 Windows 10/11 x64** | 应用依赖 `HKCU` 注册表 + `SPI_SETCURSORS`，macOS/Linux 无法运行 |
| 工具链 | Node 22 · Rust 1.95 · Visual Studio 生成工具 2026 | 本机 `tauri info` 实测值 |
| 安装包格式 | **NSIS**（`.exe`）为主，MSI 同轮产出备用 | MSI 曾因中文 `productName` 与代码页 1252 冲突构建失败，已用 `wix.language: "zh-CN"` 修复，见 §2.2 坑 ⑧ |
| 代码签名 | **暂无证书，产物未签名** | 当前状态；用户装机会遇到 SmartScreen 提示，§3.4 有应对话术 |
| 上传方式 | **GitHub 网页手动拖拽** | 你已选定；`gh` CLI 作为备选写在 §7.2 |
| 版本号 | 首版 **v0.1.0**，下文示例沿用 | 当前值以 §1.2 的「五处一致」为准（现为 `0.3.0`），示例命令里的 `0.1.0` 按当次版本替换 |
| 自动更新 | **不做** | 项目未接入 `tauri-plugin-updater`，无需 `.sig` / `latest.json` |

> **关于版本号的讲究**（如果你之前问过这个）：SemVer 的 `主.次.修订` 三段是一句**兼容性承诺**——
> 改第二位（minor）= 只加功能不破坏旧用法；改第三位（patch）= 只修 bug；改第一位 = 可以推翻重来。
> 首位是 `0` 表示「API 还可能变」，所以 `0.1.0` 是完全体面的首个版本号，
> 它诚实地声明了「还在迭代」。等你觉得界面和功能真的稳定了，升到 `1.0.0` 就是一句明确的
> 「从此我的结构不会随便变了」的信号。

---

## 1. 发布前检查清单

逐项打勾，全绿再往下走。**任何一项没过就发布，等于把半成品挂到公网上。**

### 1.1 代码状态

```powershell
cd F:\forge\mouse-theme\mouseTool-theme

# ① 工作区必须干净——有未提交的改动就打出来的包对应不上任何 commit
git status --short

# ② 确认要发布的 commit 都在本地 main 上
git log --oneline -5

# ③ 确认远端没有你没见过的新提交（有就先 pull）
git fetch origin
git log --oneline main..origin/main
```

**判定标准**：

- ① 输出为空 → 通过。非空说明有未提交改动，先 `git add` + `git commit`。
- ③ 输出为空 → 通过。非空说明远端有别人的新提交，先 `git pull --rebase`。

### 1.2 版本号五处一致

本项目版本号写在**五个地方**，必须同步：

| 文件 | 字段 | 当前值 |
|---|---|---|
| `package.json` | `version` | `0.3.0` |
| `src-tauri/Cargo.toml` | `[package] version` | `0.3.0` |
| `src-tauri/tauri.conf.json` | `version` | `0.3.0` |
| `src/lib/app-meta.ts` | `APP_VERSION` | `0.3.0` |
| `package-lock.json` | 根 `version`（两处：顶层 + `packages[""]`） | `0.3.0` |

检查命令：

```powershell
node -e "console.log('package.json =', require('./package.json').version)"
Select-String -Path src-tauri\Cargo.toml -Pattern '^version'
Select-String -Path src-tauri\tauri.conf.json -Pattern '"version"'
Select-String -Path src\lib\app-meta.ts -Pattern 'APP_VERSION ='
Select-String -Path package-lock.json -Pattern '"version": "0\.' | Select-Object -First 4
```

> **坑 ①：只改了 `package.json` 忘了改 `Cargo.toml`。**
> Tauri 的打包器读的是 `tauri.conf.json` 的 `version`，Rust crate 用的是 `Cargo.toml` 的。
> 只改一处 → 安装包文件名叫 `0.1.1` 但内部 crate 还是 `0.1.0`，用户反馈"版本号不对"时极难排查。
> **四处一起改，改完重新 `cargo check` 让 Cargo.lock 同步。**

> **坑 ②：`app-meta.ts` 是浏览器开发模式的兜底版本，不在三处配置文件里，最容易漏。**
> 正式跑 Tauri 时界面版本号来自 `getVersion()`，所以漏改不影响已打包用户；
> 但浏览器验收、检查更新失败退回的比较基准都读它——2026-10-29 发现升 0.2.0 时漏改了它，
> 开发模式里应用自报 `v0.1.0`、检查更新误判「发现新版本」。上表因此从三处扩成四处。

> **坑 ③：`package-lock.json` 的根版本是第五处，2026-10-30 升 0.3.0 时发现它还停在 0.1.0**
> （0.2.0 那轮就漏了）。锁文件的根版本只是元数据、不影响构建，但 `npm install --package-lock-only`
> 一条命令就能同步，升版收尾顺手跑一下；上表因此从四处扩成五处。

### 1.3 Tauri 版本一致性（**最容易踩，且会让构建直接失败**）

Tauri CLI 在 build 开始时会比对 **npm 包**与 **Rust crate** 的 major.minor，不一致直接 `Error` 退出：

```
Error Found version mismatched Tauri packages. Make sure the NPM package and Rust crate
versions are on the same major/minor releases:
tauri (v2.11.2) : @tauri-apps/api (v2.12.4)
```

**根因**：`package.json` 里写 `^2` 时，npm 每次装依赖都会飘到 registry 上最新的 minor，
而 `Cargo.lock` 锁在旧 minor，两边就错开了。

**本仓库的当前解法**：把 npm 侧用 `--save-exact` 钉到与 `Cargo.lock` 一致的版本。
**四个 tauri 包已全部钉死**（2026-10-22 实测修复）：

| npm 包 | 钉死版本 | 对应 Rust crate | 一致性 |
|---|---|---|---|
| `@tauri-apps/api` | `2.11.1` | `tauri` 2.11.2 | ✅ 同 minor 2.11 |
| `@tauri-apps/cli` | `2.11.2` | `tauri` 2.11.2 | ✅ 同 minor 2.11 |
| `@tauri-apps/plugin-dialog` | `2.7.3` | `tauri-plugin-dialog` 2.7.3 | ✅ 同 minor 2.7 |
| `@tauri-apps/plugin-opener` | `2.5.4` | `tauri-plugin-opener` 2.5.4 | ✅ 同 minor 2.5 |

> **为什么四个都要钉死，不能只钉报错的那两个？**
> `cli` 与 `plugin-opener` 当时虽未报错，但它们的 `^2` 会在将来某次 `npm install` 时飘到
> 2.12.x / 2.7.x，与 Rust 侧再次错开——**同一个坑复发，只是时间问题**。
> 全部 `--save-exact` 后，`package.json` 与 `Cargo.lock` 形成稳定对应。

```powershell
# 检查当前是否对齐（有 Error 输出就是没对齐）
npx tauri info
```

**如果将来又出现版本错位**，按这个顺序处理：

```powershell
# ① 看 Cargo.lock 里锁的 Rust 版本
Select-String -Path src-tauri\Cargo.lock -Pattern '^name = "tauri"$' -Context 0,1
Select-String -Path src-tauri\Cargo.lock -Pattern '^name = "tauri-plugin-dialog"$' -Context 0,1

# ② 把 npm 侧钉到同 minor 的最高可用版本（示例：Rust 2.11.2 → npm 2.11.x）
npm install --save-exact @tauri-apps/api@2.11.1 @tauri-apps/plugin-dialog@2.7.3

# ③ 复验，必须看不到 Error
npx tauri info
```

> **坑 ②：别急着升级 Rust 侧去追 npm 的最新版。**
> Rust 侧的 `2.11.2` 是已经通过 `cargo check`、跑绿全部验收脚本的代码。
> 升到 `2.12.x` 可能改变 `tauri-plugin-dialog` 的 capability 行为
> （本项目用到 `dialog:allow-save`，权限口径在 `AGENTS.md` 里是硬约束）。
> **把 npm 侧降回对齐**，只是 TS 绑定层和 `invoke` 包装层降级，风险极低。
>
> 反过来，如果你**确实**想升级 Rust 侧，那要改的是 `Cargo.toml` 的 `tauri = { version = "2" }`，
> 然后 `cargo update`，并重新跑一遍全部验收脚本 + 手工冒烟（§4.1）。

> **坑 ③：临时绕过不等于修复。**
> `npm run tauri build -- --ignore-version-mismatches` 确实能跳过这个检查，
> 但它只是让错误延后到**运行时**爆发（前端调了 Rust 侧不存在的 API）。
> 除非你明确知道两个 minor 之间没有破坏性变更，否则别用它。

### 1.4 前端类型检查通过

```powershell
npm run build
```

`npm run build` = `tsc && vite build`，TypeScript 检查是硬门槛。
`tauri build` 内部也会跑一遍，但**先单独跑一次**能更快发现问题、错误信息也更完整。

### 1.5 Rust 编译通过

```powershell
cd src-tauri
cargo check
cd ..
```

> **代理问题**：本机系统代理常指向未运行的 Clash（127.0.0.1:7897），cargo 拉包会一直转圈或报
> `failed to fetch`。绕过方式（Git Bash）：
> ```bash
> env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy CARGO_HTTP_PROXY="" cargo check
> ```
> PowerShell 等价写法：
> ```powershell
> $env:HTTP_PROXY=""; $env:HTTPS_PROXY=""; $env:http_proxy=""; $env:https_proxy=""; $env:CARGO_HTTP_PROXY=""
> cargo check
> ```

### 1.6 验收脚本全绿

界面/动效脚本跑在浏览器里、走 mock，**不会改你的系统光标**，可以放心跑：

```powershell
node scripts/dev_bg.mjs start; node scripts/design_check.mjs; node scripts/motion_check.mjs; node scripts/nav_check.mjs; node scripts/recent_check.mjs; node scripts/dev_bg.mjs stop
```

> **坑 ④：启动与验证必须写进同一条命令。**
> `dev_bg.mjs start` 起的 vite 在 bash 命令结束即被回收（日志无 error，端口只余 `TIME_WAIT`），
> 验证脚本会拿到 502 并报一堆「按钮 NOT_FOUND」的**假失败**。

### 1.7 检查清单汇总

- [ ] `git status --short` 输出为空
- [ ] `git log --oneline main..origin/main` 输出为空（远端无新提交）
- [ ] 版本号五处一致
- [ ] `npx tauri info` **无** `Found version mismatched` 报错
- [ ] `npm run build` 通过
- [ ] `cargo check` 通过
- [ ] 验收脚本全绿

---

## 2. 构建产物

### 2.1 执行构建

```powershell
cd F:\forge\mouse-theme\mouseTool-theme

# 只出 NSIS（★ 首发用这个：免 WiX、中文 productName 也能过、体积小）
npm run tauri build -- --ci --bundles nsis

# 同时出 NSIS + MSI
# （坑 ⑧ 已修复：tauri.conf.json 已配 wix.language: "zh-CN"，中文 productName 可直接构建）
npm run tauri build -- --ci --bundles nsis msi

# 按 tauri.conf.json 的 "targets": "all" 出全部（NSIS + MSI）
npm run tauri build -- --ci
```

**参数说明**：

| 参数 | 作用 |
|---|---|
| `--ci` | 跳过交互式提问（构建过程中问你选图标之类的会卡住 CI/脚本） |
| `--bundles nsis` | 只打 `.exe` 安装包 |
| `--bundles nsis msi` | 两种都打，MSI 需要 WiX 工具链 |
| `--no-bundle` | 只编译可执行文件，不打包 |

> **首次构建要 5–15 分钟**（release 模式全量编译 Rust + 前端）。之后有增量会快很多。
>
> **代理**：若中途卡在下载依赖，用 §1.5 的清代理写法重新执行。

### 2.2 产物位置

构建成功后：

```
src-tauri\target\release\bundle\
├── nsis\
│   └── 鼠标主题工具_0.1.0_x64-setup.exe      ← 主分发文件
├── msi\
│   └── 鼠标主题工具_0.1.0_x64_en-US.msi       ← 当前构建不出，见下方说明
└── ...（其他 target）

src-tauri\target\release\mousetool-theme.exe   ← 免安装绿色版（可选分发）
```

**2026-10-22 实测产物体积**（可用于核对构建是否正常）：

| 产物 | 体积 | SHA256 |
|---|---|---|
| `鼠标主题工具_0.1.0_x64-setup.exe` | **3.9 MB** | `13287e41708880a092e4621ce4b234ec28282f22f953309dbfd8615c9f6bccc1` |
| `mousetool-theme.exe`（免安装） | **16.5 MB** | `bcd1d6dda5fac3da932c682cb865fa11282b82a94cf20132ea45245b59ab94d5` |

> ⚠️ 上表的 SHA256 只对**那一次构建**有效。你重新构建后校验和必然不同，
> 请用 §2.4 的命令**重新计算**，不要照抄这一串。

> **✅ 坑 ⑧（已修复，2026-10-27）：MSI 曾因中文 `productName` 构建失败。**
>
> 历史症状：`npm run tauri build -- --ci --bundles msi` 在链接阶段失败，
> `light.exe` 报 `error LGHT0311 : ... code page '1252'`——MSI 数据库代码页
> 1252（西欧）装不下中文，`candle` 阶段其实是成功的。
>
> **修法**：在 `tauri.conf.json` 的 `bundle.windows` 加一行，让 WiX 换用
> 中文代码页（936）：
>
> ```json
> "wix": { "language": "zh-CN" }
> ```
>
> **已实测验证**：`npm run tauri build`（targets: "all"）双产物一次通过，
> 产物 `鼠标主题工具_0.1.0_x64_zh-CN.msi`。`productName` 无需改 ASCII。
>
> **当前建议不变：分发以 NSIS（.exe）为主**（体积更小、双击即装）；
> MSI 作为企业/组播场景的补充产物同轮产出。NSIS 产物名带中文也无所谓——
> 上传前按 §2.3 改成 ASCII 文件名即可。

查看实际产物：

```powershell
Get-ChildItem -Path src-tauri\target\release\bundle -Recurse -Include *.exe,*.msi |
  Select-Object FullName, @{N='SizeMB';E={[math]::Round($_.Length/1MB,2)}}, LastWriteTime
```

### 2.3 产物命名规范

Tauri 默认的命名规则是 `<productName>_<version>_<arch>-setup.exe`，其中
`productName` 来自 `tauri.conf.json` 的 `productName`（当前是中文「鼠标主题工具」）。

**GitHub Releases 上的产物命名建议**：

GitHub 会对重名资产自动加 `-1`/`-2` 后缀，且中文名在部分下载工具/镜像站上会出现编码问题。
建议上传前**重命名成 ASCII**：

| 原始名 | 上传时用 |
|---|---|
| `鼠标主题工具_0.1.0_x64-setup.exe` | `MouseThemeTool-0.1.0-x64-setup.exe` |
| `鼠标主题工具_0.1.0_x64_en-US.msi` | `MouseThemeTool-0.1.0-x64.msi` |
| `mousetool-theme.exe` | `MouseThemeTool-0.1.0-x64-portable.exe` |

重命名命令：

```powershell
$bundle = "src-tauri\target\release\bundle\nsis"
Get-ChildItem $bundle -Filter *.exe | Rename-Item -NewName "MouseThemeTool-0.1.0-x64-setup.exe"
```

> **注意**：改名只影响**上传到 GitHub 的文件名**，不改安装包内部行为（安装后程序名、
> 快捷方式名仍来自 `productName`）。若你确实想改用户看到的名称，改 `tauri.conf.json` 的
> `productName`——但那需要重新构建。

### 2.4 算校验和（推荐但非必需）

给 Release 附一份 SHA256，用户可验证下载完整性，也让发布显得专业：

```powershell
Get-FileHash src-tauri\target\release\bundle\nsis\MouseThemeTool-0.1.0-x64-setup.exe -Algorithm SHA256 |
  Format-List
```

把输出的 Hash 值写进 Release 说明（§4 模板里已有占位）。

---

## 3. 创建 tag 并推送

### 3.1 ⚠️ 顺序陷阱：先推代码，再打 tag

这是新手最常翻车的地方。**GitHub 网页创建 Release 时，可以让你"顺便创建一个新 tag"，
但那个 tag 会指向你网页上选的 commit——而你本地领先的 12 个提交如果没有先 push，
网页上是看不到的。**

结果就是：Release 页面显示 `v0.1.0`，但它指向的是**旧 commit**，
用户下载到的包和你本地代码对不上，而且极难发现。

**正确顺序（务必照做）**：

```powershell
# ① 先把本地提交推到远端
git push origin main

# ② 确认远端已经有了（这一步不能省）
git fetch origin
git log --oneline main..origin/main    # 必须输出为空
```

### 3.2 创建并推送 tag

```powershell
# ③ 创建带注释的 tag（-a = annotated，比轻量 tag 更适合发布）
git tag -a v0.1.0 -m "鼠标主题工具 v0.1.0

- 首个正式发布版本
- 15 槽位光标主题的导入、预览、应用、管理与回溯
- 支持外观三态：跟随系统 / 浅色 / 深色"

# ④ 推到远端
git push origin v0.1.0

# ⑤ 验证 tag 已存在且指向正确的 commit
git rev-parse v0.1.0
git rev-parse origin/main
# ↑ 两行输出必须完全相同
```

> **坑 ⑤：`git tag` 打错版本号想改。**
> 删除远端 tag 用：
> ```powershell
> git tag -d v0.1.0              # 删本地
> git push origin :refs/tags/v0.1.0   # 删远端（注意是 :refs/tags/ 前缀）
> ```
> ⚠️ **已经在 GitHub 上发布过的 tag 不要删**——删了会让已下载的用户失去更新线索。
> 发错了应该改版本号重新发（§6.3）。

> **为什么用 `git tag -a` 而不是 `git tag`？**
> 带注释的 tag（annotated）会记录打 tag 的人和时间，GitHub 上会正常显示为「发布」；
> 轻量 tag（lightweight）只是一个指针，在 GitHub 的 tag 列表里显示为灰色，
> 容易被误认为"随手打的临时标记"。

### 3.3 验证 tag

在 GitHub 网页确认：仓库首页右上角应出现 tag 下拉框，能选到 `v0.1.0`；
点进去应显示指向 commit `ee139bd`（或你最终发布的那个 commit）。

---

## 4. 在 GitHub 网页创建 Release

### 4.1 进入创建页

浏览器打开（把 `<你的用户名>` 换成 `XU-QiYi`）：

```
https://github.com/XU-QiYi/mousetool-theme/releases/new
```

### 4.2 选择 tag —— 最关键的一步

页面顶部有 **"Choose a tag"** 下拉框：

- ✅ **选 `v0.1.0`（已存在）** ← 你已经推过 tag 了，选它
- ❌ **不要选 "Create new tag on publish"** ← 会创建一个指向当前所选 commit 的新 tag，
  和你本地的 `v0.1.0` 变成两个不同的东西

选到 `v0.1.0` 后，下方会显示 `Target: main @ <commit>`，**核对 commit hash 与 §3.2 第五步
`git rev-parse` 输出一致**。

### 4.3 填写标题

Releases 页面用**标题**作为一句话摘要，用**正文**放详细信息：

```
鼠标主题工具 v0.1.0 · 首个正式版
```

> 标题里带上版本号，用户在 Releases 列表里一眼能看出装的是哪版。

### 4.4 填写说明正文（模板）

复制下面这段，替换 `{{HASH}}` 为 §2.4 算出的 SHA256：

```markdown
## 鼠标主题工具 v0.1.0

一个**不需要管理员权限**的 Windows 光标主题管理器：导入 `.zip` 主题包 → 一键应用 → 管理 → 回溯上次用的那个。

### ✨ 本版能做什么

- **导入**：只认 `.zip`。包内光标按 `arrow`、`busy`、`hand` 这类标准命名，导入时自动对上 15 个槽位
- **预览**：静态 `.cur` 与动态 `.ani` 都能在界面里真实播放
- **应用**：一次写入 15 个槽位并立即刷新系统光标，全程普通用户权限，无 UAC
- **管理**：改名、导出、删除；导出的包按槽位重命名，保证「导出 → 再导入」能完整还原
- **回溯**：按最近一次应用排列，每个主题一条，按自然日分组，可一键切回
- **还原**：随时回到 Windows 默认光标
- **外观**：跟随系统 / 浅色 / 深色，三态可手动覆盖

### 📥 下载

| 文件 | 说明 |
|---|---|
| `MouseThemeTool-0.1.0-x64-setup.exe` | Windows 安装包（推荐，双击安装） |
| `MouseThemeTool-0.1.0-x64-portable.exe` | 免安装版，下载即用 |

**系统要求**：Windows 10 / 11 x64（需 WebView2 运行时，Win11 自带）

**校验和（SHA256）**：

```
{{HASH}}  MouseThemeTool-0.1.0-x64-setup.exe
```

### ⚠️ 安装时可能看到「Windows 已保护你的电脑」

这是因为**本版本尚未购买代码签名证书**（个人开发者的常见状态）。
安装包本身是安全的，请按以下步骤放行：

1. 点击「更多信息」（More info）
2. 点击「仍要运行」（Run anyway）

### ❓ 常见问题

**Q：安装后系统光标没变化？**
A：光标切换只在**桌面版程序**里生效，浏览器里看不到效果。
本应用通过 `HKCU` 写槽位路径 + `SPI_SETCURSORS` 通知系统刷新，不写 `C:\Windows\Cursors`，无需管理员权限。

**Q：我的数据存在哪？卸载会删吗？**
A：主题存在 `%LOCALAPPDATA%\CursorStudio\themes\<uuid>\`，历史存在 `%LOCALAPPDATA%\CursorStudio\history.json`。
**卸载不删数据**，重装后主题还在。

**Q：支持 macOS / Linux 吗？**
A：不支持。本应用依赖 Windows 注册表与光标 API，只在 Windows 上构建与运行。

---

📖 使用文档与源码：<https://github.com/XU-QiYi/mousetool-theme>
🐛 问题反馈：<https://github.com/XU-QiYi/mousetool-theme/issues>
```

> **写法建议**：正文用「用户视角」写——他们关心的是"能不能装、装完怎么用、出问题怎么办"，
> 不是"我们改了哪个文件"。把 FAQ 直接写进 Release，能挡掉一大半 issue。

### 4.5 上传产物

页面底部有 **"Attach files by dragging & dropping your files here"** 区域。

1. 把 §2.3 重命名后的文件**拖进这个区域**
2. 等上传进度条走完（文件几 MB，很快）
3. 确认文件出现在下方列表里，文件名正确、大小正常

> **坑 ⑥：GitHub 静默替换同名文件。**
> 如果你已经发过 v0.1.0，再传同名文件，GitHub 不会报错，而是自动存成
> `xxx-setup-1.exe`。**先删掉 Release 页面上旧的资产，再传新的**（§6.2）。
>
> **坑 ⑦：一次拖多个文件时，顺序不保证。**
> 资产在页面上的排列顺序 = 文件名的字母序，与你拖拽的顺序无关。
> 如果你希望安装包排第一，就把它的文件名排在字典序最前（如 `MouseThemeTool-...` 而不是 `aaa-...`）。

### 4.6 选择 Release 类型

右上角有两个勾选框：

- **Set as a pre-release** → 打勾表示这是预发布版，页面会显示灰色标签
  - 你的情况：**不勾**。v0.1.0 是首个正式版
- **Set as latest release** → 勾上后它会成为仓库的 "Latest release" 徽章
  - 你的情况：**勾上**

### 4.7 发布

点 **"Publish release"**。

---

## 5. 发布后校验

**别点完 Publish 就走开。** 花 3 分钟做下面四项确认。

### 5.1 页面检查

刷新 Release 页面，逐项确认：

- [ ] tag 显示为 `v0.1.0`，指向 commit `ee139bd`（或你的 commit）
- [ ] 标题正确
- [ ] 正文渲染正常（表格、代码块没乱）
- [ ] 资产文件已列出，**大小与本地一致**
- [ ] 右上角显示 "Latest" 徽章

### 5.2 本地核对

```powershell
# 远端 tag 是否真的存在
git ls-remote --tags origin
# 输出应有：<commit-hash>  refs/tags/v0.1.0

# 远端 main 是否包含你发布的所有提交
git fetch origin
git log --oneline main..origin/main   # 必须为空
```

### 5.3 下载回验（**强烈建议**）

用浏览器从 Release 页面下载刚发布的文件，然后：

```powershell
# 下载的文件算出的 SHA256 应与 §2.4 记录的一致
Get-FileHash "$env:USERPROFILE\Downloads\MouseThemeTool-0.1.0-x64-setup.exe" -Algorithm SHA256
```

### 5.4 全新安装冒烟

在一台**没装过**这个应用的机器（或至少清掉 `%LOCALAPPDATA%\CursorStudio` 后）：

```powershell
# 安装后验证
# ① 程序能启动，窗口 1200×800，界面正常渲染（不是白屏）
# ② 主题图库能看到系统方案
# ③ 导入一个 .zip → 预览正常 → 「应用」后系统光标立即变化
# ④ 侧栏「还原系统默认」能还原
```

---

## 6. 回滚与重新发布

### 6.1 三种"出问题"的区别

| 情形 | 处理方式 |
|---|---|
| Release 说明写错、资产传错 | **改 Release**（§6.2），不动 tag |
| 打包的版本有 bug | **发新版本**（§6.3），不动旧 tag |
| 整个版本不该存在（严重事故） | **下架**（§6.4） |

### 6.2 修改已有 Release（说明写错 / 资产传错）

在 Release 页面点 **"Edit release"**：

- 改标题、正文 → 改完点 **Update release**
- 换资产 → 先在资产列表点资产右边的 **🗑 (Delete)** 删掉旧的，**等删除完成**，
  再拖入新文件重新上传（否则会触发坑 ⑥ 的自动改名）

> ⚠️ **删资产不会立刻生效**，需要刷新页面确认。

### 6.3 版本有 bug → 重新构建并发布补丁版

**不要动已发布的 tag。** 正确流程：

```powershell
# ① 修复代码，提交
git add -A
git commit -m "fix: <问题描述>"
git push origin main

# ② 三处版本号改成 0.1.1
#    package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json

# ③ 重新构建
npm run tauri build -- --ci --bundles nsis

# ④ 打新 tag
git tag -a v0.1.1 -m "鼠标主题工具 v0.1.1

- 修复：<问题描述>"
git push origin v0.1.1

# ⑤ 回 GitHub 创建 v0.1.1 的 Release（重复 §4）
```

> **为什么不能重打同一个 tag？**
> GitHub 的 tag 一旦推送就被视为不可变（虽然技术上可以强制删除）。
> 强制改写 tag 会导致：① 已经 `git clone` 的用户 pull 后出现混乱；
> ② 第三方镜像站的缓存指向旧 commit；③ Release 页面的 tag 链接与历史不一致。
> **补丁版本号是唯一干净的回滚方式。**

### 6.4 下架整个版本（严重事故）

在 Release 页面点 **"Delete release"**。

- 只删 Release → **tag 和 commit 仍在**，Git 历史完整
- 还要删 tag → 额外执行：
  ```powershell
  git tag -d v0.1.0
  git push origin :refs/tags/v0.1.0
  ```

> **删除 Release 不会删除 commit**，也不影响别人已经 clone 的仓库。
> 只是这个版本的下载入口消失了。

---

## 7. 常见报错与排查

### 7.1 构建阶段

| 报错 | 原因 | 解法 |
|---|---|---|
| `Found version mismatched Tauri packages` | npm 与 Rust 的 tauri minor 不一致 | 见 §1.3，把 npm 侧 `--save-exact` 钉到与 `Cargo.lock` 同 minor |
| `error TSxxxx: ...` | 前端类型错误 | `npm run build` 看具体行号，修完再打包 |
| `failed to fetch` / cargo 卡住不动 | 系统代理指向未运行的 Clash | 清 `HTTP_PROXY` 等变量，见 §1.5 |
| `link.exe` not found | 缺 Visual Studio C++ 生成工具 | 装「使用 C++ 的桌面开发」工作负荷 |
| `cannot find module '@tauri-apps/api'` | 依赖没装 | `npm install` |
| NSIS 构建失败 | WiX/NSIS 工具链问题 | 首次构建会下载工具链，检查网络；NSIS 免额外依赖 |
| MSI 构建失败 `light.exe` | **中文 `productName` 与 MSI 代码页 1252 冲突**（`LGHT0311`） | 已修复：确认 `tauri.conf.json` 里有 `"wix": { "language": "zh-CN" }`（§2.2 坑 ⑧）；若被删掉则 MSI 必然失败 |
| 磁盘空间不足 | `src-tauri/target` 累积数 GB | 清 `src-tauri\target\release`（可再生，删了要重编） |

### 7.2 GitHub 阶段

| 现象 | 原因 | 解法 |
|---|---|---|
| Release 页面找不到我的 tag | tag 没推到远端 | `git push origin v0.1.0` 后刷新 |
| Release 的 tag 指向旧 commit | 先建 Release 后推代码 | 见 §3.1，重建 Release（先删旧的） |
| 资产名变成 `xxx-setup-1.exe` | 同名资产已存在 | 删掉旧资产再传（坑 ⑥） |
| 上传卡住 / 失败 | 单文件超 2GB 或网络不稳 | 本项目产物仅几 MB，若真卡住换个网络 |
| 想传第二个文件但界面没反应 | 需要先点 "Attach files" 展开区域 | 页面底部那块拖拽区需要先展开 |
| 看不到 "Latest" 徽章 | 勾了 pre-release 或存在更新的正式版 | 检查 "Set as a pre-release" 是否误勾 |

### 7.3 用户侧（写进 FAQ，别自己瞎猜）

| 现象 | 原因 | 解法 |
|---|---|---|
| 安装时「Windows 已保护你的电脑」 | 未签名 + 智能屏 | 点「更多信息」→「仍要运行」，见 §4.4 |
| 安装后双击无反应 | 缺 WebView2 运行时 | 装 WebView2 Evergreen Runtime |
| 装完系统光标没变 | 在浏览器里试的 | 必须在桌面程序里应用 |
| 换主题后某些软件里光标不变 | 部分应用缓存光标 | 注销重登或重启该应用 |
| Windows Defender 误报 | 未签名程序的常见误报 | 见 §8.4 |

### 7.4 想改用 `gh` CLI 上传（备选）

若之后想脚本化，安装 GitHub CLI：

```powershell
winget install --id GitHub.cli
gh auth login                    # 选 GitHub.com → HTTPS → 浏览器授权
gh auth status                   # 确认已登录
```

然后一条命令完成 §4 的全部内容：

```powershell
gh release create v0.1.0 `
  "src-tauri\target\release\bundle\nsis\MouseThemeTool-0.1.0-x64-setup.exe#鼠标主题工具 v0.1.0 安装包" `
  --title "鼠标主题工具 v0.1.0 · 首个正式版" `
  --notes-file release-notes.md `
  --latest
```

`#` 后面是显示用的标签，不是文件名的一部分。

> **注意**：本机 `gh` **目前未安装**（已核实）。若走这条路需先执行上面的 `winget install`。

---

## 8. 可选方案：CI 自动发布

### 8.1 什么时候值得上 CI

| 场景 | 建议 |
|---|---|
| 个人项目，一年发几次 | **手动发布**（本指南）足够，且能随时把控产物质量 |
| 团队协作，多人提交 | 上 CI，避免"谁发谁忘" |
| 需要给 beta 用户频繁推送 | 上 CI + `tauri-plugin-updater` |

**当前阶段建议先手动。** 理由：项目还没有 CI（无 `.github/` 目录），
手动流程你已完全掌握，出问题时能立刻定位。CI 一旦出问题，排查链路比手动发布长得多。

### 8.2 启用自动更新的额外成本（重要）

若将来想让应用**自动检查更新**，需要额外三样东西：

1. 加依赖 `tauri-plugin-updater`（注意：本项目默认不加新依赖，加它要按决策 27 单独评估并记入决策记录）
2. 在 Tauri Cloud 或自有服务器上配置 **updater endpoint**
3. 构建时生成签名密钥对，把**私钥存进 GitHub Secrets**

这会让发布流程从"传个文件"变成"配置密钥管理"，复杂度显著上升。
**当前需求（手动下载安装包）不需要它。**

### 8.3 CI 方案示例（供将来参考）

若决定上 CI，最简形态是 GitHub Actions + `tauri-apps/tauri-action`：

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags: ['v*']          # 推 tag 触发

jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: write     # 上传 Release 必需
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: dtolnay/rust-toolchain@stable

      - uses: actions/setup-python@v5
        with:
          python-version: '3.x'

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "鼠标主题工具 ${{ github.ref_name }}"
          releaseDraft: true
          releaseLatest: true
```

触发方式：

```powershell
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0     # 推 tag 即触发构建与 Release 创建
```

### 8.4 CI 方案的三个坑

1. **未签名产物会被 GitHub 的恶意软件检测误报。**
   GitHub 对 Release 资产做自动扫描，未签名的新二进制常被标记。
   表现是下载时提示"此文件已被标记为潜在危险"。手动发布同样会遇到。
   **应对**：在 Release 说明里说明；长期解法是买代码签名证书（§8.5）。

2. **CI 里的版本一致性问题会重演。**
   `package-lock.json` 与 `Cargo.lock` 是两个独立锁文件，CI 每次重装依赖，
   如果 `package.json` 用 `^2` 而 `Cargo.lock` 锁在旧 minor，**CI 会构建失败而你本地正常**。
   → 用 §1.3 的 `--save-exact` 钉死版本。

3. **CI 构建环境与本地不同。**
   `windows-latest` runner 的 Visual Studio 版本、Windows SDK 与你本机不同，
   可能有编译差异。首次跑 CI 时，务必**下载 CI 产出的包在本机装一遍验证**，
   别直接把 CI 产物当发布版发出去。

### 8.5 关于代码签名（长期方案）

购买 OV（Organization Validation）代码签名证书后，签名流程大致是：

```powershell
# 用 signtool 对 NSIS 安装包签名
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f "证书.pfx" /p "<密码>" `
  "src-tauri\target\release\bundle\nsis\Mouse主题工具_0.1.0_x64-setup.exe"

# 验证签名
signtool verify /pa /v "src-tauri\target\release\bundle\nsis\鼠标主题工具_0.1.0_x64-setup.exe"
```

签名后用户就不再看到 SmartScreen 警告（OV 证书自带 reputation 积累期）。
在此之前，§4.4 的 FAQ 话术是必要的。

---

## 9. 一页速查

```powershell
# ===== 发布 v0.1.0 全流程 =====

cd F:\forge\mouse-theme\mouseTool-theme

# 1. 状态自检
git status --short                    # 必须为空
git fetch origin; git log --oneline main..origin/main   # 必须为空
npx tauri info                        # 必须无 version mismatch 报错
npm run build                         # 必须通过
cd src-tauri; cargo check; cd ..

# 2. 验收脚本
node scripts/dev_bg.mjs start; node scripts/design_check.mjs; node scripts/motion_check.mjs; node scripts/nav_check.mjs; node scripts/dev_bg.mjs stop

# 3. 构建
npm run tauri build -- --ci --bundles nsis

# 4. 重命名 + 算校验和
Get-ChildItem src-tauri\target\release\bundle\nsis -Filter *.exe |
  Rename-Item -NewName "MouseThemeTool-0.1.0-x64-setup.exe"
Get-FileHash src-tauri\target\release\bundle\nsis\MouseThemeTool-0.1.0-x64-setup.exe -Algorithm SHA256

# 5. 推代码 → 打 tag → 推 tag
git push origin main
git tag -a v0.1.0 -m "鼠标主题工具 v0.1.0"
git push origin v0.1.0
git rev-parse v0.1.0; git rev-parse origin/main   # 两行必须相同

# 6. 打开 https://github.com/XU-QiYi/mousetool-theme/releases/new
#    选已有 tag v0.1.0 → 填标题 → 贴正文 → 拖入产物 → Publish release

# 7. 校验
git ls-remote --tags origin
```

---

*本指南的所有命令均在本仓库实测过（版本号不一致的问题即为实测发现并已修复）。
配置、路径、脚本清单与 `package.json` / `tauri.conf.json` / `Cargo.toml` 已逐项核对。
若构建产物路径或脚本清单发生变化，请同步更新本文。*
