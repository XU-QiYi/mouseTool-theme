import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { getWindowsVersion } from "@/services/system";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 组装「诊断信息」文本 —— 只读例外（同 `useCursorPreview`）：
 * 纯派生展示数据，不写全局状态，直接读 service 与 store 快照；
 * 塞进 store 会让主题列表的任何变更都触发诊断文本重算，没有意义。
 */
export function useDiagnostics(): string {
  const themes = useThemeStore((s) => s.themes);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const dataDir = useThemeStore((s) => s.dataDir);
  const [text, setText] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [version, windows] = await Promise.all([
        getVersion().catch(() => "未知"),
        getWindowsVersion().catch(() => "未知"),
      ]);
      if (!alive) return;

      // selector 只取原始状态，派生计算放在 effect 里，避免无限重渲染
      const builtIn = themes.filter((theme) => theme.is_built_in).length;
      const mine = themes.length - builtIn;
      const active = themes.find((theme) => theme.id === activeThemeId);

      setText(
        [
          `鼠标主题工具 v${version}`,
          `系统：${windows}`,
          `数据目录：${dataDir ?? "读取中…"}`,
          `主题：系统 ${builtIn} 套 · 导入 ${mine} 套`,
          `当前使用：${active?.name ?? "系统默认"}`,
        ].join("\n"),
      );
    })();
    return () => {
      alive = false;
    };
  }, [themes, activeThemeId, dataDir]);

  return text;
}
