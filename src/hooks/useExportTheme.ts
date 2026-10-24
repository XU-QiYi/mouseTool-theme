import { useCallback, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import { toast } from "@/lib/toast";
import { sanitizeFileName } from "@/lib/utils";
import { inTauri } from "@/services/theme";
import { actionBusyKey, useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

/**
 * 导出 zip：检查器与「我的主题」表格共用
 *
 * 锁按主题 ID 区分：锁住的是"这一套正在导出"，其它主题照常可点。
 * 检查器与表格会同时可见，所以锁必须放在 store 里而不是组件状态。
 */
export function useExportTheme() {
  const exportTheme = useThemeStore((s) => s.exportTheme);
  const busy = useThemeStore((s) => s.busy);
  const [pickingId, setPickingId] = useState<string | null>(null);

  const isExporting = useCallback(
    (id: string) => pickingId === id || Boolean(busy[actionBusyKey("export", id)]),
    [busy, pickingId],
  );

  const pickAndExport = useCallback(
    async (theme: CursorTheme) => {
      if (!inTauri) {
        toast.info("开发模式无法导出", "保存文件需要桌面环境，请用 npm run tauri dev 启动");
        return;
      }
      if (pickingId || busy[actionBusyKey("export", theme.id)]) return;
      setPickingId(theme.id);
      try {
        const dest = await save({
          // 主题名可以包含 Windows 文件名不允许的字符，不能直接拼进默认名
          defaultPath: `${sanitizeFileName(theme.name)}.zip`,
          filters: [{ name: "主题包", extensions: ["zip"] }],
        });
        if (dest) await exportTheme(theme.id, dest);
      } catch (err) {
        console.error("打开保存对话框失败：", err);
        toast.error("无法选择保存位置", "请重试，或检查目标文件夹权限");
      } finally {
        setPickingId(null);
      }
    },
    [exportTheme, pickingId, busy],
  );

  return { isExporting, pickAndExport };
}
