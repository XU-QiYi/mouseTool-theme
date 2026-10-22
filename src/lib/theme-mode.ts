import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { inTauri } from "@/services/theme";

/**
 * 外观：默认跟随系统，允许手动覆盖成浅色 / 深色
 *
 * 三条规矩：
 * 1. `system` 时不写死任何偏好，系统一变就跟着变；
 * 2. 选了浅/深就是**手动覆盖**，此后不再跟随系统，直到用户选回 `system`；
 * 3. 只有一处状态（这个模块），Sidebar 通过 `useThemeMode` 读，
 *    避免"组件各自记一份、切完互相同步"的老问题。
 */
export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "cursorstudio.theme-mode";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const listeners = new Set<() => void>();

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
  } catch {
    // 隐私模式等场景读不到，退回默认值即可，不必打扰用户
    return "system";
  }
}

let current: ThemeMode = readStoredMode();

function prefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/** 解析成"现在到底是不是深色" */
function resolveDark(mode: ThemeMode): boolean {
  if (mode === "system") return prefersDark();
  return mode === "dark";
}

function paint(mode: ThemeMode): void {
  document.documentElement.classList.toggle("dark", resolveDark(mode));
}

/**
 * 让 Windows 标题栏跟着一起变
 *
 * 不做这一步就会出现"页面深色、标题栏还是浅色"的割裂 —— 那正是当初
 * 不想做开关的理由。`system` 传 null，交还给系统。
 * 失败只记日志：页面主题已经生效，不值得为标题栏打断用户。
 */
async function syncWindowTheme(mode: ThemeMode): Promise<void> {
  if (!inTauri) return;
  try {
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch (err) {
    console.warn("[theme] 标题栏主题同步失败：", err);
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getThemeMode(): ThemeMode {
  return current;
}

export function subscribeThemeMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setThemeMode(mode: ThemeMode): void {
  current = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 存不了就只在本次会话生效 */
  }
  paint(mode);
  void syncWindowTheme(mode);
  notify();
}

/** 在首帧之前调用：先落 class，避免深色系统上先白闪一下 */
export function initThemeMode(): void {
  paint(current);
  void syncWindowTheme(current);

  // 只有"跟随系统"才需要响应系统切换；手动覆盖时用户的选择优先
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (current === "system") {
      paint(current);
      notify();
    }
  });
}

/** 组件里读当前模式；写只能走 setThemeMode */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeThemeMode, getThemeMode, getThemeMode);
}
