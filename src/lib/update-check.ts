import { getVersion } from "@tauri-apps/api/app";

import { APP_VERSION, RELEASES_API, REPO_URL } from "@/lib/app-meta";

/**
 * 检查更新：比对 GitHub Releases 的最新 tag 与当前版本
 *
 * 版本源就是发布通道本身（发布指南：唯一的发布渠道是 GitHub Releases），
 * 零新依赖——前端 fetch，GitHub API 允许跨域。没有发过版 / 网络不通都
 * 如实报「error + 原因」，不假装「已是最新」。
 */
export interface UpdateCheckResult {
  status: "up-to-date" | "update-available" | "error";
  currentVersion: string;
  /** `v0.2.0` 这样的 tag；error 时可能为 null */
  latestVersion: string | null;
  /** 发现新版本时的下载页；其余情况给仓库地址 */
  releaseUrl: string;
  /** 中文结果说明，界面直接展示 */
  message: string;
}

/** `v0.2.0` / `0.2.0` → 三段数字；前缀不合法返回 null */
function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

async function currentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    // 浏览器开发模式拿不到 Tauri 版本，退回常量
    return APP_VERSION;
  }
}

/** 检查更新的超时：GitHub 在弱网下可能挂很久，启动检查不能一直悬着 */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * 403 且匿名额度耗尽时的说明
 *
 * 额度按网络出口 IP 计（未登录 60 次/小时），代理节点常被多人共用，
 * 用完就整个出口 403——只说「HTTP 403」用户无从下手，给出恢复时间和出路。
 */
function rateLimitMessage(res: Response): string | null {
  if (res.status !== 403 || res.headers.get("x-ratelimit-remaining") !== "0") {
    return null;
  }
  const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
  const at = new Date(reset);
  if (!Number.isFinite(reset) || reset <= 0 || Number.isNaN(at.getTime())) {
    return "GitHub 接口的匿名访问额度已用完，稍后再试";
  }
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(
    at.getMinutes(),
  ).padStart(2, "0")}`;
  return `GitHub 接口的匿名额度（每小时 60 次）已被当前网络的出口 IP 用完，${clock} 后恢复；换代理节点或关闭代理可立即重试`;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = await currentVersion();
  const base = {
    currentVersion: current,
    latestVersion: null as string | null,
    releaseUrl: REPO_URL,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (res.status === 404) {
      return {
        ...base,
        status: "error",
        message: "仓库还没有发布过版本，暂时没有可更新的版本",
      };
    }
    if (!res.ok) {
      return {
        ...base,
        status: "error",
        message:
          rateLimitMessage(res) ?? `检查失败（HTTP ${res.status}），稍后再试`,
      };
    }

    const data: { tag_name?: string; html_url?: string } = await res.json();
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    const releaseUrl = data.html_url ?? `${REPO_URL}/releases`;
    const latestParts = parseVersion(latest);
    const currentParts = parseVersion(current);

    if (!latestParts || !currentParts) {
      return {
        ...base,
        status: "error",
        latestVersion: data.tag_name ?? null,
        releaseUrl,
        message: "版本号格式不认识，无法比较",
      };
    }

    if (compare(latestParts, currentParts) > 0) {
      return {
        ...base,
        status: "update-available",
        latestVersion: data.tag_name ?? `v${latest}`,
        releaseUrl,
        message: `发现新版本 v${latest}（当前 v${current}）`,
      };
    }

    return {
      ...base,
      status: "up-to-date",
      latestVersion: data.tag_name ?? `v${latest}`,
      releaseUrl,
      message: `已是最新版本（v${current}）`,
    };
  } catch (err) {
    return {
      ...base,
      status: "error",
      message:
        err instanceof DOMException && err.name === "AbortError"
          ? `检查超时（${REQUEST_TIMEOUT_MS / 1000} 秒），网络可能不稳定，稍后再试`
          : "网络不可用或 GitHub 暂时访问不了，稍后再试",
    };
  } finally {
    clearTimeout(timer);
  }
}
