# 动效规范 · Motion

> Token 唯一来源：`src/App.css`（`--motion-*` / `--ease-*`）
> 验收脚本：`scripts/motion_check.mjs`
> 关联：`docs/design-system.md`（静态视觉）、`docs/design-system.html`（可视化）

---

## 1. 这份文件管什么

它回答三件事：

1. 哪些组件该有动效、哪些**故意不做**；
2. 每个组件的进入 / 退出 / 状态切换分别长什么样；
3. 怎么证明它真的在动 —— 而不是"我看着挺顺"。

默认前提：这是 Windows 桌面应用，动画要像系统的一部分，不要像网页特效。

---

## 2. 度量：四档时长，两条曲线

| 档位 | 时长 | Token | 曲线 | 用于 |
|---|---|---|---|---|
| fast | 120ms | `--motion-fast` | `ease-standard` | 悬停、按下、焦点环、关闭按钮 |
| base | 180ms | `--motion-base` | `ease-standard` | 状态切换、遮罩淡入、堆叠让位 |
| slow | 240ms | `--motion-slow` | `ease-standard` | 浮层入场（弹窗、Toast） |
| exit | 160ms | `--motion-exit` | `ease-exit` | 所有浮层退场 |

```css
--ease-standard: cubic-bezier(0.2, 0, 0, 1);  /* 快起慢收，Windows 的手感 */
--ease-exit:     cubic-bezier(0.4, 0, 1, 1);  /* 加速离开，读起来是"撤走" */
```

**为什么退场要单独一档、而且更短**：入场是"请你看"，可以慢；退场是"别挡路"，越拖越像卡住。退场比入场快 1/3，观感上才是干净地消失。

**位移与缩放的上限**：位移 ≤ 8px，缩放 0.96–1.0。超过这个量级，桌面端会显得轻浮；缩放过度会让文字发虚。

**硬规则**：组件里只写 `duration-(--motion-*)` 和 `ease-standard` / `ease-exit`。禁止 `duration-200` 这类裸数字，也禁止 `transition-all`。

**唯一例外：Toast 倒计时条**。它是剩余时间的**读数**，不是装饰性动效：
- 时长 = 该条 toast 的超时（3.2–6s），由组件内联 `animation-duration` 注入 —— 是数据不是档位；
- 缓动必须 `linear`：ease 会让"剩余多少"的读数失真（同样一格长度代表的秒数前后不一致）。
实现见 `src/App.css` 的 `toast-countdown`，挂起同步见 `src/components/ui/toaster.tsx`。

---

## 3. 动画化的组件范围

### 做

| 组件 | 进入 | 退出 | 状态切换 |
|---|---|---|---|
| **Toast** | 下方 8px 起、缩放 0.96→1、淡入，240ms，原点在右下 | 下沉 4px、缩到 0.98、淡出，160ms | 堆叠让位 180ms（FLIP）；关闭按钮悬停 120ms；倒计时条随剩余寿命 linear 缩短，悬停/失焦与计时器同挂起（§2 例外） |
| **AlertDialog 遮罩** | 淡入 180ms | 淡出 160ms | — |
| **AlertDialog 弹窗** | 缩放 0.96→1 + 淡入，240ms，中心原点 | 缩回 0.96 + 淡出，160ms | — |
| **Button** | — | — | 悬停/焦点 120ms；按下 1px 位移；禁用不参与 |
| **Input** | — | — | 焦点环与描边 120ms；错误态同档 |
| **ThemeCard** | — | — | 悬停/选中 180ms（ring 宽度用 box-shadow 插值，不会"跳粗"）；按下 1px |
| **侧栏导航** | — | — | 复用 Button 变体，120ms；当前项 `aria-current` |
| **Badge** | — | — | 颜色 120ms（只跟随状态色，不承载主操作） |
| **列表：骨架 → 内容** | 整体淡入 180ms（`enter-fade`） | — | — |
| **视图切换**（图库 / 我的主题 / 最近使用） | 内容区整体淡入 180ms（`enter-fade`），不做位移与缩放 | — | — |
| **检查器换选中项** | 整体淡入 180ms（`enter-fade`，`key=主题 ID` 触发重挂） | — | — |
| **详情区首次出现** | 整体淡入 180ms | — | — |

### 不做（附理由）

| 项 | 为什么不加 |
|---|---|
| 页面 / 路由转场 | 换页只做 180ms 淡入，**不做位移与缩放**：骨架三栏不动，滑动进场会让人以为整块界面在重排 |
| 光标槽位卡 hover | 它不可点。加 hover 反馈等于骗用户去点 |
| 光标预览图入场 | 每次切主题都播会晃眼；`.ani` 本身逐帧播放已经是动态的 |
| 列表逐项 stagger | 15 个槽位依次淡入会把等待感拉长，属于"表演型动效" |
| 宽高 / 位置动画 | 触发布局重排，必然掉帧。高度变化一律交给 FLIP 的 transform |
| Toast 滑动手势 | base-ui 已经用 transform 跟随指针，接管反而会打架 |
| 面板拖拽补间 | 拖分隔条是直接操作，宽度必须跟手；补间会变成"拖完再滑一段"，反而更难对准 |
| 滚动条进出场的动画 | 滚动条是系统画的，能调的只有宽度与配色；`gutter: stable` 已经消除了"出现滚动条把内容挤一下"的跳动 |
| 遮罩模糊动画 | 每帧 `backdrop-filter` 开销高，桌面端收益低 |

---

## 4. 实现要点

### 4.1 浮层：用 base-ui 的状态属性，而不是自己记开关

Base UI 的 Dialog / Toast 会在元素上打三个状态：

