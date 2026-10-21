# 设计规范 · 鼠标主题工具

> 可视化版本：`docs/design-system.html`（可直接用浏览器打开，含明暗切换）
> 动效专章：`docs/motion.md`（组件范围 / 进出场 / 降级与验收）
> Token 唯一来源：`src/App.css`
> 适用平台：Windows 10/11 桌面端（Tauri + WebView2）

---

## 0. 这份文件管什么

它不描述"界面上现在长什么样"，而是回答三个问题：

1. 遇到没见过的场景，该按什么标准做决定；
2. 什么样的写法算违规；
3. 改完之后怎么验证没跑偏。

组件怎么用，以 `src/components/ui/` 的源码为准；这份文件只说**什么时候该用哪个**。

---

## 1. 四条原则

### 原则一：平台优先

这是桌面应用，不是网页。用户每天在用 Windows 资源管理器，肌肉记忆来自系统。

- 滚动条、右键菜单、拖拽反馈、快捷键，**先对齐系统**，再谈自创。
- 自绘控件必须回答一个问题：它比系统原生好在哪？答不上来就用原生。
- 深色模式跟随系统，不自建开关。

> 反例记录：左栏曾用 `ScrollArea` 自绘滚动条，右栏用系统滚动条，同屏两种。按本原则，**应统一到系统原生**，而不是把两处都改成自绘。

### 原则二：Token 优先

颜色、间距、圆角、字号、动效，只从 `App.css` 的 token 取值。

- 写 `text-[11px]`、`bg-[#f5f5f5]`、`rounded-[7px]` 一律视为违规。
- **写不出 token 名，说明系统缺一个 token** —— 先补 token，再写样式，而不是就地写死。
- 这正是 `--text-3xs` / `--text-2xs` / `--success` / `--elev-*` 被补进来的原因。

### 原则三：状态完备

任何可交互元素必须四态齐全，缺一不可：

| 状态 | 触发 | 要求 |
|---|---|---|
| 默认 | — | 与周围元素有清晰边界 |
| 悬停 | 鼠标移入 | 有反馈，但不改变布局尺寸 |
| 焦点 | **仅键盘** Tab | 3px `ring`，**不透明**，对比度 ≥ 3:1，鼠标点击不出现 |
| 禁用 | 不可用 | `opacity-50` + `cursor-not-allowed`，且不响应点击 |

键盘焦点不是可选项。**凡是 Tab 能停住的地方，必须看得见。**

> 焦点环不要用半透明。shadcn 默认 `ring-ring/50` 在浅色底上实测仅约 1.3:1，等于没有。`--ring` 已调深到 `oklch(0.55)` 并去掉透明度，实测 3.6:1。

### 原则四：布局归 Tailwind，控件归 shadcn

判断标准只有一条：**这个元素有没有"状态"需要管理？**

- 有状态（悬停/焦点/禁用/选中/展开）→ 用 `components/ui` 的组件。
- 没有状态，只负责摆位置和分层级 → 用原生标签 + Tailwind。

所以 `<div>` 占多数是正常的，不是欠债。shadcn 刻意不提供 Box/Stack/Grid，布局本来就该由 Tailwind 承担。

唯一的红线：**同一个界面里，同类控件必须同一种实现**。侧栏的"导入主题"用 `<Button>`，紧挨着的三个导航项却手写 `<button>`，这就违规——不是因为它用了原生标签，而是因为同类不同源。

---

## 2. Token 清单

### 色彩

