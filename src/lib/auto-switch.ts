import { useSettingsStore } from "@/stores/settingsStore";
import { useThemeStore } from "@/stores/themeStore";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * 跟随系统深浅色自动切换主题（设置 → 通用 → 外观）
 *
 * 系统在深浅色之间翻转时自动应用配对主题：深色背景配浅色光标、浅色背景配
 * 深色光标，否则光标会在反色背景上看不见。触发时机只有三类：
 *
 * 1. 系统深浅色变化（matchMedia）；
 * 2. 窗口重新聚焦（WebView2 后台可能错过 change 事件，回前台补一次）；
 * 3. 设置 / 主题列表就绪或被修改（启动后的首次评估也走这条）。
 *
 * 两条退让规则，避免跟用户打架：
 * - 手动「还原默认」后**挂起**自动切换，直到系统深浅色再次翻转——否则
 *   还原动作会被下一帧评估立刻覆盖回去；
 * - 映射指向的主题被删除时静默跳过，不弹 toast 轰炸，等用户在设置里改选。
 */
const state = {
  /** init 之前不评估，避免 App 挂载早期抢跑 */
  armed: false,
  /** 同一时刻只允许一次应用动作在途 */
  applying: false,
  /** 最近一次自动应用的主题 ID；焦点触发时靠它避免重复应用 */
  lastAppliedId: null as string | null,
  /** 还原默认后挂起，直到系统深浅色翻转 */
  suspended: false,
  /** 合并同帧内的多次 store 变更成一次评估 */
  scheduled: false,
};

function prefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/** 当前系统深浅色该用的主题 ID；没开开关或该深浅色没配映射则返回 null */
function targetThemeId(): string | null {
  const settings = useSettingsStore.getState().settings;
  if (!settings?.auto_switch_enabled) return null;
  return prefersDark() ? settings.auto_switch_dark_id : settings.auto_switch_light_id;
}

function maybeSwitch(): void {
  // suspended = 用户刚还原了默认：焦点 / 设置重读都不能抢回来，
  // 只有系统深浅色真的翻转（onSystemSchemeChange）才解除
  if (!state.armed || state.applying || state.suspended) return;

  const target = targetThemeId();
  if (!target || target === state.lastAppliedId) return;

  const themeState = useThemeStore.getState();
  if (themeState.activeThemeId === target) {
    // 用户（或上一轮自动切换）已经把它应用上了：记下来，焦点触发别重复应用
    state.lastAppliedId = target;
    return;
  }
  if (themeState.themes.length > 0 && !themeState.themes.some((theme) => theme.id === target)) {
    // 映射指向的主题已被删除：等用户改选，不打扰
    state.lastAppliedId = null;
    return;
  }

  state.applying = true;
  void themeState.applyTheme(target).finally(() => {
    state.applying = false;
    state.lastAppliedId = target;
  });
}

/** 把评估排到微任务之后：一次 patch 连改几个字段只评估一次 */
function schedule(): void {
  if (state.scheduled) return;
  state.scheduled = true;
  queueMicrotask(() => {
    state.scheduled = false;
    maybeSwitch();
  });
}

function onSystemSchemeChange(): void {
  // 系统真的翻转了：挂起解除，自动切换重新接管
  state.suspended = false;
  maybeSwitch();
}

function onWindowFocus(): void {
  // 焦点触发不许解除挂起：那是用户刚还原了默认，不能抢回来
  maybeSwitch();
}

export function initAutoSwitch(): () => void {
  state.armed = true;

  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onSystemSchemeChange);
  window.addEventListener("focus", onWindowFocus);

  // 主题列表重载后 activeThemeId 可能变化；还原默认（非 null → null）即挂起
  const unsubThemes = useThemeStore.subscribe((now, prev) => {
    if (now.activeThemeId === null && prev.activeThemeId !== null) {
      state.suspended = true;
      state.lastAppliedId = null;
    }
    schedule();
  });

  // 设置补丁（开关 / 映射）随时可能让目标变化；只在这些字段真的变了时
  // 才解除挂起——备份进度之类无关变更不该把「还原默认」的挂起顶掉
  const unsubSettings = useSettingsStore.subscribe((now, prev) => {
    const a = now.settings;
    const b = prev.settings;
    if (
      a?.auto_switch_enabled !== b?.auto_switch_enabled ||
      a?.auto_switch_light_id !== b?.auto_switch_light_id ||
      a?.auto_switch_dark_id !== b?.auto_switch_dark_id
    ) {
      state.suspended = false;
    }
    schedule();
  });

  return () => {
    media.removeEventListener("change", onSystemSchemeChange);
    window.removeEventListener("focus", onWindowFocus);
    unsubThemes();
    unsubSettings();
    state.armed = false;
  };
}
