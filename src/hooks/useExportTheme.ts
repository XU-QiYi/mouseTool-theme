import { useCallback, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import { useThemeStore } from "@/stores/themeStore";
import type { CursorTheme } from "@/types/theme";

/** 导出 zip：检查器与「我的主题」表格共用 */
export function useExportTheme() {
  const exportTheme = useThemeStore((s) => s.exportTheme);
  const [exporting, setExporting] = useState(false);

  const pickAndExport = useCallback(
    async (theme: CursorTheme) => {
      if (!inTauri) {
        toast.info("开发模式无法导出", "保存文件需要桌面环境，请用 npm run tauri dev 启动");
        return;
      }
      setExporting(true);
      try {
        const dest = await save({
          defaultPath: `${theme.name}.zip`,
          filters: [{ name: "主题包", extensions: ["zip"] }],
        });
        if (dest) await exportTheme(theme.id, dest);
      } catch (err) {
        console.error("打开保存对话框失败：", err);
        toast.error("无法选择保存位置", "请重试，或检查目标文件夹权限");
      } finally {
        setExporting(false);
      }
    },
    [exportTheme],
  );

  return { exporting, pickAndExport };
}
