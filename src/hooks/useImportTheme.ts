import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 选 zip 并导入
 *
 * 侧栏、图库空状态、我的主题空状态都要能导入，逻辑抽在这里，
 * 避免三处各写一遍（文件对话框的 filters、浏览器降级提示都得一致）。
 */
export function useImportTheme() {
  const importTheme = useThemeStore((s) => s.importTheme);
  const [picking, setPicking] = useState(false);

  const pick = useCallback(async () => {
    if (!inTauri) {
      // 浏览器里没有文件系统，静默 return 会让人以为按钮坏了，必须明说
      toast.info("开发模式无法导入", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
      return;
    }
    setPicking(true);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "主题包", extensions: ["zip"] }],
      });
      if (typeof selected === "string") {
        await importTheme(selected);
      }
    } catch (err) {
      console.error("选择文件失败：", err);
      toast.error("没能打开文件选择框", "请重试；若反复失败，检查 Windows 的默认应用权限");
    } finally {
      setPicking(false);
    }
  }, [importTheme]);

  return { picking, pick };
}
