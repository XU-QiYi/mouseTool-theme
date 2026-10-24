import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Copy, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { useDiagnostics } from "@/hooks/useDiagnostics";
import { toast, readableError } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import { exportBackup, importBackup } from "@/services/settings";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 数据：数据目录、备份与诊断（决策 11/12 的维护锚点）
 *
 * 这一页不依赖主题列表——加载失败时它反而更要可用。
 */
export function DataSection() {
  const dataDir = useThemeStore((s) => s.dataDir);
  const loadDataDir = useThemeStore((s) => s.loadDataDir);
  const openDataDir = useThemeStore((s) => s.openDataDir);
  const loadThemes = useThemeStore((s) => s.loadThemes);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [backupNote, setBackupNote] = useState("备份内容：全部主题（themes\）与最近使用记录（history.json）");

  const diagnostics = useDiagnostics();

  useEffect(() => {
    loadDataDir();
  }, [loadDataDir]);

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics);
      toast.success("已复制诊断信息", "报障时直接粘贴即可");
    } catch {
      // WebView 的剪贴板可能被策略挡住：文本始终可见，手动选中也能用
      toast.error("复制失败", "请手动选中下方文本复制");
    }
  };

  // 导出备份：选落点 → 打包。合并语义不需要二次确认（不动现有数据）
  const onExportBackup = async () => {
    if (!inTauri) {
      toast.info("开发模式无法备份", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
      return;
    }
    setBusy("export");
    try {
      const dest = await save({
        defaultPath: "cursorstudio-backup.zip",
        filters: [{ name: "备份包", extensions: ["zip"] }],
      });
      if (typeof dest !== "string") return;
      const summary = await exportBackup(dest);
      const warnNote = summary.warnings.length ? `；${summary.warnings.length} 条提示` : "";
      setBackupNote(`已导出到 ${dest}${warnNote}`);
      if (summary.warnings.length > 0) {
        toast.warning("备份已导出，但有提示", summary.warnings[0]);
      } else {
        toast.success("备份已导出", `${summary.themes} 套主题、${summary.files} 个文件`);
      }
    } catch (err) {
      console.error("导出备份失败：", err);
      toast.error("导出失败", readableError(err));
    } finally {
      setBusy(null);
    }
  };

  // 恢复备份：合并式补回，恢复完重读列表让新主题立刻出现
  const onImportBackup = async () => {
    if (!inTauri) {
      toast.info("开发模式无法恢复", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
      return;
    }
    setBusy("import");
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "备份包", extensions: ["zip"] }],
      });
      if (typeof selected !== "string") return;
      const summary = await importBackup(selected);
      const skipped = summary.themes_skipped
        ? `，${summary.themes_skipped} 套本地已有而跳过`
        : "";
      const warnNote = summary.warnings.length ? `；${summary.warnings.length} 条提示` : "";
      setBackupNote(
        `已补回 ${summary.themes_added} 套主题、${summary.history_added} 条使用记录${skipped}${warnNote}`,
      );
      if (summary.warnings.length > 0) {
        toast.warning("已从备份恢复，但有提示", summary.warnings[0]);
      } else {
        toast.success(
          "已从备份恢复",
          `补回 ${summary.themes_added} 套主题、${summary.history_added} 条记录${skipped}`,
        );
      }
      await loadThemes();
    } catch (err) {
      console.error("恢复备份失败：", err);
      toast.error("恢复失败", readableError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <SettingsGroup>
        <SettingCard
          title="数据目录"
          description="存放导入的主题（themes\）与最近使用记录（history.json）；卸载应用不会删除这里。"
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
          description="整包导出主题与使用记录；恢复是合并式——本地已有的保留，只补回缺失的"
          action={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onExportBackup()}
                disabled={busy !== null}
              >
                {busy === "export" ? "导出中…" : "导出备份"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onImportBackup()}
                disabled={busy !== null}
              >
                {busy === "import" ? "恢复中…" : "从备份恢复"}
              </Button>
            </div>
          }
        >
          <p data-backup-status className="mt-3 break-all text-2xs text-muted-foreground">
            {backupNote}
          </p>
        </SettingCard>

        <SettingCard
          title="诊断信息"
          description="报障时复制这段文本，省得来回描述环境"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={copyDiagnostics}
              disabled={!diagnostics}
            >
              <Copy data-icon="inline-start" />
              复制
            </Button>
          }
        >
          <pre
            data-diagnostics
            className="mt-3 font-mono text-2xs break-all whitespace-pre-wrap text-muted-foreground select-text"
          >
            {diagnostics || "…"}
          </pre>
        </SettingCard>
      </SettingsGroup>
    </div>
  );
}
