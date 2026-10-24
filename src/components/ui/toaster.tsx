import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { Toast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";

import { toastManager, type ToastKind } from "@/lib/toast";
import { cn } from "@/lib/utils";

const META: Record<ToastKind, { icon: typeof Info; bar: string; ink: string }> = {
  success: { icon: CircleCheck, bar: "bg-success", ink: "text-success" },
  error: { icon: CircleAlert, bar: "bg-destructive", ink: "text-destructive" },
  warning: { icon: TriangleAlert, bar: "bg-warning", ink: "text-warning" },
  info: { icon: Info, bar: "bg-info", ink: "text-info" },
};

/** 与 App.css 的 --motion-base 一致：堆叠补间在 JS 里跑，拿不到 CSS 变量名 */
const FLIP_DURATION = 180;
const EASE_STANDARD = "cubic-bezier(0.2, 0, 0, 1)";

/** Toast 渲染层：挂在 App 根部，全局只需一个 */
export function Toaster() {
  const viewportRef = useRef<HTMLDivElement>(null);
  useCountdownPauseMirror(viewportRef);

  return (
    <Toast.Provider toastManager={toastManager} limit={3}>
      <Toast.Portal>
        <Toast.Viewport
          ref={viewportRef}
          data-slot="toast-viewport"
          className="fixed right-4 bottom-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

/** DOM 状态契约（App.css 的 toast-countdown 消费）：窗口失焦挂起旗标 */
const BLURRED_ATTR = "data-toast-window-blurred";
/** base-ui 无条件恢复计时器时的"放行豁免"旗标 */
const FORCE_RUN_ATTR = "data-toast-force-run";

/**
 * 倒计时条的挂起镜像 —— 必须与 base-ui 的自动关闭计时器同进退。
 *
 * base-ui 的计时器是记账式挂起：pauseTimers 存下 remaining，恢复时接着跑；条若只顾自己
 * 缩短，就会出现"条走完了、toast 还在"或反过来。挂起信号分两类：
 *
 * ① 能白嫖的：每条 toast 根上的 `data-expanded`（= hovering || focused）由 base-ui 自己打，
 *    悬停 / 键盘聚焦 / 触屏按下 / 退场收尾（收尾期 hovering 延迟清除）全覆盖 —— 直接拿它
 *    当挂起条件，不重复记账，避免两套状态机漂移。
 * ② DOM 上没有、这里补到 <html> 上的两个旗标：
 *    - `data-toast-window-blurred`：handleWindowBlur → pauseTimers，但不留任何痕迹；
 *    - `data-toast-force-run`：base-ui 在几个"交互结束"口子上**无条件** resumeTimers，
 *      哪怕 data-expanded 还挂着（鼠标移开而键盘焦点还在、或反向、以及窗口回焦）。
 *      此时条也得放行；豁免在下一个真正的挂起入口自动作废，偏差自愈且有界。
 *
 * 放行/收回的门槛逐一对齐 base-ui 的判断（focusout 只认 focus-visible、mousemove 也算
 * 重新挂起入口），错一处就是反向脱钩。已知毫秒级残差：鼠标移开恰逢退场动画进行时，
 * base-ui 会把恢复推迟到收尾结束，条会早走 ≤160ms —— 可忽略。
 */
function useCountdownPauseMirror(viewportRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    /** 镜像 base-ui 的 focused 旗标：仅键盘可见焦点算数（handleBlur 的早退条件） */
    let focusVisibleInside = false;

    // ②的"恢复口子"：窗口回焦、鼠标移开（但键盘焦点还在）、键盘焦点离开视口
    const grantRun = () => root.setAttribute(FORCE_RUN_ATTR, "");
    const onBlur = () => root.setAttribute(BLURRED_ATTR, "");
    const onFocus = () => {
      root.removeAttribute(BLURRED_ATTR);
      grantRun();
    };
    const onMouseLeave = () => {
      // handleMouseLeave 无条件 resume；此时 data-expanded 是否还在，取决于 focused 是否仍真
      if (focusVisibleInside) grantRun();
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof Node && viewport.contains(next)) return;
      if (focusVisibleInside) grantRun();
      focusVisibleInside = false;
    };

    // ②的"挂起口子"：与 base-ui 重新 pauseTimers 的入口逐一对齐
    const revokeRun = () => root.removeAttribute(FORCE_RUN_ATTR);
    const onFocusIn = (e: FocusEvent) => {
      // handleFocus 仅在 focus-visible 时 pauseTimers，且开头 `if (focused) return` ——
      // 已经聚焦时的再次 focusin 不会重新挂起，此处同样不能收回豁免，否则反向脱钩
      if (focusVisibleInside) return;
      if (e.target instanceof Element && e.target.matches(":focus-visible")) {
        focusVisibleInside = true;
        revokeRun();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      // ToastRoot 的 handlePointerDown：触屏按下才 pauseTimers
      if (e.pointerType === "touch") revokeRun();
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    viewport.addEventListener("mouseleave", onMouseLeave);
    viewport.addEventListener("focusout", onFocusOut);
    viewport.addEventListener("mouseenter", revokeRun);
    viewport.addEventListener("mousemove", revokeRun);
    viewport.addEventListener("focusin", onFocusIn);
    viewport.addEventListener("pointerdown", onPointerDown);

    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      viewport.removeEventListener("mouseleave", onMouseLeave);
      viewport.removeEventListener("focusout", onFocusOut);
      viewport.removeEventListener("mouseenter", revokeRun);
      viewport.removeEventListener("mousemove", revokeRun);
      viewport.removeEventListener("focusin", onFocusIn);
      viewport.removeEventListener("pointerdown", onPointerDown);
    };
  }, [viewportRef]);
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  const register = useStackShift(toasts);

  return (
    <>
      {toasts.map((item) => {
        const kind = (item.type as ToastKind) ?? "info";
        const { icon: Icon, bar, ink } = META[kind] ?? META.info;
        // 自动关闭时长：条长的唯一依据。缺省值与 Toast.Provider 的默认超时一致
        const timeout = item.timeout ?? 5000;

        return (
          <Toast.Root
            key={item.id}
            ref={register(item.id)}
            toast={item}
            data-slot="toast"
            className={cn(
              "relative flex items-start gap-2.5 overflow-hidden rounded-xl bg-card py-3 pr-2 pl-4",
              "text-card-foreground ring-1 ring-foreground/10 shadow-overlay",
              // 从右下角长出：位移 + 轻微缩放，origin 贴住角落，避免"整块平移"的机械感
              "origin-bottom-right transition-[opacity,translate,scale] duration-(--motion-slow) ease-standard",
              "data-[starting-style]:pointer-events-none data-[starting-style]:translate-y-2 data-[starting-style]:scale-96 data-[starting-style]:opacity-0",
              // 退场更快且加速离开：消失不该占住用户的注意力
              "data-[ending-style]:pointer-events-none data-[ending-style]:translate-y-1 data-[ending-style]:scale-98 data-[ending-style]:opacity-0",
              "data-[ending-style]:duration-(--motion-exit) data-[ending-style]:ease-exit",
            )}
          >
            {/* 状态色只做标识条，不铺满整块，避免抢走文字注意力 */}
            <span className={cn("absolute inset-y-0 left-0 w-1", bar)} aria-hidden />
            <Icon className={cn("mt-0.5 size-4 shrink-0", ink)} aria-hidden />
            <div className="min-w-0 flex-1">
              <Toast.Title className="text-sm font-medium" />
              <Toast.Description className="mt-0.5 text-xs text-muted-foreground" />
            </div>
            <Toast.Close
              className="focus-ring -mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors duration-(--motion-fast) hover:bg-muted hover:text-foreground"
              aria-label="关闭提示"
            >
              <X className="size-3.5" />
            </Toast.Close>

            {/* 倒计时条：贴底边、圆角由父级 overflow-hidden 裁出。
                时长是数据（该条 toast 的 timeout）不是动效档位，故内联注入；
                挂起/放行与 base-ui 的计时器同进退，规则见 App.css 的 toast-countdown。
                timeout ≤ 0 表示不自动关闭，没有"剩余寿命"可画 */}
            {timeout > 0 && (
              <span
                aria-hidden
                data-slot="toast-progress"
                className={cn("toast-countdown pointer-events-none absolute inset-x-0 bottom-0 h-0.5", bar)}
                style={{ animationDuration: `${timeout}ms` }}
              />
            )}
          </Toast.Root>
        );
      })}
    </>
  );
}

/**
 * 堆叠让位（FLIP）。
 *
 * base-ui 把新 toast 前插到栈顶，所以新增时已有项不动；
 * 但移除最旧一条（栈底）时，容器变矮、底边不动，上面的整体要落回一个身位 —— 不处理就是"跳一下"。
 * 这里在布局变化后量一次位置差值，用 WAAPI 把差值补回去 —— 只动 transform，不触发布局。
 *
 * 位置用 容器顶边 + offsetTop 计算，而不是直接 getBoundingClientRect：
 * 1. 元素自身正在做入场/退场的 translate，BCR 会把这段位移算进去；
 * 2. offsetTop 是相对容器的，容器整体移动时它不变，单看它会漏掉真正的位移。
 */
function useStackShift(toasts: { id: string }[]) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const tops = useRef(new Map<string, number>());
  const running = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    // 先取消上一轮：正在跑的补间会让元素停在中间态，直接量会累积偏移
    running.current.forEach((anim) => anim.cancel());
    running.current.clear();

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();

    for (const { id } of toasts) {
      const el = nodes.current.get(id);
      if (!el) continue;

      const parentTop = el.offsetParent?.getBoundingClientRect().top ?? 0;
      const top = parentTop + el.offsetTop;
      next.set(id, top);

      const prev = tops.current.get(id);
      if (reduce || prev === undefined) continue;
      // 入场/退场项自己有 translate 动画，再叠一层会互相覆盖
      if (el.hasAttribute("data-starting-style") || el.hasAttribute("data-ending-style")) continue;

      const dy = prev - top;
      if (Math.abs(dy) < 1) continue;

      running.current.set(
        id,
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
          duration: FLIP_DURATION,
          easing: EASE_STANDARD,
        }),
      );
    }

    tops.current = next;
  }, [toasts]);

  return (id: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  };
}
