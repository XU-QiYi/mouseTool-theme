import { useEffect, useState } from "react";
import { Archive, FolderOpen, History, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { SettingsStatusBanner } from "@/components/settings/SettingsStatusBanner";
import { BackupProgress } from "@/components/settings/BackupProgress";
import { BackupHistorySection } from "@/components/settings/BackupHistorySection";
import { TrashSection } from "@/components/settings/TrashSection";
import { DiagnosticsCard } from "@/components/settings/DiagnosticsDialog";
import { useThemeStore } from "@/stores/themeStore";
import { useSettingsStore } from "@/stores/settingsStore";

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
  const backupBusy = useSettingsStore((s) => s.backupBusy);
  const backupProgress = useSettingsStore((s) => s.backupProgress);
  const backupNote = useSettingsStore((s) => s.backupNote);
  const exportBackupTo = useSettingsStore((s) => s.exportBackupTo);
  const settings = useSettingsStore((s) => s.settings);
  const patchSettings = useSettingsStore((s) => s.patchSettings);

  const [view, setView] = useState<"main" | "backups" | "trash">("main");

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
          description="「立即备份」保存到数据目录的 backups\，可在「备份历史」里恢复或清理；恢复是合并式——本地已有的保留，只补回缺失的"
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

        <DiagnosticsCard />
      </SettingsGroup>
    </div>
  );
}
