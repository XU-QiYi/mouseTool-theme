import { autoSwitchTargetId } from "@/lib/auto-switch";
import { readableError, toast } from "@/lib/toast";
import type { SettingsSnapshot } from "@/services/settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThemeStore } from "@/stores/themeStore";
import type { CursorTheme, HistoryEntry } from "@/types/theme";

/**
 * 光标守护：启动或检测到外部改写后，把「应该用的那套主题」重新应用回去
 *
 * 系统设置页、其它光标工具、登录后的主题还原都可能整体改写注册表（决策 24）。
 * 自动动作只在三种时机出手：启动后的首次检查、聚焦重查发现 `activeExternal`
 * 为真、用户在设置里刚打开开关；设置页另有「立即恢复」手动入口。
 * **不轮询、不监听注册表、不做后台服务**；应用仍走 `themeStore.applyTheme`，
 * 历史和「正在使用」口径完全复用。
 *
 * 两条不抢的规则：
 * - 注册表里已有明确主题（`activeThemeId !== null`）时一律不动；
 * - 运行期只处理「外部改写」（槽位非空但认不出），系统默认不碰——
 *   用户刚点过「还原系统默认」，不能被下一帧抢回去（与自动切换的挂起同义）。
 *
 * 启动检查会覆盖系统默认：这是开关的承诺，也是「重启后光标被重置」的修复点。
 */

/** 守护能恢复的目标：主题库里仍然存在的方案 */
export interface GuardTarget {
  id: string;
  name: string;
}

/**
 * 选出守护目标：自动切换开启时优先当前深浅色配对，否则用最后使用的一套
 *
 * 配对主题被删时返回 null 而不是拿历史顶替：用户在设置里明确配过的那套
 * 已经不存在，恢复另一套写回注册表只会让「跟随系统」这句话变成谎话。
 */
export function resolveGuardTarget(
  settings: SettingsSnapshot | null,
  themes: CursorTheme[],
  recent: HistoryEntry[],
  autoTarget: string | null,
): GuardTarget | null {
  const find = (id: string) => themes.find((theme) => theme.id === id) ?? null;

  if (settings?.auto_switch_enabled && autoTarget) {
    const mapped = find(autoTarget);
    return mapped ? { id: mapped.id, name: mapped.name } : null;
  }

  const last = recent[0];
  if (!last) return null;
  const theme = find(last.theme_id);
  return theme ? { id: theme.id, name: theme.name } : null;
}

type GuardReason = "startup" | "override" | "enable" | "manual";

const state = {
  armed: false,
  /** 卸载 / StrictMode 重挂时递增；旧的回调据此放弃后续动作 */
  epoch: 0,
  applying: false,
  /** 启动检查只做一次（等设置与主题列表都就绪之后） */
  startupDone: false,
  scheduled: false,
  prevEnabled: false,
  /** 本轮外部改写已经尝试过：失败也不反复写注册表 / 反复弹提示 */
  externalHandled: false,
};

function schedule(): void {
  if (state.scheduled) return;
  state.scheduled = true;
  queueMicrotask(() => {
    state.scheduled = false;
    evaluate();
  });
}

function evaluate(): void {
  if (!state.armed) return;

  const settings = useSettingsStore.getState().settings;
  if (!settings) return;

  const themes = useThemeStore.getState();
  const enabled = settings.cursor_guard_enabled;

  // 启动检查：设置与主题列表都就绪后才算数；读取失败时保持未完成，
  // 等用户重试成功后再补一次，不能拿半截列表做判断
  if (!state.startupDone) {
    if (themes.loading || themes.loadError) return;
    state.startupDone = true;
    state.prevEnabled = enabled;
    state.externalHandled = themes.activeExternal;
    if (enabled && themes.activeThemeId === null) void attempt("startup");
    return;
  }

  // 刚打开开关：立刻补一次；主题列表还没就绪就等下一次 store 变化
  if (enabled && !state.prevEnabled) {
    if (themes.loading || themes.loadError) return;
    state.prevEnabled = true;
    state.externalHandled = themes.activeExternal;
    void attempt("enable");
    return;
  }
  state.prevEnabled = enabled;

  if (!enabled) {
    state.externalHandled = false;
    return;
  }

  if (!themes.activeExternal) {
    state.externalHandled = false;
    return;
  }
  // 外部改写按「一轮」处理：加载失败 / 正在重载时先不消费，
  // 等数据就绪后仍能补上本次恢复
  if (themes.loading || themes.loadError || state.externalHandled) return;
  state.externalHandled = true;
  void attempt("override");
}

