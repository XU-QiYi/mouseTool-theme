import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";

/**
 * 可关闭弹窗。与 AlertDialog 的区别：允许 Esc / 点遮罩退出，用于
 * 「看了就走」的任务层界面（诊断中心、导入中心）；删除这类不可恢复
 * 操作仍然走 AlertDialog——那里必须明确选一个动作。
 */
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogContent({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Popup>) {
  return (
    <DialogPrimitive.Portal>
      {/* 遮罩先淡入、后淡出；比弹窗本身快一档，避免"两层一起慢慢变" */}
      <DialogPrimitive.Backdrop
        data-slot="dialog-backdrop"
        className={cn(
          "fixed inset-0 z-50 bg-black/40 transition-opacity duration-(--motion-base) ease-standard",
          "data-[starting-style]:opacity-0",
          "data-[ending-style]:duration-(--motion-exit) data-[ending-style]:ease-exit data-[ending-style]:opacity-0",
        )}
      />
      {/* 以中心为原点缩放：居中元素不加位移，否则会和 -translate 的居中打架 */}
      <DialogPrimitive.Popup
        data-slot="dialog-popup"
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
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-base font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("mt-2 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogTitle, DialogDescription };
