import { useEffect, useState } from "react";
import { Archive, FolderOpen, History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { SettingsStatusBanner } from "@/components/settings/SettingsStatusBanner";
import { BackupProgress } from "@/components/settings/BackupProgress";
import { BackupHistorySection } from "@/components/settings/BackupHistorySection";
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

  const [view, setView] = useState<"main" | "backups">("main");

  useEffect(() => {
    loadDataDir();
  }, [loadDataDir]);

  if (view === "backups") {
    return <BackupHistorySection onBack={() => setView("main")} />;
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
          description="存放导入的主题（themes\）、应用内备份（backups\）与最近使用记录（history.json）；卸载应用不会删除这里。"
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

        <DiagnosticsCard />
      </SettingsGroup>
    </div>
  );
}
