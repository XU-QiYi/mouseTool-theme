import { useCallback, useEffect, useState } from "react";
import { Archive, Eraser, FolderOpen, HardDrive, History, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { SettingsStatusBanner } from "@/components/settings/SettingsStatusBanner";
import { BackupProgress } from "@/components/settings/BackupProgress";
import { BackupHistorySection } from "@/components/settings/BackupHistorySection";
import { TrashSection } from "@/components/settings/TrashSection";
import { DiagnosticsCard } from "@/components/settings/DiagnosticsDialog";
import { readableError } from "@/lib/toast";
import { formatBytes } from "@/lib/utils";
import { getStorageStats, type StorageStats } from "@/services/settings";
import { actionBusyKey, useThemeStore } from "@/stores/themeStore";
import { useSettingsStore } from "@/stores/settingsStore";

/** 存储占用的一行：标签 + 条目说明 + 字节数 */
function StatRow({ rowKey, label, detail, bytes }: { rowKey: string; label: string; detail: string; bytes: number }) {
  return (
    <div
      data-storage-row={rowKey}
      className="flex items-center justify-between gap-3"
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 tabular-nums">
        <span className="text-2xs text-muted-foreground">{detail}</span>
        <span className="font-medium text-foreground">{formatBytes(bytes)}</span>
      </span>
    </div>
  );
}

/**
 * 存储占用：数据目录各区域的一次只读统计（决策 34）
 *
 * 挂载时统计一次，之后手动「重新统计」——数字是快照不是实时监控，
 * 自动刷新会让人误以为它是精确到秒的账本。
 */
function StorageStatsCard() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStats(await getStorageStats());
      setError(null);
    } catch (err) {
      console.error("统计存储占用失败：", err);
      setError(readableError(err));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busy 只做防重入，不进依赖
  }, [busy]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时拉取
  }, []);

  return (
    <SettingCard
      title="存储占用"
      description="数据目录各区域的磁盘占用概数，只读统计、不清任何内容；主题库设在数据目录外时同样计入"
      action={
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy}>
          <HardDrive data-icon="inline-start" />
          {busy ? "统计中…" : "重新统计"}
        </Button>
      }
    >
      {error && (
        <p data-storage-error className="mt-3 text-2xs text-warning">
          统计失败：{error}
        </p>
      )}
      <div data-storage-stats className="mt-3 grid gap-1.5 text-xs">
        <StatRow
          rowKey="themes"
          label="主题库"
          detail={`${stats?.themes.count ?? 0} 套主题`}
          bytes={stats?.themes.bytes ?? 0}
        />
        <StatRow
          rowKey="backups"
          label="应用内备份"
          detail={`${stats?.backups.count ?? 0} 份备份`}
          bytes={stats?.backups.bytes ?? 0}
        />
        <StatRow
          rowKey="trash"
          label="回收站"
          detail={`${stats?.trash.count ?? 0} 个条目`}
          bytes={stats?.trash.bytes ?? 0}
        />
        <StatRow rowKey="history" label="使用记录" detail="history.json" bytes={stats?.history_bytes ?? 0} />
        <StatRow rowKey="settings" label="行为设置" detail="settings.json" bytes={stats?.settings_bytes ?? 0} />
        <div
          data-storage-row="total"
          className="flex items-center justify-between gap-3 border-t border-border/60 pt-1.5"
        >
          <span className="font-medium">总占用</span>
          <span className="tabular-nums font-medium">{formatBytes(stats?.total_bytes ?? 0)}</span>
        </div>
      </div>
    </SettingCard>
  );
}

/**
 * 数据：数据目录、备份与诊断（决策 11/12 的维护锚点）
 *
 * 这一页不依赖主题列表——加载失败时它反而更要可用。
 * 备份分两个视图：主视图是「立即备份 + 入口」，点「备份历史」切到子页
 * （只管理应用内 `backups\` 目录，见 BackupHistorySection）。
 */