async function attempt(reason: GuardReason): Promise<void> {
  if (!state.armed || state.applying) return;
  const epoch = state.epoch;
  state.applying = true;

  try {
    const current = () => useThemeStore.getState();
    if (current().loading || current().loadError) return;

    if (reason !== "override") {
      // 启动 / 开启 / 手动：先真读一次注册表。读失败时不知道当前是
      // 「系统默认」还是「打不开注册表」，不能拿历史去猜
      const ok = await current().refreshActive();
      if (state.epoch !== epoch || !state.armed) return;
      if (!ok) {
        // 注册表这一下读不到：不猜。启动检查保持未完成，等下一次读取成功再补
        if (reason === "startup") state.startupDone = false;
        if (reason === "manual") {
          toast.error("读取当前光标状态失败", "请稍后重试");
        }
        return;
      }
    }

    const now = current();
    if (now.activeThemeId !== null) return; // 已有明确主题：不抢
    if (reason === "override" && !now.activeExternal) return; // 已被别处恢复
    if (reason !== "manual") {
      const enabled = useSettingsStore.getState().settings?.cursor_guard_enabled ?? false;
      if (!enabled) return;
    }

    const target = resolveGuardTarget(
      useSettingsStore.getState().settings,
      now.themes,
      now.recent,
      autoSwitchTargetId(),
    );
    if (!target) {
      if (reason === "manual") {
        toast.info("没有可恢复的主题", "上次使用的主题可能已被删除");
      }
      return;
    }

    // 本轮已尝试：即便应用失败也不再自动重试，等下一轮外部改写或用户手动点
    state.externalHandled = now.activeExternal;
    await current().applyTheme(target.id, { silent: true });
    if (state.epoch !== epoch || !state.armed) return;
    if (current().activeThemeId !== target.id) return; // 失败已有错误提示

    if (reason === "manual") {
      toast.success(`已恢复「${target.name}」`, "已重新应用上次使用的主题");
      return;
    }
    const detail =
      reason === "startup"
        ? "启动时发现当前光标不是本应用应用的主题"
        : reason === "override"
          ? "检测到光标被系统设置改写"
          : "已开启自动恢复";
    toast.info(`光标守护：已恢复「${target.name}」`, detail);
  } catch (err) {
    // 自动动作失败不弹第二条提示（applyTheme / refreshActive 已经说过原因），
    // 但必须收口，不能留下未处理的 Promise 让动作悄悄消失
    console.error("[cursor-guard]", readableError(err));
    if (reason === "manual") toast.error("恢复失败", readableError(err));
  } finally {
    if (state.epoch === epoch) state.applying = false;
  }
}

/** 设置页「恢复上次主题」：手动动作不受自动开关限制 */
export function restoreNow(): void {
  if (state.armed) void attempt("manual");
}

export function initCursorGuard(): () => void {
  state.armed = true;
  state.epoch += 1;
  state.applying = false;
  state.startupDone = false;
  state.scheduled = false;
  state.prevEnabled = false;
  state.externalHandled = false;

  const unsubTheme = useThemeStore.subscribe(schedule);
  const unsubSettings = useSettingsStore.subscribe(schedule);
  schedule();

  return () => {
    state.armed = false;
    state.epoch += 1;
    unsubTheme();
    unsubSettings();
  };
}
