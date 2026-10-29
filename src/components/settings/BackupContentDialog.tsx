import { useEffect, useMemo, useRef, useState } from "react";
import { MousePointer2, RefreshCw, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { SettingsStatusBanner } from "@/components/settings/SettingsStatusBanner";
import { appliedAtMachine } from "@/lib/themes";
import { formatBytes } from "@/lib/utils";
import { readableError, toast } from "@/lib/toast";
import {
  listBackupThemes,
  restoreThemeFromBackup,
  type BackupEntry,
  type BackupThemeEntry,
  type BackupThemeListing,
} from "@/services/settings";
import { useThemeStore } from "@/stores/themeStore";

interface BackupContentDialogProps {
  entry: BackupEntry | null;
  onClose: () => void;
}

/**
 * 备份内容：查看一份备份里有哪些主题，并按套恢复
 *
 * 与「恢复」整包合并不同：这里只解压选中的那一套，不合并使用记录，
 * 也不碰主题库里已有的同 ID 主题（决策 34）。列表只读 theme.json 与
 * 中央目录，不预览光标——那需要解压整套主题，代价与风险都不该压在浏览上。
 */
export function BackupContentDialog({ entry, onClose }: BackupContentDialogProps) {
  const themes = useThemeStore((s) => s.themes);
  const loadThemes = useThemeStore((s) => s.loadThemes);
  const entryPath = entry?.path ?? null;
  const localIds = useMemo(() => new Set(themes.map((theme) => theme.id)), [themes]);

  const [listing, setListing] = useState<BackupThemeListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoredIds, setRestoredIds] = useState<Set<string>>(new Set());
  const [reloadToken, setReloadToken] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!entryPath) return;
    const seq = ++requestRef.current;
    setListing(null);
    setError(null);
    setLoading(true);
    setRestoredIds(new Set());

    void listBackupThemes(entryPath)
      .then((next) => {
        if (seq === requestRef.current) setListing(next);
      })
      .catch((err) => {
        if (seq === requestRef.current) {
          console.warn("[BackupContentDialog]", readableError(err));
          setError(readableError(err));
        }
      })
      .finally(() => {
        if (seq === requestRef.current) setLoading(false);
      });

    return () => {
      requestRef.current += 1;
    };
  }, [entryPath, reloadToken]);

  const close = () => {
    requestRef.current += 1;
    onClose();
  };

  const restore = async (theme: BackupThemeEntry) => {
    if (!entry || restoringId) return;
    setRestoringId(theme.id);
    try {
      const outcome = await restoreThemeFromBackup(entry.path, theme.id);
      setRestoredIds((prev) => new Set(prev).add(theme.id));
      // 与导入 / 回收站恢复一致：落盘后重读列表，不靠本地猜测拼状态
      await loadThemes();
      if (useThemeStore.getState().themes.some((item) => item.id === theme.id)) {
        useThemeStore.getState().revealTheme(theme.id);
      }
      toast.success(
        `已恢复「${theme.name}」`,
        `共 ${outcome.theme.cursors.length} 个槽位；可在「我的主题」里查看`,
      );
      if (outcome.warnings.length > 0) {
        toast.warning("已恢复，但有提示", outcome.warnings[0]);
      }
    } catch (err) {
      console.error("从备份恢复主题失败：", err);
      toast.error("恢复失败", readableError(err));
    } finally {
      setRestoringId(null);
    }
  };

  const busy = restoringId !== null;
  const themeCount = listing?.themes.length ?? 0;

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(next) => {
        // 恢复期间不接受关闭：用户不该在结果落下前以为操作被取消了
        if (!next && !busy) close();
      }}
    >
      {entry && (
        <DialogContent
          data-backup-content
          className="flex max-h-[72vh] w-[38rem] max-w-[calc(100vw-2rem)] flex-col"
        >
          <div className="min-w-0">
            <DialogTitle>备份内容</DialogTitle>
            <DialogDescription>
              只恢复选中的一套主题；不会合并其余内容，也不会覆盖主题库里已有的同 ID 主题。缺文件的主题仍可恢复，缺口会在「我的主题」里标出。
            </DialogDescription>
            <p
              data-backup-content-file
              className="mt-2 break-all font-mono text-2xs text-muted-foreground"
            >
              {entry.file_name}
            </p>
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <p
              data-backup-content-count
              className="text-xs text-muted-foreground tabular-nums"
            >
              {listing ? `${themeCount} 套主题` : loading ? "正在读取…" : "—"}
            </p>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setReloadToken((value) => value + 1)}
              disabled={loading || busy}
            >
              <RefreshCw data-icon="inline-start" />
              {loading ? "读取中…" : "刷新"}
            </Button>
          </div>

          {error && (
            <SettingsStatusBanner
              tone="destructive"
              title="备份内容读取失败"
              retryLabel="重试"
              onRetry={() => setReloadToken((value) => value + 1)}
              className="mt-3 mb-0"
            >
              {error}
            </SettingsStatusBanner>
          )}

          <div className="scroll-thin -mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1">
            {loading && !listing ? (
              <div className="space-y-2">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-14 w-full rounded-lg" />
                ))}
              </div>
            ) : listing && listing.themes.length === 0 ? (
              <div
                data-backup-content-empty
                className="rounded-lg bg-muted/40 px-4 py-8 text-center"
              >
                <p className="text-sm font-medium">备份里没有可恢复的主题</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  主题的 theme.json 可能缺失、损坏，或 ID 与目录名不一致。仍可在备份历史里整包恢复试试。
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {listing?.themes.map((theme) => {
                  const local = localIds.has(theme.id) || restoredIds.has(theme.id);
                  const empty = theme.slots === 0;
                  // 声明的槽位全都没有文件 = 恢复出来也是一套空主题，直接禁用；
                  // 部分缺文件仍允许恢复，缺口交给主题库的完整性体检展示（决策 31）
                  const allMissing = !empty && theme.missing_files >= theme.slots;
                  const partial = theme.missing_files > 0 && !allMissing;
                  const restoring = restoringId === theme.id;
                  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(theme.created_at)
                    ? theme.created_at
                    : null;
                  return (
                    <li
                      key={theme.id}
                      data-backup-theme-row={theme.id}
                      data-backup-theme-state={
                        local
                          ? "local"
                          : empty
                            ? "empty"
                            : allMissing
                              ? "missing-all"
                              : partial
                                ? "partial"
                                : "restorable"
                      }
                      data-backup-theme-missing={theme.missing_files}
                      className="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-[background-color] duration-(--motion-fast) ease-standard hover:bg-muted/50"
                    >
                      <span
                        aria-hidden
                        className="preview-surface grid size-8 shrink-0 place-items-center rounded-md ring-1 ring-border/60"
                      >
                        <MousePointer2 className="size-4 text-muted-foreground/60" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{theme.name}</span>
                        <span className="mt-0.5 block truncate text-2xs text-muted-foreground tabular-nums">
                          {theme.slots} 个槽位 · {theme.files} 个文件 · {formatBytes(theme.bytes)}
                          {theme.missing_files > 0 && (
                            <span className="text-warning">
                              {" "}· 缺 {theme.missing_files} 个文件
                            </span>
                          )}
                          {stamp && (
                            <>
                              {" · "}
                              <time dateTime={appliedAtMachine(stamp)}>{stamp}</time>
                            </>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0">
                        {local ? (
                          <StatusBadge tone="neutral">已在主题库</StatusBadge>
                        ) : empty ? (
                          <StatusBadge tone="warning">没有槽位</StatusBadge>
                        ) : allMissing ? (
                          <StatusBadge tone="warning">没有可用文件</StatusBadge>
                        ) : (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => void restore(theme)}
                            disabled={busy}
                            aria-busy={restoring}
                            aria-label={`从备份恢复「${theme.name}」${
                              partial ? `（缺 ${theme.missing_files} 个文件）` : ""
                            }`}
                            title={
                              partial
                                ? `恢复后会在主题库里标出缺 ${theme.missing_files} 个文件`
                                : undefined
                            }
                          >
                            {restoring ? (
                              "恢复中…"
                            ) : (
                              <>
                                <RotateCcw data-icon="inline-start" />
                                恢复
                              </>
                            )}
                          </Button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {listing && listing.warnings.length > 0 && (
            <div className="mt-2 rounded-lg bg-warning/10 px-2.5 py-2 ring-1 ring-warning/25">
              <p className="text-2xs font-medium text-warning">
                有 {listing.warnings.length} 条主题被跳过
              </p>
              <ul className="mt-0.5 space-y-0.5">
                {listing.warnings.slice(0, 3).map((warning) => (
                  <li key={warning} className="break-all text-2xs text-muted-foreground">
                    {warning}
                  </li>
                ))}
                {listing.warnings.length > 3 && (
                  <li className="text-2xs text-muted-foreground">
                    还有 {listing.warnings.length - 3} 条
                  </li>
                )}
              </ul>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-2xs text-muted-foreground">只读取主题信息，不解压光标文件</p>
            <Button size="sm" variant="ghost" onClick={close} disabled={busy}>
              关闭
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
