import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { BATCH_DELETE_BUSY_KEY, useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

interface BatchDeleteDialogProps {
  /** 打开期间保持非空：删到一半列表变化时，按钮与文案都还说得清 */
  themes: CursorTheme[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 批量删除确认：只说明影响范围与可恢复性，不替用户勾选任何主题 */
export function BatchDeleteDialog({ themes, open, onOpenChange }: BatchDeleteDialogProps) {
  const deleteThemes = useThemeStore((s) => s.deleteThemes);
  const busy = useThemeStore((s) => s.busy);
  const progress = useThemeStore((s) => s.batchDeleteProgress);
  const deleting = Boolean(busy[BATCH_DELETE_BUSY_KEY]);
  const fileCount = themes.reduce((sum, theme) => sum + theme.cursors.length, 0);

  const close = (next: boolean) => {
    // 删除已发出时不接受 Esc / 遮罩关闭：整批动作必须在界面上有结果
    if (!next && deleting) return;
    onOpenChange(next);
  };

  const confirmDelete = async () => {
    if (deleting || themes.length === 0) return;
    const outcome = await deleteThemes(themes.map((theme) => theme.id));
    // 部分成功也收框；全部失败时留在原地，用户看完 Toast 可以重试或取消
    if (outcome && (outcome.deleted.length > 0 || outcome.failed.length === 0)) {
      onOpenChange(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      {themes.length > 0 && (
        <AlertDialogContent
          data-batch-delete-dialog={deleting ? "deleting" : "confirm"}
          className="w-[28rem]"
        >
          <AlertDialogTitle>将 {themes.length} 套主题移入回收站？</AlertDialogTitle>
          <AlertDialogDescription>
            会连同共 {fileCount} 个已声明的光标文件一起移入回收站，可在「设置 → 数据 →
            回收站」恢复。系统当前光标不受影响，使用中的主题不会被删除。
          </AlertDialogDescription>

          <div className="scroll-thin mt-3 max-h-36 overflow-y-auto rounded-lg bg-muted/40 px-3 py-2 ring-1 ring-border/60">
            <ul className="space-y-1">
              {themes.map((theme) => (
                <li
                  key={theme.id}
                  data-batch-delete-item={theme.id}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="truncate" title={theme.name}>
                    {theme.name}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                    {theme.cursors.length} 个槽位
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {deleting && progress && (
            <p
              data-batch-delete-progress
              aria-live="polite"
              className="mt-2 text-2xs text-muted-foreground tabular-nums"
            >
              {progress.current}/{progress.total} · {progress.message}
            </p>
          )}

          <AlertDialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={deleting}>
              取消
            </Button>
            <Button
              variant="destructive"
              data-confirm-batch-delete
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "移入回收站"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