export function DataSection() {
  const dataDir = useThemeStore((s) => s.dataDir);
  const dataDirError = useThemeStore((s) => s.dataDirError);
  const loadDataDir = useThemeStore((s) => s.loadDataDir);
  const openDataDir = useThemeStore((s) => s.openDataDir);
  const clearHistory = useThemeStore((s) => s.clearHistory);
  const historyBusy = useThemeStore((s) => Boolean(s.busy[actionBusyKey("clear", "history")]));
  const backupBusy = useSettingsStore((s) => s.backupBusy);
  const backupProgress = useSettingsStore((s) => s.backupProgress);
  const backupNote = useSettingsStore((s) => s.backupNote);
  const exportBackupTo = useSettingsStore((s) => s.exportBackupTo);
  const settings = useSettingsStore((s) => s.settings);
  const patchSettings = useSettingsStore((s) => s.patchSettings);

  const [view, setView] = useState<"main" | "backups" | "trash">("main");
  const [historyConfirmOpen, setHistoryConfirmOpen] = useState(false);

  useEffect(() => {
    loadDataDir();
  }, [loadDataDir]);

  if (view === "backups") {
    return <BackupHistorySection onBack={() => setView("main")} />;
  }

  if (view === "trash") {
    return <TrashSection onBack={() => setView("main")} />;
  }

  return (
    <div>
      {dataDirError && !dataDir && (
        <SettingsStatusBanner
          tone="warning"
          title="数据目录读取失败"
          retryLabel="重试"
          onRetry={() => void loadDataDir()}
        >
          {dataDirError}
        </SettingsStatusBanner>
      )}
      <SettingsGroup>
        <SettingCard
          title="数据目录"
          description="存放导入的主题（themes\）、删除后暂存的回收站（trash\）、应用内备份（backups\）与最近使用记录（history.json）；卸载应用不会删除这里。"
          action={
            <Button size="sm" onClick={openDataDir}>
              <FolderOpen data-icon="inline-start" />
              打开数据目录
            </Button>
          }
        >
          {/* 路径可选中复制：报障时用户要能把路径贴给别人 */}
          <p
            data-data-dir
            className="mt-3 break-all font-mono text-2xs text-muted-foreground select-text"
          >
            {dataDir ?? "…"}
          </p>
        </SettingCard>

        <SettingCard
          title="数据备份"
          description="「立即备份」保存到数据目录的 backups\，可在「备份历史」里恢复或清理；整包恢复是合并式（本地已有的保留，只补回缺失），也可以只查看内容并恢复其中一套主题"
          action={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void exportBackupTo(null)}
                disabled={backupBusy !== null}
              >
                <Archive data-icon="inline-start" />
                {backupBusy === "export" ? "备份中…" : "立即备份"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setView("backups")}
                disabled={backupBusy !== null}
              >
                <History data-icon="inline-start" />
                备份历史
              </Button>
            </div>
          }
        >
          {backupBusy && backupProgress && <BackupProgress progress={backupProgress} />}
          <p data-backup-status className="mt-3 break-all text-2xs text-muted-foreground">
            {backupNote}
          </p>
        </SettingCard>

        <SettingCard
          title="自动备份"
          description="每天第一份备份落进「备份历史」，超过保留份数时自动清理最旧的自动备份；手动备份不受影响"
          action={
            <Toggle
              label="自动备份"
              checked={settings?.auto_backup_enabled ?? false}
              onCheckedChange={(checked) => void patchSettings({ auto_backup_enabled: checked })}
              disabled={!settings}
            />
          }
        >
          <div className="mt-3 grid gap-2">
            <label className="flex items-center justify-between gap-2">
              <span className="text-2xs text-muted-foreground">保留份数</span>
              <select
                aria-label="自动备份保留份数"
                data-auto-backup-keep
                className="h-8 max-w-56 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={settings?.auto_backup_keep ?? 10}
                disabled={!settings?.auto_backup_enabled}
                onChange={(event) =>
                  void patchSettings({ auto_backup_keep: Number(event.target.value) })
                }
              >
                <option value={5}>5 份</option>
                <option value={10}>10 份</option>
                <option value={20}>20 份</option>
              </select>
            </label>
          </div>
        </SettingCard>

        <SettingCard
          title="回收站"
          description="删除的主题会先移入数据目录的 trash\，可随时恢复或彻底删除；超过上限时自动清理最早的条目，并在删除结果里说明"
          action={
            <Button size="sm" variant="outline" onClick={() => setView("trash")}>
              <Trash2 data-icon="inline-start" />
              打开回收站
            </Button>
          }
        />

        <StorageStatsCard />

        <SettingCard
          title="使用记录"
          description="「最近使用」页与托盘最近使用的数据来源；记录只进不出，清空后时间轴变空，主题与设置不受影响"
          action={
            <Button
              size="sm"
              variant="outline"
              data-clear-history
              onClick={() => setHistoryConfirmOpen(true)}
              disabled={historyBusy}
            >
              <Eraser data-icon="inline-start" />
              {historyBusy ? "清空中…" : "清空使用记录"}
            </Button>
          }
        />

        <DiagnosticsCard />
      </SettingsGroup>

      {/* 清空使用记录确认：不可撤销，说清影响范围（不含主题与设置） */}
      <AlertDialog open={historyConfirmOpen} onOpenChange={setHistoryConfirmOpen}>
        <AlertDialogContent className="w-[30rem]">
          <AlertDialogTitle>清空使用记录？</AlertDialogTitle>
          <AlertDialogDescription>
            会清掉全部「最近使用」记录（history.json），「最近使用」页与托盘的最近使用都会变空；
            主题、备份与设置不受影响。此操作不可撤销。
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setHistoryConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              data-confirm-clear-history
              onClick={() => {
                setHistoryConfirmOpen(false);
                void clearHistory();
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
