import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Archive, Check, MousePointer2, Pencil, RotateCcw, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { CursorGrid } from "@/components/theme/CursorGrid";
import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import { useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

interface ThemeDetailProps {
  theme: CursorTheme;
}

export function ThemeDetail({ theme }: ThemeDetailProps) {
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const applyTheme = useThemeStore((s) => s.applyTheme);
  const restoreDefault = useThemeStore((s) => s.restoreDefault);
  const deleteTheme = useThemeStore((s) => s.deleteTheme);
  const renameTheme = useThemeStore((s) => s.renameTheme);
  const exportTheme = useThemeStore((s) => s.exportTheme);
  const isActive = theme.id === activeThemeId;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!inTauri) {
      toast.info("开发模式无法导出", "保存文件需要桌面环境，请用 npm run tauri dev 启动");
      return;
    }
    setExporting(true);
    try {
      const dest = await save({
        defaultPath: `${theme.name}.zip`,
        filters: [{ name: "主题包", extensions: ["zip"] }],
      });
      if (dest) await exportTheme(theme.id, dest);
    } catch (err) {
      console.error("打开保存对话框失败：", err);
      toast.error("无法选择保存位置", "请重试，或检查目标文件夹权限");
    } finally {
      setExporting(false);
    }
  };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(theme.name);
  // 用 ref 存草稿：Esc 与失焦可能落在同一批更新里，此时读 state 会拿到旧值
  const draftRef = useRef(theme.name);

  // 切换主题或改名成功后，退出编辑态并同步草稿
  useEffect(() => {
    draftRef.current = theme.name;
    setDraft(theme.name);
    setEditing(false);
  }, [theme.id, theme.name]);

  const startEdit = () => {
    draftRef.current = theme.name;
    setDraft(theme.name);
    setEditing(true);
  };

  const commitName = () => {
    if (!editing) return;
    setEditing(false);
    const name = draftRef.current.trim();
    if (name && name !== theme.name) void renameTheme(theme.id, name);
  };

  const cancelEdit = () => {
    draftRef.current = theme.name;
    setDraft(theme.name);
    setEditing(false);
  };

  // 系统自带方案没有文件可删；正在使用的主题删掉会让注册表指向空文件
  const canDelete = !theme.is_built_in && !isActive;
  const deleteHint = theme.is_built_in
    ? "系统自带方案不能删除"
    : isActive
      ? "正在使用这个主题，请先切换到其它主题"
      : "删除此主题";

  return (
    <section className="enter-fade flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-start gap-6 p-6 pb-4">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl border bg-muted">
          <MousePointer2 className="size-10 text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {editing ? (
              <Input
                autoFocus
                value={draft}
                maxLength={40}
                aria-label="主题名称"
                className="h-9 max-w-xs text-base"
                onChange={(e) => {
                  draftRef.current = e.currentTarget.value;
                  setDraft(e.currentTarget.value);
                }}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitName();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
              />
            ) : (
              <>
                <h2 className="truncate text-lg font-medium">{theme.name}</h2>
                {theme.is_built_in ? (
                  <Badge variant="outline">系统方案</Badge>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="重命名"
                    title="重命名"
                    onClick={startEdit}
                    className="shrink-0 text-muted-foreground"
                  >
                    <Pencil />
                  </Button>
                )}
              </>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {theme.description || `${theme.cursors.length} 个光标槽位`}
          </p>

          <div className="mt-4 flex gap-2">
            <Button onClick={() => applyTheme(theme.id)} disabled={isActive}>
              <Check data-icon="inline-start" />
              {isActive ? "当前使用中" : "应用此主题"}
            </Button>
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              <Archive data-icon="inline-start" />
              {exporting ? "导出中…" : "导出 ZIP"}
            </Button>
          </div>
        </div>
      </div>

      <Separator />

      <div className="flex-1 overflow-y-auto p-6">
        <CursorGrid theme={theme} />
      </div>

      <Separator />

      <div className="flex items-center gap-2 p-4">
        <Button
          variant="destructive"
          disabled={!canDelete}
          title={deleteHint}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 data-icon="inline-start" />
          删除此主题
        </Button>
        <Button variant="ghost" onClick={restoreDefault} disabled={!activeThemeId}>
          <RotateCcw data-icon="inline-start" />
          还原系统默认
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {theme.updated_at || "导入时间待实现"}
        </span>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>删除「{theme.name}」？</AlertDialogTitle>
          <AlertDialogDescription>
            会连同 {theme.cursors.length} 个光标文件一起删除，无法撤销。
            系统当前光标不受影响，但之后无法再切换回这个主题。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                void deleteTheme(theme.id);
              }}
            >
              确认删除
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