| Token | 明 | 暗 | 用途 |
|---|---|---|---|
| `background` | oklch(1 0 0) | oklch(0.145 0 0) | 窗口底 |
| `card` | oklch(1 0 0) | oklch(0.205 0 0) | 卡片面 |
| `muted` | oklch(0.97 0 0) | oklch(0.269 0 0) | 预览底、占位 |
| `accent` | oklch(0.97 0 0) | oklch(0.269 0 0) | 选中态 |
| `primary` | oklch(0.205 0 0) | oklch(0.922 0 0) | 主操作（整屏 1 个） |
| `border` | oklch(0.922 0 0) | oklch(1 0 0 / 10%) | 1px 描边 |
| `muted-foreground` | oklch(0.556 0 0) | oklch(0.708 0 0) | 次要文字 |
| `ring` | oklch(0.55 0 0) | oklch(0.556 0 0) | 焦点环（不透明） |
| `success` | oklch(0.55 0.13 152) | oklch(0.72 0.15 152) | 导入成功、已应用 |
| `warning` | oklch(0.75 0.15 78) | oklch(0.80 0.14 78) | 格式降级 |
| `destructive` | oklch(0.577 0.245 27.325) | oklch(0.704 0.191 22.216) | 删除 |
| `info` | oklch(0.55 0.16 255) | oklch(0.70 0.14 255) | 说明性提示 |
| `preview-bg` | oklch(0.965 0 0) | oklch(0.235 0 0) | 光标预览底 |
| `preview-checker` | oklch(0.925 0 0) | oklch(0.275 0 0) | 棋盘格交错色 |

**状态色只用于反馈，不能当按钮主色**，否则用户会误判可点性。

### 字号

| Token | px / 行高 | 用途 |
|---|---|---|
| `text-xl` | 20 / 28 | 页面主标题 |
| `text-lg` | 18 / 28 | 区块标题 |
| `text-base` | 16 / 24 | 空状态主文案 |
| `text-sm` | 14 / 20 | **默认正文** |
| `text-xs` | 12 / 16 | 次要信息 |
| `text-2xs` | 11 / 16 | 密集列表副行 |
| `text-3xs` | 10 / 14 | 仅徽章角标 |

字重只有 `400` / `500`，不使用 600 / 700。

### 间距

硬规则只有一条：**必须落在 2px 网格上**。禁用 `p-[7px]`、`gap-[13px]` 这类随手写的任意值。

| 档位 | px | 用法 |
|---|---|---|
| 主节奏（8 的倍数） | 8 / 16 / 24 / 32 / 48 / 64 | 布局级留白、卡片内边距、空状态定位 |
| 常规（4 的倍数） | 4 / 12 / 20 / 40 | 列表项内边距（12 最常用）、侧栏留白、输入框让位 |
| 微调 | 2 / 6 / 10 | 仅限图标与文字之间；6px 是 shadcn 按钮内置，必须放行 |

> 为什么不列白名单：初版只允许 8 档，把 `pt-5`(20)、`pl-10`(40)、`mt-16`(64) 全判成违规，但它们都是合理值。规范的职责是挡住"随手写"，不是把合理选择也禁掉。

### 圆角

`--radius: 10px` 为基准，派生：`md 6px`（徽章）、`lg 8px`（按钮/输入）、`xl 14px`（卡片）、`full`（胶囊）。

### 层次

| Token | 用于 | 手法 |
|---|---|---|
| 无（flat） | 底色、分隔线 | 只用 border |
| `shadow-raised` | 主题卡、光标卡 | 1px ring + 极淡阴影 |
| `shadow-overlay` | 弹窗、下拉、Toast | 1px ring + 投影 |

同一元素只用一种手法，**不要既 border 又 ring**。

浮层层级：Toast `z-60` > 弹窗 `z-50` > 下拉/浮层 `z-40` > 页面内容 `z-0`。Toast 永远在最上层，因为它可能在弹窗打开时出现。

### 动效

| 档位 | 时长 | 曲线 | 用于 |
|---|---|---|---|
| fast | 120ms | `ease-standard` | 悬停变色、焦点环、按下 |
| base | 180ms | `ease-standard` | 选中切换、描边变化、堆叠让位 |
| slow | 240ms | `ease-standard` | 浮层入场（弹窗、Toast） |
| exit | 160ms | `ease-exit` | 浮层退场，比入场短 1/3 |

`ease-standard = cubic-bezier(0.2, 0, 0, 1)`、`ease-exit = cubic-bezier(0.4, 0, 1, 1)`

**禁止 `transition-all`** —— 会把布局属性一起过渡。改为明确写属性列表，例如 `transition-[opacity,translate]`。

组件级的进入 / 退出 / 状态切换清单、以及哪些组件**故意不做**动效，见 [`docs/motion.md`](./motion.md)。

---

## 3. 本产品专属：光标预览面

光标多为透明 PNG，**纯色底会让白色光标消失**，所以预览底必须是棋盘格。

