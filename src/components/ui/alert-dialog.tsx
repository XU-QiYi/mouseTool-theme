import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import { cn } from "@/lib/utils";

/**
 * 确认弹窗。与 Dialog 的区别是它不能被点遮罩或按 Esc 误关，
 * 必须明确选一个动作 —— 用于删除这类不可恢复操作。
 */
function AlertDialog(props: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root {...props} />;
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Popup>) {
  return (
    <AlertDialogPrimitive.Portal>
      {/* 遮罩先淡入、后淡出；比弹窗本身快一档，避免"两层一起慢慢变" */}
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-backdrop"
        className={cn(
          "fixed inset-0 z-50 bg-black/40 transition-opacity duration-(--motion-base) ease-standard",
          "data-[starting-style]:opacity-0",
          "data-[ending-style]:duration-(--motion-exit) data-[ending-style]:ease-exit data-[ending-style]:opacity-0",
        )}
      />
      {/* 以中心为原点缩放：居中元素不加位移，否则会和 -translate 的居中打架 */}
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-popup"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-96 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2",
          "rounded-xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10 shadow-overlay",
          "origin-center transition-[opacity,scale] duration-(--motion-slow) ease-standard",
          "data-[starting-style]:pointer-events-none data-[starting-style]:scale-96 data-[starting-style]:opacity-0",
          "data-[ending-style]:pointer-events-none data-[ending-style]:scale-96 data-[ending-style]:opacity-0",
          "data-[ending-style]:duration-(--motion-exit) data-[ending-style]:ease-exit",
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("text-base font-medium", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("mt-2 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />;
}

export {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
};
