import { open } from "@tauri-apps/plugin-dialog";

import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import { useImportStore } from "@/stores/importStore";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 选 zip 并导入 —— 不带任何按钮状态的独立入口
 *
 * 侧栏 / 空状态按钮（经 `useImportTheme`）与 Ctrl+O 快捷键共用这里，
 * 文件对话框的 filters、浏览器降级提示只写一遍。
 */
export async function pickAndImportZip(): Promise<boolean> {
  if (!inTauri) {
    // 浏览器里没有文件系统，静默 return 会让人以为坏了，必须明说
    toast.info("开发模式无法导入", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
    return false;
  }
  // 批量队列在跑时不再拉起单文件对话框：两条链路共用后端互斥锁，
  // 排进去也只会失败，先说清原因
  if (useImportStore.getState().running) {
    toast.warning("正在批量导入，请稍候", "等队列跑完再导入单个主题");
    return false;
  }
  try {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "主题包", extensions: ["zip"] }],
    });
    if (typeof selected === "string") {
      await useThemeStore.getState().importTheme(selected);
      return true;
    }
    return false;
  } catch (err) {
    console.error("选择文件失败：", err);
    toast.error("没能打开文件选择框", "请重试；若反复失败，检查 Windows 的默认应用权限");
    return false;
  }
}

/**
 * 批量导入入口：多选 zip → 入队并打开导入中心（不自动开始）
 *
 * 与单文件入口是两条链路：这里只负责把路径交给 `importStore`，
 * 执行由用户在导入中心点「开始导入」触发（串行，见 importStore.start）。
 */
export async function pickAndQueueThemes(): Promise<void> {
  if (!inTauri) {
    toast.info("开发模式无法批量导入", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
    return;
  }
  if (useImportStore.getState().running) {
    toast.warning("正在批量导入，请稍候", "等队列跑完再添加");
    return;
  }
  try {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "主题包", extensions: ["zip"] }],
    });
    if (Array.isArray(selected) && selected.length > 0) {
      useImportStore.getState().enqueue(selected);
    }
  } catch (err) {
    console.error("选择文件失败：", err);
    toast.error("没能打开文件选择框", "请重试；若反复失败，检查 Windows 的默认应用权限");
  }
}
