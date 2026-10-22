import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

interface ThemeNameFieldProps {
  theme: CursorTheme;
  /** 名称的排版类由调用方决定（检查器用 h2 的字号，表格行内用小号） */
  nameClassName?: string;
  /** 表格行内用紧凑版：输入框更矮、铅笔更小 */
  compact?: boolean;
}

/**
 * 主题名称 + 原地重命名
 *
 * 图库检查器与「我的主题」表格共用同一份实现，避免两处各写一套
 * Enter/Esc/失焦逻辑后行为跑偏。
 *
 * 两个容易写错的地方：
 * 1. 草稿必须存 ref —— Esc 与 blur 可能落在同一批更新里，读 state 会拿到旧值，
 *    于是「取消」变成「保存」。
 * 2. 系统方案没有改名入口（改了也只影响显示，注册表里的 SchemeName 还得重新应用）。
 */
export function ThemeNameField({ theme, nameClassName, compact = false }: ThemeNameFieldProps) {
  const renameTheme = useThemeStore((s) => s.renameTheme);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(theme.name);
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

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        maxLength={40}
        aria-label="主题名称"
        className={cn("min-w-0", compact ? "h-6 text-xs" : "h-8 text-base")}
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
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className={cn("truncate", nameClassName)}>{theme.name}</span>
      {!theme.is_built_in && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="重命名"
          title="重命名"
          onClick={startEdit}
          className={cn(
            "shrink-0 text-muted-foreground opacity-60 transition-opacity duration-(--motion-fast) ease-standard hover:opacity-100",
            compact && "size-5",
          )}
        >
          <Pencil />
        </Button>
      )}
    </span>
  );
}
