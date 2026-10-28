import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Toggle } from "@/components/ui/toggle";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { SettingsStatusBanner } from "@/components/settings/SettingsStatusBanner";
import { ThemesDirDialog } from "@/components/settings/ThemesDirDialog";
import { autoSwitchTargetId } from "@/lib/auto-switch";
import { resolveGuardTarget, restoreNow } from "@/lib/cursor-guard";
import { setThemeMode, useThemeMode, type ThemeMode } from "@/lib/theme-mode";
import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import type { CloseBehavior } from "@/services/settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { actionBusyKey, useThemeStore } from "@/stores/themeStore";

const THEME_MODES = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
] as const;

const CLOSE_BEHAVIORS = [
  { value: "exit", label: "直接退出" },
  { value: "tray", label: "最小化到托盘" },
] as const;

/**
 * 深浅色主题映射的单行下拉：用原生 `<select>`（无障碍与键盘行为免费，
 * 深浅色下弹层颜色由 color-scheme 同步）；选项是全部主题，「不切换」存空串。
 */
function ThemeMappingSelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const themes = useThemeStore((s) => s.themes);
  const exists = themes.some((theme) => theme.id === value);
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <select
        aria-label={label}
        data-auto-switch-select={label}
        className="h-8 max-w-56 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">不切换</option>
        {value !== "" && !exists && <option value={value}>（主题已删除，请改选）</option>}
        {themes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * 通用：外观、启动与关闭、存储与更新
 *
 * 每张卡片一个可立即生效的决定：外观走 localStorage（首帧落色要同步读），
 * 其余行为项走 settings.json（Rust 也要读，见 `utils/settings.rs` 的分工注释）。
 * 读取失败不静默：顶部横幅给重试出口，别让开关永远停在「读取中…」。
 */
export function GeneralSection() {
  const themeMode = useThemeMode();
  const settings = useSettingsStore((s) => s.settings);
  const settingsError = useSettingsStore((s) => s.settingsError);
  const autostart = useSettingsStore((s) => s.autostart);
  const autostartError = useSettingsStore((s) => s.autostartError);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadAutostart = useSettingsStore((s) => s.loadAutostart);
  const patchSettings = useSettingsStore((s) => s.patchSettings);
  const toggleAutostart = useSettingsStore((s) => s.toggleAutostart);
  const openThemesDirDialog = useSettingsStore((s) => s.openThemesDirDialog);
  const themesDirBusy = useSettingsStore((s) => s.themesDirBusy);
  const recent = useThemeStore((s) => s.recent);
  const themes = useThemeStore((s) => s.themes);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const themesLoading = useThemeStore((s) => s.loading);
  const themesLoadError = useThemeStore((s) => s.loadError);
  const busy = useThemeStore((s) => s.busy);

  useEffect(() => {
    loadSettings();
    loadAutostart();
  }, [loadSettings, loadAutostart]);

  // 守护目标与状态行：自动切换开启时目标是「当前深浅色的配对」，
  // 否则是最近一次应用的方案；配对主题被删时明确提示改选，不拿历史顶替
  const autoTarget = settings?.auto_switch_enabled ? autoSwitchTargetId() : null;
  const guardTarget = resolveGuardTarget(settings, themes, recent, autoTarget);
  const lastUsed = recent[0] ?? null;
  const guardMappingMissing = Boolean(
    settings?.auto_switch_enabled &&
      autoTarget &&
      !themes.some((theme) => theme.id === autoTarget),
  );
  const guardApplying = guardTarget
    ? Boolean(busy[actionBusyKey("apply", guardTarget.id)])
    : false;
  const guardStatus = themesLoadError
    ? "主题列表读取失败，暂时无法判断可恢复目标"
    : themesLoading
      ? "正在读取主题…"
      : guardMappingMissing
        ? "当前深浅色配对的主题已被删除，请在上方改选"
        : guardTarget
          ? `可恢复「${guardTarget.name}」${activeThemeId === guardTarget.id ? "（当前正在使用）" : ""}`
          : lastUsed
            ? `上次使用「${lastUsed.name}」，但它已不在主题库`
            : "还没有使用记录，先应用一次主题";
  const guardTitle = themesLoadError || themesLoading
    ? "主题列表还没就绪"
    : !guardTarget
      ? "没有可恢复的主题"
      : activeThemeId === guardTarget.id
        ? "当前正在使用这个主题"
        : guardApplying
          ? "正在恢复…"
          : "把主题库里应该用的那套主题重新应用一次";
  const guardDisabled =
    themesLoading ||
    Boolean(themesLoadError) ||
    !guardTarget ||
    activeThemeId === guardTarget.id ||
    guardApplying;

  // 选文件夹 → 先预检再让用户确认（迁移会动全部主题文件，不能选完就开搬）
  const pickThemesDir = async () => {
    if (!inTauri) {
      toast.info("开发模式无法选择目录", "文件选择需要桌面环境，请用 npm run tauri dev 启动");
      return;
    }
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: "选择主题存储目录",
      });
      if (typeof selected === "string") {
        openThemesDirDialog(selected);
      }
    } catch (err) {
      console.error("选择目录失败：", err);
      toast.error("没能打开文件夹选择框", "请重试");
    }
  };

  return (
    <div>
      {settingsError && (
        <SettingsStatusBanner
          tone="destructive"
          title="设置读取失败"
          retryLabel="重试"
          onRetry={() => void loadSettings()}
        >
          {settingsError}。设置暂时无法修改，重启应用通常可以恢复。
        </SettingsStatusBanner>
      )}

      {settings && settings.warnings.length > 0 && (
        <div
          role="alert"
          data-settings-warning
          className="mb-4 rounded-lg bg-warning/10 px-3 py-2 ring-1 ring-warning/25"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-warning">设置文件需要处理</p>
              <ul className="mt-0.5 space-y-0.5">
                {settings.warnings.map((warning) => (
                  <li key={warning} className="break-all text-2xs text-muted-foreground">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <SettingsGroup title="外观">
        <SettingCard
          title="界面外观"
          description="默认跟随系统；手动选浅色 / 深色后不再跟随，直到选回「跟随系统」"
          action={
            <Segmented
              label="界面外观"
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

        <SettingCard
          title="跟随系统切换主题"
          description="系统在深浅色之间切换时自动应用配对主题，光标不会在反色背景上消失；手动「还原默认」会暂停切换，直到系统深浅色再次变化"
          action={
            <Toggle
              label="跟随系统切换主题"
              checked={settings?.auto_switch_enabled ?? false}
              onCheckedChange={(checked) => void patchSettings({ auto_switch_enabled: checked })}
              disabled={!settings}
            />
          }
        >
          <div className="mt-3 grid gap-2">
            <ThemeMappingSelect
              label="系统浅色时用"
              value={settings?.auto_switch_light_id ?? ""}
              onChange={(id) => void patchSettings({ auto_switch_light_id: id })}
              disabled={!settings}
            />
            <ThemeMappingSelect
              label="系统深色时用"
              value={settings?.auto_switch_dark_id ?? ""}
              onChange={(id) => void patchSettings({ auto_switch_dark_id: id })}
              disabled={!settings}
            />
          </div>
        </SettingCard>

        <SettingCard
          title="光标守护"
          description="启动时或检测到光标被系统设置改写后，自动恢复上次使用的主题；只恢复主题库里仍在的方案，需要应用正在运行（可配合开机自启动），自动切换开启时优先用当前深浅色的配对主题"
          action={
            <Toggle
              label="光标守护"
              checked={settings?.cursor_guard_enabled ?? false}
              onCheckedChange={(checked) =>
                void patchSettings({ cursor_guard_enabled: checked })
              }
              disabled={!settings}
            />
          }
        >
          <div className="mt-3 flex items-center justify-between gap-3">
            <p
              data-guard-status
              title={guardStatus}
              className="min-w-0 truncate text-2xs text-muted-foreground"
            >
              {guardStatus}
            </p>
            <Button
              size="xs"
              variant="outline"
              onClick={restoreNow}
              disabled={guardDisabled}
              aria-busy={guardApplying}
              title={guardTitle}
            >
              {guardApplying ? "恢复中…" : "立即恢复"}
            </Button>
          </div>
        </SettingCard>
      </SettingsGroup>

      <SettingsGroup title="启动与关闭">
        <SettingCard
          title="开机自启动"
          description="登录 Windows 后自动启动；注册的是当前程序位置，移动安装目录后需重新开启"
          action={
            <Toggle
              label="开机自启动"
              checked={autostart?.enabled ?? false}
              onCheckedChange={() => void toggleAutostart()}
              disabled={!autostart}
            />
          }
        >
          <p data-autostart-status className="mt-3 break-all text-2xs text-muted-foreground">
            {autostart ? (
              autostart.enabled ? (
                `已开启 · 命令指向 ${autostart.exe_path}`
              ) : (
                "未开启"
              )
            ) : autostartError ? (
              <>读取失败：{autostartError}</>
            ) : (
              "读取中…"
            )}
          </p>
          {autostartError && !autostart && (
            <Button
              size="xs"
              variant="outline"
              className="mt-1.5"
              onClick={() => void loadAutostart()}
            >
              重试读取
            </Button>
          )}
        </SettingCard>

        <SettingCard
          title="关闭行为"
          description={
            settings?.close_behavior === "tray"
              ? "关窗口后程序缩到托盘继续运行；单击托盘图标或右键菜单可回到主界面"
              : "关窗口即退出程序"
          }
          action={
            <Segmented
              label="关闭行为"
              value={settings?.close_behavior ?? "exit"}
              options={CLOSE_BEHAVIORS.map((item) => ({
                value: item.value as CloseBehavior,
                label: item.label,
              }))}
              onChange={(value) => void patchSettings({ close_behavior: value })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="存储与更新">
        <SettingCard
          title="主题存储目录"
          description="存放导入的主题包；更改位置时会把现有主题一起搬过去"
          action={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void pickThemesDir()}
                disabled={themesDirBusy}
              >
                更改…
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openThemesDirDialog(null)}
                disabled={!settings?.themes_dir || themesDirBusy}
                title={settings?.themes_dir ? "搬回默认目录" : "当前已是默认目录"}
              >
                恢复默认
              </Button>
            </div>
          }
        >
          <p
            data-themes-dir
            className="mt-3 break-all font-mono text-2xs text-muted-foreground select-text"
          >
            {settings?.effective_themes_dir ?? "…"}
          </p>
        </SettingCard>

        <SettingCard
          title="自动检查更新"
          description="启动时检查 GitHub Releases 有没有新版本；只在发现新版本时提示，不打断使用"
          action={
            <Toggle
              label="自动检查更新"
              checked={settings?.auto_check_update ?? true}
              onCheckedChange={(checked) => void patchSettings({ auto_check_update: checked })}
              disabled={!settings}
            />
          }
        />
      </SettingsGroup>

      <ThemesDirDialog />
    </div>
  );
}
