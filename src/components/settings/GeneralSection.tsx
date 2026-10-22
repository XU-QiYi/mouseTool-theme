import { Monitor, Moon, Sun } from "lucide-react";

import { Segmented } from "@/components/ui/segmented";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { setThemeMode, useThemeMode, type ThemeMode } from "@/lib/theme-mode";

const THEME_MODES = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
] as const;

/**
 * 通用：外观、启动与关闭、存储与更新
 *
 * 每张卡片一个可立即生效的决定；行为类写 settings.json（Rust 也要读），
 * 纯界面类（外观）沿用 localStorage——首帧落色需要同步读，见 `lib/theme-mode.ts`。
 */
export function GeneralSection() {
  const themeMode = useThemeMode();

  return (
    <div>
      <SettingsGroup title="外观">
        <SettingCard
          title="应用主题"
          description="默认跟随系统；手动选浅色 / 深色后不再跟随，直到选回「跟随系统」"
          action={
            <Segmented
              label="应用主题"
              value={themeMode}
              options={THEME_MODES.map((mode) => ({
                value: mode.value as ThemeMode,
                label: mode.label,
                icon: mode.icon,
              }))}
              onChange={setThemeMode}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}
