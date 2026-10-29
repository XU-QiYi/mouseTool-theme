import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import { actionBusyKey, useThemeStore } from "@/stores/themeStore";

/**
 * 批量导出「我的主题」（决策 34）：先选目标文件夹，再走 store 的 exportAllThemes
 *
 * 与单个导出（useExportTheme）共用 store 的忙碌键空间：批量导出进行中时，
 * 行内的单个导出按钮也要让位，避免第二个重操作被后端互斥锁立即拒绝。
 */
export function useExportAllThemes() {
  const exportAllThemes = useThemeStore((s) => s.exportAllThemes);
  const busy = useThemeStore((s) => s.busy);
  const [picking, setPicking] = useState(false);

  const pickAndExportAll = useCallback(async () => {
    if (picking || busy[actionBusyKey("export", "all")]) return;
    if (!inTauri) {
      // 浏览器（开发 / 验收）里没有系统文件夹选择，直接走 mock 数据流
      await exportAllThemes("");
      return;
    }
    setPicking(true);
    try {
      const dest = await open({ directory: true, multiple: false, title: "选择导出位置" });
      if (typeof dest === "string") await exportAllThemes(dest);
    } catch (err) {
      console.error("选择导出目录失败：", err);
      toast.error("无法选择导出位置", "请重试，或检查目标文件夹权限");
    } finally {
      setPicking(false);
    }
  }, [picking, busy, exportAllThemes]);

  return {
    picking,
    exportingAll: Boolean(busy[actionBusyKey("export", "all")]),
    pickAndExportAll,
  };
}
