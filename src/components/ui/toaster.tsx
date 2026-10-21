import { useLayoutEffect, useRef } from "react";
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
  return (
    <Toast.Provider toastManager={toastManager} limit={3}>
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  const register = useStackShift(toasts);

  return (
    <>
      {toasts.map((item) => {
        const kind = (item.type as ToastKind) ?? "info";
        const { icon: Icon, bar, ink } = META[kind] ?? META.info;

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
