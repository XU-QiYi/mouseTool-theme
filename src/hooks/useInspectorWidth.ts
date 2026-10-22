import { useCallback, useEffect, useState } from "react";

/** 检查器（右侧详情面板）的宽度边界，单位 px */
export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 560;
export const INSPECTOR_DEFAULT = 320;

/** 侧栏固定宽度（`w-56`）与正文区最小可用宽度，用来算当前窗口能给出的上限 */
const SIDEBAR = 224;
const MIN_CONTENT = 440;

/**
 * 把宽度夹到「视觉边界」与「窗口实际能给的空间」之间
 *
 * 窗口被拉窄时必须跟着收回，否则检查器会把自己顶出屏幕、正文挤成一条缝。
 */
export function clampInspectorWidth(width: number): number {
  const room =
    typeof window === "undefined" ? INSPECTOR_MAX : window.innerWidth - SIDEBAR - MIN_CONTENT;
  const upper = Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, room));
  return Math.round(Math.min(Math.max(width, INSPECTOR_MIN), upper));
}

/**
 * 检查器宽度：只在本次会话内有效，不落盘
 *
 * 面板宽度是「此刻怎么摆」而不是产品状态；存进 localStorage 会在改了默认宽度
 * 或改了最小正文宽度后留下一个不再被任何规则覆盖的旧值。
 */
export function useInspectorWidth() {
  const [width, setWidth] = useState(() => clampInspectorWidth(INSPECTOR_DEFAULT));

  // 窗口变窄时跟着收回；变宽不自动涨回去，尊重用户拖过的位置
  useEffect(() => {
    const onResize = () => setWidth((current) => clampInspectorWidth(current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const resize = useCallback((next: number) => setWidth(clampInspectorWidth(next)), []);

  return [width, resize] as const;
}
