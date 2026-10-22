import { openUrl } from "@tauri-apps/plugin-opener";

import { inTauri } from "@/services/theme";

/**
 * 在系统浏览器打开外部链接
 *
 * 浏览器开发模式没有 opener 插件，退回 `window.open`；两条路都要留着，
 * 设计验收跑的就是浏览器模式。
 */
export async function openExternal(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await openUrl(url);
}
