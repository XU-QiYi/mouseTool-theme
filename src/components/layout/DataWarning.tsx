import { TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 数据源降级提示
 *
 * 后端允许「部分来源失败」：注册表读不到时用户主题仍然要能列出来。
 * 这种情况以前只用 Toast 说一句，3 秒后就消失，用户回头看不到
 * 「为什么少了几个方案」。改成常驻条，直到用户主动关掉或重试成功。
 */
export function DataWarning() {
  const warnings = useThemeStore((s) => s.warnings);
  const dismissed = useThemeStore((s) => s.warningsDismissed);
  const dismiss = useThemeStore((s) => s.dismissWarnings);
  const reload = useThemeStore((s) => s.loadThemes);
  const loading = useThemeStore((s) => s.loading);

  if (warnings.length === 0 || dismissed) return null;

  return (
    <div role="status" className="shrink-0 border-b bg-warning/10 px-6 py-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">
            有 {warnings.length} 项数据没能读取，下面只显示其余部分
          </p>
          <ul className="mt-1 space-y-0.5">
            {warnings.map((warn) => (
              <li key={warn} className="text-2xs text-muted-foreground">
                {warn}
              </li>
            ))}
          </ul>
        </div>
        <Button variant="ghost" size="xs" onClick={reload} disabled={loading}>
          {loading ? "重试中…" : "重试"}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="关闭提示"
          title="关闭提示"
          onClick={dismiss}
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
