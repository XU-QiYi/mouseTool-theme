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

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {theme && (
        <AlertDialogContent>
          <AlertDialogTitle>删除「{theme.name}」？</AlertDialogTitle>
          <AlertDialogDescription>
            会连同 {theme.cursors.length} 个光标文件一起删除，无法撤销。
            系统当前光标不受影响，但之后无法再切换回这个主题。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onOpenChange(false);
                void deleteTheme(theme.id);
              }}
            >
              确认删除
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
