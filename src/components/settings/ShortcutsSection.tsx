import { useEffect } from "react";

import { Toggle } from "@/components/ui/toggle";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * 快捷键：应用内键盘操作一览与开关
 *
 * 全部是应用内快捷键（Ctrl 组合，不抢输入框），不注册系统全局热键。
 */
export function ShortcutsSection() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const patchSettings = useSettingsStore((s) => s.patchSettings);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return (
    <div>
      <SettingsGroup>
        <SettingCard
          title="启用应用内快捷键"
          description="关闭后下列按键立即停用（Ctrl+F 交还给 WebView 自带查找）"
          action={
            <Toggle
              label="启用应用内快捷键"
              checked={settings?.shortcuts_enabled ?? true}
              onCheckedChange={(checked) => void patchSettings({ shortcuts_enabled: checked })}
              disabled={!settings}
            />
          }
        />

        <SettingCard
          title="快捷键一览"
          description="只在应用获得键盘焦点时生效；列表与按键处理同源，改一处两边一致"
        >
          <ul className="mt-3 space-y-1.5">
            {SHORTCUTS.map((shortcut) => (
              <li key={shortcut.id} className="flex items-center gap-3">
                <kbd className="min-w-16 rounded-md bg-muted px-1.5 py-0.5 text-center font-mono text-2xs text-muted-foreground">
                  {shortcut.keys}
                </kbd>
                <span className="text-xs text-muted-foreground">{shortcut.label}</span>
              </li>
            ))}
          </ul>
        </SettingCard>
      </SettingsGroup>
    </div>
  );
}
