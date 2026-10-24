import { openUrl } from "@tauri-apps/plugin-opener";

import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";

/**
 * 外链白名单：只放行本项目的 GitHub 页面
 *
 * 更新检查的 `html_url` 来自远端 JSON，不能拿到什么就丢给系统浏览器——
 * 那等于让远端内容决定本机打开哪个地址。
 */
const ALLOWED_HOSTS = new Set(["github.com"]);

function isAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 在系统浏览器打开外部链接
 *
 * 浏览器开发模式没有 opener 插件，退回 `window.open`；两条路都要留着，
 * 设计验收跑的就是浏览器模式。
 */
export async function openExternal(url: string): Promise<void> {
  if (!isAllowed(url)) {
    console.warn("[openExternal] 拒绝非白名单链接：", url);
    toast.error("已阻止打开外部链接", "只允许打开本项目的 GitHub 页面");
    return;
  }
  if (!inTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await openUrl(url);
}
