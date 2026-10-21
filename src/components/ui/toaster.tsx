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

  return (
    <>
      {toasts.map((item) => {
        const kind = (item.type as ToastKind) ?? "info";
        const { icon: Icon, bar, ink } = META[kind] ?? META.info;

        return (
          <Toast.Root
            key={item.id}
            toast={item}
            className={cn(
              "relative flex items-start gap-2.5 overflow-hidden rounded-xl bg-card py-3 pr-2 pl-4",
              "text-card-foreground ring-1 ring-foreground/10 shadow-overlay",
              "transition-[opacity,transform] duration-200 ease-standard",
              "data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0",
              "data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0",
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
              className="focus-ring -mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
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
