import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { SHORTCUTS } from "@/lib/shortcuts";

/**
 * 快捷键：应用内键盘操作一览
 *
 * 全部是应用内快捷键（Ctrl 组合，不抢输入框），不注册系统全局热键。
 */
export function ShortcutsSection() {
  return (
    <div>
      <SettingsGroup>
        <SettingCard
          title="应用内快捷键"
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
