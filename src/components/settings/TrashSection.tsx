import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingsStatusBanner } from "@/components/settings/SettingsStatusBanner";
import { readableError, toast } from "@/lib/toast";
import { formatBytes } from "@/lib/utils";
import { appliedAtMachine } from "@/lib/themes";
import { deleteFromTrash, emptyTrash, listTrash } from "@/services/theme";
import { useThemeStore } from "@/stores/themeStore";
import type { TrashEntry, TrashListing } from "@/types/theme";

interface TrashSectionProps {
  onBack: () => void;
}

/**
 * 回收站：「设置 → 数据」的子页，与管理备份同构
 *
 * 删除主题只是把目录搬进 `trash\`；这里负责恢复与彻底删除。顶部 h2（页头 h1
 * 仍是「数据」），滚动沿用 SettingsView 的容器，不再嵌套纵向滚动。
 * 条目上限与自动清理由后端决定，界面只展示后端返回的限额。
 */
export function TrashSection({ onBack }: TrashSectionProps) {
  const restoreTrashEntry = useThemeStore((s) => s.restoreTrashEntry);

  const [listing, setListing] = useState<TrashListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** 行级 / 刷新 / 清空的忙碌键：`restore:<id>`、`purge:<id>`、`list`、`empty` */
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [pendingPurge, setPendingPurge] = useState<TrashEntry | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

  const setBusyFlag = (key: string, value: boolean) =>
    setBusy((prev) => {
      if (!value) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: true };
    });

  const refresh = useCallback(async () => {
    if (busy.list) return;
    setBusyFlag("list", true);
    setListError(null);
    try {
      setListing(await listTrash());
    } catch (err) {
      console.error("读取回收站失败：", err);
      setListError(readableError(err));
    } finally {
      setBusyFlag("list", false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setBusyFlag 是本组件稳定引用
  }, [busy.list]);

  useEffect(() => {
    // 进入子页拉一次；离开再回来（view 切换重挂载）也会重新拉
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时拉取
  }, []);

  const restore = async (entry: TrashEntry) => {
    const key = `restore:${entry.id}`;
    if (busy[key] || entry.status !== "ok") return;
    setBusyFlag(key, true);
    const restored = await restoreTrashEntry(entry);
    setBusyFlag(key, false);
    if (restored) await refresh();
  };

  const confirmPurge = async (entry: TrashEntry) => {
    const key = `purge:${entry.id}`;
    if (busy[key]) return;
    setBusyFlag(key, true);
    try {
      await deleteFromTrash(entry.id);
      toast.success(`已彻底删除「${entry.name}」`, "这套主题的光标文件已从回收站移除");
      await refresh();
    } catch (err) {
      console.error("彻底删除失败：", err);
      toast.error("彻底删除失败", readableError(err));
    } finally {
      setBusyFlag(key, false);
    }
  };

  const confirmEmpty = async () => {
    if (busy.empty) return;
    setBusyFlag("empty", true);
    try {
      const outcome = await emptyTrash();
      if (outcome.failed.length > 0) {
        toast.warning(
          `已清理 ${outcome.removed} 套，${outcome.failed.length} 套没删掉`,
          outcome.failed[0],
        );
      } else {
        toast.success("回收站已清空", `共彻底删除 ${outcome.removed} 套主题`);
      }
      await refresh();
    } catch (err) {
      console.error("清空回收站失败：", err);
      toast.error("清空失败", readableError(err));
    } finally {
      setBusyFlag("empty", false);
    }
  };

  const entries = listing?.entries ?? null;
  const totalBytes = (entries ?? []).reduce((sum, entry) => sum + entry.bytes, 0);
  const newest = entries?.[0] ?? null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="返回数据设置"
            title="返回「数据」"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <h2 className="truncate text-sm font-medium">回收站</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={Boolean(busy.list)}
            title="重新读取回收站"
          >
            <RefreshCw data-icon="inline-start" />
            {busy.list ? "读取中…" : "刷新"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setEmptyOpen(true)}
            disabled={!entries || entries.length === 0 || Boolean(busy.empty)}
          >
            <Trash2 data-icon="inline-start" />
            {busy.empty ? "清空中…" : "清空回收站"}
          </Button>
        </div>
      </div>

      {listError && (
        <SettingsStatusBanner
          tone="warning"
          title="回收站读取失败"
          retryLabel="重试"
          onRetry={() => void refresh()}
        >
          {listError}
        </SettingsStatusBanner>
      )}

      <div className="mb-4 grid grid-cols-3 gap-2">
        <SummaryBlock label="最近删除" value={newest ? newest.deleted_at : "还没有记录"} />
        <SummaryBlock
          label="保留数量"
          value={`${entries?.length ?? 0} / ${listing?.max_entries ?? 20}`}
        />
        <SummaryBlock label="总占用" value={formatBytes(totalBytes)} />
      </div>

      {entries === null ? (
        busy.list || !listError ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
            <p className="text-2xs text-muted-foreground">正在读取回收站…</p>
          </div>
        ) : null
      ) : entries.length === 0 ? (
        <div
          data-trash-empty
          className="rounded-xl bg-card p-6 text-center ring-1 ring-foreground/10"
        >
          <p className="text-sm font-medium">回收站是空的</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            删除的主题会先移到这里，确认不再需要后再彻底删除。
            可以随时恢复，恢复后会重新出现在主题图库与我的主题里。
          </p>
        </div>
      ) : (
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">回收站列表：主题、删除时间、大小与恢复/彻底删除操作</caption>
          <thead>
            <tr className="border-b border-border/60">
              <th scope="col" className="px-2 py-2 text-left text-xs font-normal text-muted-foreground">
                主题
              </th>
              <th scope="col" className="w-36 px-2 py-2 text-left text-xs font-normal text-muted-foreground">
                删除时间
              </th>
              <th scope="col" className="w-20 px-2 py-2 text-left text-xs font-normal text-muted-foreground">
                大小
              </th>
              <th scope="col" className="w-36 px-2 py-2 text-right text-xs font-normal text-muted-foreground">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const damaged = entry.status === "damaged";
              const restoring = Boolean(busy[`restore:${entry.id}`]);
              const purging = Boolean(busy[`purge:${entry.id}`]);
              const machine = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(entry.deleted_at)
                ? appliedAtMachine(entry.deleted_at)
                : undefined;
              return (
                <tr
                  key={entry.id}
                  data-trash-row={entry.id}
                  data-trash-status={entry.status}
                  className="border-b border-border/60 transition-[background-color] duration-(--motion-fast) ease-standard hover:bg-muted/50"
                >
                  <td className="px-2 py-2.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{entry.name}</span>
                        <span
                          className="mt-0.5 block truncate text-2xs text-muted-foreground"
                          title={damaged ? entry.error ?? undefined : undefined}
                        >
                          {damaged
                            ? entry.error ?? "回收站记录已损坏"
                            : `${entry.slot_count} 个光标槽位`}
                        </span>
                      </span>
                      {damaged ? (
                        <StatusBadge tone="warning" dot>
                          无法恢复
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">可恢复</StatusBadge>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-xs text-muted-foreground tabular-nums">
                    {machine ? (
                      <time dateTime={machine}>{entry.deleted_at}</time>
                    ) : (
                      entry.deleted_at
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-xs text-muted-foreground tabular-nums">
                    {formatBytes(entry.bytes)}
                  </td>
                  <td className="px-2 py-2.5">
                    <span className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void restore(entry)}
                        disabled={damaged || restoring || purging}
                        title={
                          damaged
                            ? "该条目无法恢复（主题信息或回收站记录损坏）；可以彻底删除"
                            : "恢复到主题目录（不会覆盖已有主题）"
                        }
                      >
                        <RotateCcw data-icon="inline-start" />
                        {restoring ? "恢复中…" : "恢复"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`彻底删除「${entry.name}」`}
                        title={purging ? "删除中…" : "彻底删除，无法恢复"}
                        onClick={() => setPendingPurge(entry)}
                        disabled={purging || restoring}
                        className="text-muted-foreground hover:text-destructive hover:ring-1 hover:ring-destructive/40"
                      >
                        <Trash2 />
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
        回收站只保留本应用删除的主题，不占主题列表与备份；超过 {(listing?.max_entries ?? 20)} 套或{" "}
        {formatBytes(listing?.max_bytes ?? 512 * 1024 * 1024)} 时自动清理最早的条目。
      </p>

      <AlertDialog
        open={pendingPurge !== null}
        onOpenChange={(next) => {
          if (!next) setPendingPurge(null);
        }}
      >
        {pendingPurge && (
          <AlertDialogContent data-trash-purge-dialog className="w-[30rem]">
            <AlertDialogTitle>彻底删除「{pendingPurge.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingPurge.slot_count > 0
                ? `会连同 ${pendingPurge.slot_count} 个光标文件一起从回收站删除，无法恢复。系统当前光标不受影响。`
                : "会从回收站删除这套主题的目录，无法恢复。系统当前光标不受影响。"}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setPendingPurge(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const entry = pendingPurge;
                  setPendingPurge(null);
                  void confirmPurge(entry);
                }}
              >
                彻底删除
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog
        open={emptyOpen}
        onOpenChange={(next) => {
          if (!next) setEmptyOpen(false);
        }}
      >
        <AlertDialogContent data-trash-empty-dialog className="w-[30rem]">
          <AlertDialogTitle>清空回收站？</AlertDialogTitle>
          <AlertDialogDescription>
            会彻底删除回收站里的 {entries?.length ?? 0} 套主题（共 {formatBytes(totalBytes)}），无法恢复；备份与最近使用记录不受影响。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setEmptyOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setEmptyOpen(false);
                void confirmEmpty();
              }}
            >
              确认清空
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SummaryBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium tabular-nums" title={value}>
        {value}
      </p>
    </div>
  );
}
