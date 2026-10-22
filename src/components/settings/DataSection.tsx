import { useEffect } from "react";
import { Copy, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { useDiagnostics } from "@/hooks/useDiagnostics";
import { toast } from "@/lib/toast";
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
