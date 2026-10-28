import { useState } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

interface DeleteThemeDialogProps {
  /** 待删除的主题；打开期间必须保持非空，否则退场动画没东西可画 */
  theme: CursorTheme | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 删除确认：检查器与表格共用同一份文案与拦截逻辑 */
export function DeleteThemeDialog({ theme, open, onOpenChange }: DeleteThemeDialogProps) {
  const deleteTheme = useThemeStore((s) => s.deleteTheme);
  const [deleting, setDeleting] = useState(false);

  const close = (next: boolean) => {
    // 删除执行中不允许 Esc / 点遮罩退出：请求已经发出，界面必须留到有结果
    if (!next && deleting) return;
    onOpenChange(next);
  };

  const confirmDelete = async () => {
    if (!theme || deleting) return;
    setDeleting(true);
    const removed = await deleteTheme(theme.id);
    setDeleting(false);
    // 成功才收框；失败时错误已经在 Toast 里，留在这里让用户重试或取消
    if (removed) onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={close}>
      {theme && (
        <AlertDialogContent data-delete-dialog={deleting ? "deleting" : "confirm"}>
          <AlertDialogTitle>删除「{theme.name}」？</AlertDialogTitle>
          <AlertDialogDescription>
            会连同 {theme.cursors.length} 个光标文件一起移入回收站，可在「设置 → 数据 →
            回收站」恢复。系统当前光标不受影响，但之后无法再切换回这个主题。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={deleting}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "确认删除"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