| 属性 | 出现时机 | 写法 |
|---|---|---|
| `data-starting-style` | 挂载后的第一帧 | 定义"从哪来"（opacity 0 / 缩放 0.96 / 下移 8px） |
| `data-ending-style` | 关闭后、卸载前 | 定义"到哪去" |
| `data-open` / 常态 | 稳定态 | 不写，靠默认值 |

```tsx
"transition-[opacity,scale] duration-(--motion-slow) ease-standard",
"data-[starting-style]:scale-96 data-[starting-style]:opacity-0",
"data-[ending-style]:scale-96 data-[ending-style]:opacity-0",
"data-[ending-style]:duration-(--motion-exit) data-[ending-style]:ease-exit",
```

**退场时长不能是 0**：base-ui 收到 `transitionend` 才卸载节点。写成 0 会收不到事件，浮层留在 DOM 里。所以 `prefers-reduced-motion` 的兜底也是压到 `0.01ms`，而不是 `0`。

**退场期间 `pointer-events: none`**：元素还要在 DOM 里待 160ms，不该继续吃点击。

### 4.2 Toast 堆叠让位：FLIP

toast 栈贴在右下角，**新的一条前插到栈顶**（base-ui 的行为），所以：

- 新增：已有几条的位置不变，**不需要**补间；
- 移除最旧一条：上面的整体落回 52px，**这里会跳**。

`src/components/ui/toaster.tsx` 的 `useStackShift` 在布局变化后量一次位置，用 WAAPI 把差值补回去：

```ts
el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
  duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)",
});
```

三个容易踩的点：

1. **位置 = `offsetParent` 的顶边 + `offsetTop`**。直接用 `getBoundingClientRect()` 会把元素自身的入场 translate 算进去；只看 `offsetTop` 又会漏掉容器的整体移动（容器贴底，变高时顶边上移）。
2. **补间前先 `cancel()` 上一轮**，否则量到的是动画中间态，误差会累积。
3. **跳过带 `data-starting-style` / `data-ending-style` 的项**，它们自己就在动，叠两套 transform 会互相覆盖。

### 4.3 状态切换：只动能不触发布局的属性

- ring 的粗细变化走 `box-shadow`（可插值），不要用 `border`（会重排，且 1px→2px 是硬跳）。
- 禁止 `transition-all`：它会把 `display`、宽高、`content-visibility` 一起卷进来。
- 父级 hover 影响子级时，把过渡写在**真正变化的元素**上。

---

## 5. 可访问性

| 要求 | 做法 |
|---|---|
| 尊重系统"减少动态" | `App.css` 全局把 `animation-duration` / `transition-duration` 压到 0.01ms，并清零 `transition-delay`；FLIP 在 JS 侧直接跳过（`matchMedia`） |
| 焦点不能被延迟 | 焦点环走 120ms 档、颜色不透明；不做 `delay` |
| 无眩晕风险 | 位移 ≤ 8px、无旋转、无视差、无自动循环播放（`animate-pulse` 在降级下只播一轮） |
| 不阻断操作 | 浮层退场期间 `pointer-events: none`；动画不改变可点区域 |
| 不缩短阅读时间 | Toast 超时仍是 3.2s / 4s / 5s / 6s，动画时长不含在判断里；悬停暂停由 base-ui 负责，倒计时条与计时器同挂起，不会"条先走完"逼人快读 |
| 不用颜色单独表意 | 状态条 + 图标 + 文案三重表达，动效只是辅助 |

---

## 6. 性能

| 约束 | 说明 |
|---|---|
| 只动合成属性 | `opacity` / `translate` / `scale` / `transform`；`box-shadow` 仅用于小面积（按钮、卡片、输入框） |
| 不跑布局动画 | 高度变化交给 FLIP；不做 `height` / `top` / `margin` 过渡 |
| 并发上限 | Toast 最多 3 条；同一时刻最多一个弹窗 |
| 不做逐帧 JS | 除 Toast 的 FLIP 一次性补间外，全部交给 CSS |
| 无 `will-change` 常驻 | 过渡本身就会提升图层；常驻只会白占显存 |
| 无 `backdrop-filter` 动画 | 模糊每帧重算，桌面低端机直接掉帧 |

---

## 7. 验收

```bash
node scripts/dev_bg.mjs start && node scripts/motion_check.mjs; node scripts/dev_bg.mjs stop
```

必须和 dev server 写在同一条命令里 —— 跨命令的 dev server 会被回收。

脚本逐帧采样，而不是单点截图，断言 33 项：

- Toast 入场/退场：是否真的在过渡、时长、中间态、位移、结束是否卸载；
- Toast 倒计时条：时长是否等于该条超时、是否随时间缩短、悬停是否真冻结、移开是否继续；
- Dialog 弹窗与遮罩：同上，且遮罩比弹窗快一档；
- Toast 让位：是否触发 FLIP、时长 180ms；
- `prefers-reduced-motion`：时长是否被压到近似 0、是否跳过 FLIP、倒计时条是否不显示；
- 控件：按钮 120ms、主题卡 180ms 且走 `box-shadow`；
- 运行期无 JS 异常。

改完动效，这条 + `design_check.mjs` 都绿才算完成。

---

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-24 | Toast 倒计时条：贴卡片底边 scaleX 1→0（时长=超时、linear —— §2 唯一例外）；挂起与 base-ui 计时器同进退（data-expanded + 窗口焦点镜像）；`motion_check` 增至 33 项断言 |
| 2026-10-21 | 建立。四档时长（fast/base/slow/exit）、两条曲线；Toast 与 Dialog 补齐进入/退出；Toast 堆叠 FLIP；`transition-all` 清零；新增 `motion_check.mjs`（28 项断言） |
