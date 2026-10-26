import { useCallback, useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Archive, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

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
import { BackupProgress } from "@/components/settings/BackupProgress";
import { SettingsStatusBanner } from "@/components/settings/SettingsStatusBanner";
import { readableError, toast } from "@/lib/toast";
import { formatBytes } from "@/lib/utils";
import { appliedAtMachine } from "@/lib/themes";
import { inTauri } from "@/services/theme";
import { deleteBackup, listBackups, type BackupEntry } from "@/services/settings";
import { useSettingsStore } from "@/stores/settingsStore";

interface BackupHistorySectionProps {
  onBack: () => void;
}

/**
 * 备份历史：「设置 → 数据」的子页，只管理应用内备份（`backups\` 目录）
 *
 * 顶部 h2（页头 h1 仍是「数据」，不新开一级）；滚动沿用 SettingsView 的
 * 容器，这里不再嵌套纵向滚动。恢复走现有 `restoreBackupFrom`（合并语义），
 * 删除只按文件名走 `delete_backup`，后端拒绝越出 `backups\` 的输入。
 */
export function BackupHistorySection({ onBack }: BackupHistorySectionProps) {
  const backupBusy = useSettingsStore((s) => s.backupBusy);
  const backupProgress = useSettingsStore((s) => s.backupProgress);
  const exportBackupTo = useSettingsStore((s) => s.exportBackupTo);
  const restoreBackupFrom = useSettingsStore((s) => s.restoreBackupFrom);

  const [entries, setEntries] = useState<BackupEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** 行级 / 刷新的忙碌键：`delete:<file>` 与 `list`；导入导出沿用 store 的 backupBusy */
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [pendingRestore, setPendingRestore] = useState<BackupEntry | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BackupEntry | null>(null);

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
      setEntries(await listBackups());
    } catch (err) {
      console.error("读取备份历史失败：", err);
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

  const backupNow = () => {
    void exportBackupTo(null).then(() => void refresh());
  };

  // 保留「导出到任意位置」的原有能力：自选落点的备份不进历史
  const exportTo = async () => {
    if (!inTauri) {
      toast.info("开发模式无法备份", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
      return;
    }
    try {
      const dest = await save({
        defaultPath: "cursorstudio-backup.zip",
        filters: [{ name: "备份包", extensions: ["zip"] }],
      });
      if (typeof dest === "string") await exportBackupTo(dest);
    } catch (err) {
      console.error("选择备份位置失败：", err);
      toast.error("无法选择备份位置", readableError(err));
    }
  };

  // 从文件恢复：选任意备份 zip（不限于应用内目录），确认后走合并恢复
  const pickRestoreFile = async () => {
    if (!inTauri) {
      toast.info("开发模式无法恢复", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
      return;
    }
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "备份包", extensions: ["zip"] }],
      });
      if (typeof selected === "string") {
        setPendingRestore({
          file_name: selected.replace(/^.*[\\/]/, ""),
          path: selected,
          created_at: "",
          kind: "file",
          themes: 0,
          files: 0,
          bytes: 0,
          status: "ok",
          error: null,
        });
      }
    } catch (err) {
      console.error("选择备份文件失败：", err);
      toast.error("无法选择备份文件", readableError(err));
    }
  };

  const confirmDelete = async (entry: BackupEntry) => {
    const key = `delete:${entry.file_name}`;
    if (busy[key]) return;
    setBusyFlag(key, true);
    try {
      await deleteBackup(entry.file_name);
      toast.success("备份已删除", entry.file_name);
      await refresh();
    } catch (err) {
      console.error("删除备份失败：", err);
      toast.error("删除失败", readableError(err));
    } finally {
      setBusyFlag(key, false);
    }
  };

  const totalBytes = (entries ?? []).reduce((sum, entry) => sum + entry.bytes, 0);
  const newest = entries?.find((entry) => entry.created_at !== "未知") ?? null;

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
          <h2 className="truncate text-sm font-medium">备份历史</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={busy.list}
            title="重新读取备份列表"
          >
            <RefreshCw data-icon="inline-start" />
            {busy.list ? "读取中…" : "刷新"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void pickRestoreFile()} disabled={backupBusy !== null}>
            从文件恢复
          </Button>
          <Button size="sm" variant="outline" onClick={() => void exportTo()} disabled={backupBusy !== null}>
            导出到…
          </Button>
          <Button size="sm" onClick={backupNow} disabled={backupBusy !== null}>
            <Archive data-icon="inline-start" />
            {backupBusy === "export" ? "备份中…" : "立即备份"}
          </Button>
        </div>
      </div>

      {backupBusy && backupProgress && <BackupProgress progress={backupProgress} />}

      {listError && (
        <SettingsStatusBanner
          tone="warning"
          title="备份历史读取失败"
          retryLabel="重试"
          onRetry={() => void refresh()}
        >
          {listError}
        </SettingsStatusBanner>
      )}

      {/* 摘要三块：最近备份 / 数量 / 总占用 */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <SummaryBlock label="最近备份" value={newest ? newest.created_at : "还没有备份"} />
        <SummaryBlock label="备份数量" value={`${entries?.length ?? 0} 份`} />
        <SummaryBlock label="总占用" value={formatBytes(totalBytes)} />
      </div>

      {entries === null ? (
        busy.list || !listError ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
            <p className="text-2xs text-muted-foreground">正在读取备份列表…</p>
          </div>
        ) : null
      ) : entries.length === 0 ? (
        <div
          data-backup-empty
          className="rounded-xl bg-card p-6 text-center ring-1 ring-foreground/10"
        >
          <p className="text-sm font-medium">还没有应用内备份</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            点「立即备份」会把全部主题与使用记录打包到数据目录的 backups\ 里；
            也可以从别的位置导入备份文件恢复。
          </p>
          <Button size="sm" className="mt-3" onClick={backupNow} disabled={backupBusy !== null}>
            <Archive data-icon="inline-start" />
            立即备份
          </Button>
        </div>
      ) : (
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">应用内备份列表：时间、内容、大小、状态与操作</caption>
          <thead>
            <tr className="border-b border-border/60">
              <th scope="col" className="w-44 px-2 py-2 text-left text-xs font-normal text-muted-foreground">
                时间
              </th>
              <th scope="col" className="px-2 py-2 text-left text-xs font-normal text-muted-foreground">
                内容
              </th>
              <th scope="col" className="w-20 px-2 py-2 text-left text-xs font-normal text-muted-foreground">
                大小
              </th>
              <th scope="col" className="w-16 px-2 py-2 text-left text-xs font-normal text-muted-foreground">
                状态
              </th>
              <th scope="col" className="w-28 px-2 py-2 text-right text-xs font-normal text-muted-foreground">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const corrupt = entry.status === "corrupt";
              const deleting = Boolean(busy[`delete:${entry.file_name}`]);
              const machine = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(entry.created_at)
                ? appliedAtMachine(entry.created_at)
                : undefined;
              return (
                <tr
                  key={entry.file_name}
                  data-backup-row={entry.file_name}
                  className="border-b border-border/60 transition-[background-color] duration-(--motion-fast) ease-standard hover:bg-muted/50"
                >
                  <td className="px-2 py-2.5 text-xs text-muted-foreground tabular-nums">
                    {machine ? (
                      <time dateTime={machine}>{entry.created_at}</time>
                    ) : (
                      entry.created_at
                    )}
                    <span className="mt-0.5 block truncate font-mono text-2xs" title={entry.file_name}>
                      {entry.file_name}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-xs text-muted-foreground tabular-nums">
                    {corrupt ? (
                      <span className="text-warning">无法读取</span>
                    ) : (
                      <>
                        {entry.themes} 套主题 · {entry.files} 个文件
                      </>
                    )}
                  </td>
                  <td className="px-2 py-2.5 text-xs text-muted-foreground tabular-nums">
                    {corrupt ? "—" : formatBytes(entry.bytes)}
                  </td>
                  <td className="px-2 py-2.5">
                    <span data-backup-status={entry.status}>
                      {corrupt ? (
                        <StatusBadge tone="warning" dot>
                          已损坏
                        </StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">可恢复</StatusBadge>
                      )}
                    </span>
                    {corrupt && entry.error && (
                      <p className="mt-1 text-2xs leading-relaxed text-muted-foreground" title={entry.error}>
                        {entry.error}
                      </p>
                    )}
                  </td>
                  <td className="px-2 py-2.5">
                    <span className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPendingRestore(entry)}
                        disabled={corrupt || backupBusy !== null}
                        title={corrupt ? "备份文件已损坏，无法恢复" : "恢复这份备份（合并，不覆盖已有）"}
                      >
                        <RotateCcw data-icon="inline-start" />
                        恢复
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`删除备份 ${entry.file_name}`}
                        title={deleting ? "删除中…" : "删除这份备份"}
                        onClick={() => setPendingDelete(entry)}
                        disabled={deleting}
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
        这里只列出应用自己生成的备份（数据目录 backups\）；「导出到…」保存到其它位置的备份不在此列。
      </p>

      {/* 恢复确认：沿用合并语义说明 */}
      <AlertDialog
        open={pendingRestore !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRestore(null);
        }}
      >
        {pendingRestore && (
          <AlertDialogContent className="w-[30rem]">
            <AlertDialogTitle>从这份备份恢复？</AlertDialogTitle>
            <AlertDialogDescription>
              会补回备份里的主题与使用记录；本地已有的同 ID 主题会整套跳过，不会被覆盖。
            </AlertDialogDescription>
            <p
              data-restore-source
              className="mt-3 break-all font-mono text-2xs text-muted-foreground select-text"
            >
              {pendingRestore.path}
            </p>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setPendingRestore(null)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  const path = pendingRestore.path;
                  setPendingRestore(null);
                  void restoreBackupFrom(path).then(() => void refresh());
                }}
              >
                开始恢复
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>

      {/* 删除确认：应用内备份不可撤销，但只删这一份 */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        {pendingDelete && (
          <AlertDialogContent className="w-[30rem]">
            <AlertDialogTitle>删除这份备份？</AlertDialogTitle>
            <AlertDialogDescription>
              只删除这份应用内备份，不影响当前主题与使用记录；此操作不可撤销。
            </AlertDialogDescription>
            <p className="mt-3 break-all font-mono text-2xs text-muted-foreground select-text">
              {pendingDelete.file_name}
            </p>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setPendingDelete(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const entry = pendingDelete;
                  setPendingDelete(null);
                  void confirmDelete(entry);
                }}
              >
                确认删除
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
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
