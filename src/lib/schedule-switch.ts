import { useSettingsStore } from "@/stores/settingsStore";
import { useThemeStore } from "@/stores/themeStore";
import { isInWindow, msToNextBoundary } from "@/lib/schedule-window";
import type { SettingsSnapshot } from "@/services/settings";

/**
 * 定时切换主题（决策 33，设置 → 通用）
 *
 * 时间段内应用「期间内主题」、时间段外应用「期间外主题」，例如上班用低调
 * 方案、下班换炫彩的。与跟随系统切换（决策 25）的优先级：**时间段内且期间
 * 内主题已设置时，定时切换拥有这个时段，深浅色切换让位**（`auto-switch.ts`
 * 读 `scheduleOwnsNow`）；窗口外深浅色照旧。
 *
 * 触发时机只有四类，不轮询：
 * 1. 设置 / 主题列表就绪或被修改（启动后的首次评估也走这条）；
 * 2. 窗口重新聚焦（错过边界的兜底，比如电脑跨过 18:00 后才回来）；
 * 3. 时间边界（`setTimeout` 到下一个 start / end，触发后重排）；
 * 4. 系统深浅色翻转不直接触发本模块——让位规则交由 auto-switch 处理。
 *
 * 退让规则与 auto-switch 相同：手动「还原默认」后挂起，直到下一个时间边界
 * 或用户改设置；映射指向的主题被删除时静默跳过，不弹 toast。
 */

const state = {
  /** init 之前不评估，避免 App 挂载早期抢跑 */
  armed: false,
  /** 同一时刻只允许一次应用动作在途 */
  applying: false,
  /** 最近一次自动应用的主题 ID；焦点触发时靠它避免重复应用 */
  lastAppliedId: null as string | null,
  /** 还原默认后挂起，直到下一个时间边界 */
  suspended: false,
  /** 合并同帧内的多次 store 变更成一次评估 */
  scheduled: false,
  /** 下一个时间边界的定时器；设置变化时重排 */
  timer: null as ReturnType<typeof setTimeout> | null,
};

/** 当前是否处于时间段内（纯时间计算在 `lib/schedule-window.ts`，决策 49） */
export function isScheduleInWindow(settings: SettingsSnapshot): boolean {
  return isInWindow(settings.schedule_start, settings.schedule_end, new Date());
}

/**
 * 定时切换是否正「拥有」当前时段：开关开 + 处于时间段内 + 期间内主题已设。
 * 这是 auto-switch 的让位判据（决策 33）——深浅色配对在这段时间不动作。
 */
export function scheduleOwnsNow(settings: SettingsSnapshot): boolean {
  if (!settings.schedule_switch_enabled) return false;
  return isScheduleInWindow(settings) && Boolean(settings.schedule_in_id);
}

/** 当前时刻定时切换该用的主题 ID；没开开关或该时段没配映射则返回 null */
export function scheduleTargetId(): string | null {
  const settings = useSettingsStore.getState().settings;
  if (!settings?.schedule_switch_enabled) return null;
  return (isScheduleInWindow(settings) ? settings.schedule_in_id : settings.schedule_out_id) ?? null;
}

function maybeSwitch(): void {
  if (!state.armed || state.applying || state.suspended) return;

  const target = scheduleTargetId();
  if (!target || target === state.lastAppliedId) return;

  const themeState = useThemeStore.getState();
  if (themeState.themes.length === 0) {
    // 启动竞态：settings 常先于主题列表就绪（单文件 vs 目录扫描）。
    // 空列表下 applyTheme 会静默 no-op，这里若照常走到 finally 把 lastAppliedId
    // 记上，列表就绪后的评估会被去重挡住，「启动后的首次评估」就永远不生效；
    // 所以直接退避什么都不记——列表到位时的订阅回调会再触发一次评估。
    return;
  }
  if (themeState.activeThemeId === target) {
    state.lastAppliedId = target;
    return;
  }
  if (!themeState.themes.some((theme) => theme.id === target)) {
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

/** 排一个定时器到下一个 start / end 边界；边界跨过时评估一次并重排 */
function armTimer(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const settings = useSettingsStore.getState().settings;
  if (!settings?.schedule_switch_enabled) return;
  // 两个边界的最近一个；最长间隔 24h，不会触到 setTimeout 的 2^31 上限
  const delay = msToNextBoundary(settings.schedule_start, settings.schedule_end, new Date());
  if (delay === null) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    // 新时段开始：挂起解除（这与系统深浅色翻转解除挂起是同一个语义）
    state.suspended = false;
    maybeSwitch();
    armTimer();
  }, delay);
}

function onWindowFocus(): void {
  // 焦点触发不许解除挂起：那是用户刚还原了默认，不能抢回来
  maybeSwitch();
}

export function initScheduleSwitch(): () => void {
  state.armed = true;
  armTimer();

  window.addEventListener("focus", onWindowFocus);

  // 还原默认（非 null → null）即挂起；主题列表重载可能带来 activeThemeId 变化
  const unsubThemes = useThemeStore.subscribe((now, prev) => {
    if (now.activeThemeId === null && prev.activeThemeId !== null) {
      state.suspended = true;
      state.lastAppliedId = null;
    }
    schedule();
  });

  // 设置补丁：只认自己的字段——时间 / 映射 / 开关变化要重排定时器并解除挂起，
  // 备份进度之类无关变更不该把挂起顶掉
  const unsubSettings = useSettingsStore.subscribe((now, prev) => {
    const a = now.settings;
    const b = prev.settings;
    if (
      a?.schedule_switch_enabled !== b?.schedule_switch_enabled ||
      a?.schedule_start !== b?.schedule_start ||
      a?.schedule_end !== b?.schedule_end ||
      a?.schedule_in_id !== b?.schedule_in_id ||
      a?.schedule_out_id !== b?.schedule_out_id
    ) {
      state.suspended = false;
      armTimer();
    }
    schedule();
  });

  return () => {
    window.removeEventListener("focus", onWindowFocus);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    unsubThemes();
    unsubSettings();
    state.armed = false;
  };
}