| 项 | 值 |
|---|---|
| 格子尺寸 | 8px，两色交错 4px |
| 格子对比 | ΔL ≈ 4%（压到几乎看不见，避免抢戏） |
| 主题卡预览区 | `h-16`（64px） |
| 槽位卡预览区 | `h-12`（48px） |
| 光标图最大边 | 48px |
| 实现 | `preview-surface` utility |

用法：

```tsx
<div className="preview-surface flex h-16 items-center justify-center rounded-lg">
  <CursorPreviewImage slot={cover} />
</div>
```

---

## 4. 使用约定速查

| 场景 | 做法 |
|---|---|
| 排列、分组、留白 | 原生 `div` + Tailwind |
| 有悬停/焦点/禁用态 | `components/ui` 组件 |
| 整卡可点、卡内无交互元素 | `<button>` 包整卡可接受，但必须带 `focus-ring` 和 `aria-pressed` |
| 卡内将来要加按钮 | 改用 `Card` + 内层 `<button>`，避免按钮嵌套按钮 |
| 图标按钮 | 必须带 `aria-label` |
| 导航当前项 | 必须带 `aria-current="page"` |
| 原生元素需要焦点环 | 加 `focus-ring` utility |
| 删除等不可恢复操作 | 必须先过 `AlertDialog` 确认 |
| 确认弹窗文案 | 说清删什么、删几个、能不能恢复（例：「会连同 6 个光标文件一起删除，无法撤销」） |
| 重命名等轻量编辑 | 原地变成输入框，自动全选；Enter 保存、Esc 取消、失焦保存；值没变则不请求 |
| 操作结果反馈 | 用 Toast，不要只 `console.error` |
| 错误文案 | 中文主句说人话 + 括号里放技术细节；能指导下一步就写上去 |

---

## 5. 审计与回归

改完界面跑这三条，全绿才算完成：

```bash
node scripts/design_check.mjs   # 自动按 Tab 走一遍，查焦点环/aria/结构，并存截图
node scripts/design_audit.mjs   # 间距/字号/图标是否出现阶梯外的值
node scripts/ui_ratio.mjs       # shadcn 与原生标签比例是否合理
node scripts/motion_check.mjs   # 逐帧采样：进出场时长、中间态、降级是否生效
```

`design_check.mjs` 需要 vite 在 1420 运行。它不会点「应用此主题」，不会改系统光标。

**统计必须分维度。** 只看"图标有 7 种尺寸"会误判为混乱；拆成"内联图标"和"占位图形"两组后，尺寸与容器完全匹配，无需返工。同理，"原生标签占 69.5%" 拆开看，95% 是 shadcn 不覆盖的布局与排版。

---

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-21 | v1.0 建立。补 `success/warning/info`、`preview-bg/checker`、`elev-raised/overlay`、`text-3xs/2xs`、`ease-standard`；新增 `focus-ring` / `preview-surface` utility；新增 `prefers-reduced-motion` 降级 |
| 2026-10-21 | v1.1 首次落地。侧栏导航改用 `buttonVariants` + `aria-current`；主题卡补 `focus-ring` 并把 `border` 改为 `ring`；滚动条统一回系统原生（`ScrollArea` 停用）；`text-[10px]/[11px]` 归入 `text-3xs/2xs`；清除 `transition-all` 与 `hover:shadow-sm` |
| 2026-10-21 | v1.2 修正焦点环。`--ring` 由 `oklch(0.708)` 调深至 `oklch(0.55)`，`button/badge/input` 与 `focus-ring` 去掉了 `/50` 透明度（原件对比仅 1.3:1，不达 3:1）。**这是对 shadcn 上游样式的有意偏离，重新 add 组件后需重打。** |
| 2026-10-21 | v1.3 动效系统化。新增 `--motion-*` 四档时长与 `ease-exit`；Toast/Dialog 补齐进出场，Toast 增补堆叠 FLIP；`transition-all` 全部改为显式属性列表（含 shadcn 的 button/badge）；新增 `docs/motion.md` 与 `scripts/motion_check.mjs`。**button/badge/input 的过渡属性是对上游的再次偏离，重新 add 后需重打。** |
