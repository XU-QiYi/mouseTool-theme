import { FolderDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * 全窗拖入反馈：拖着文件进窗口时亮起，松手或拖出即收起
 *
 * 常挂载 + opacity 切换而不是条件渲染：拖出时也走淡出，而不是闪没；
 * `pointer-events-none` 让它不截胡任何指针事件——drop 的目标是窗口本身，
 * 遮罩只是给眼睛看的。
 */
export function DropOverlay({ active }: { active: boolean }) {
  return (
    <div
      data-drop-overlay
      aria-hidden={!active}
      className={cn(
        "pointer-events-none fixed inset-0 z-50 grid place-items-center bg-background/80",
        "transition-opacity duration-(--motion-fast) ease-standard",
        active ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-ring px-12 py-8">
        <FolderDown className="size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">松开导入 .zip 主题包</p>
        <p className="text-2xs text-muted-foreground">支持含 .cur / .ani 光标的压缩包</p>
      </div>
    </div>
  );
}
