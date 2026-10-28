import { readableError, toast } from "@/lib/toast";
import { runAutoBackup } from "@/services/settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 自动备份（决策 32，设置 → 数据 → 数据备份）
 *
 * 每天第一份备份落进「备份历史」，兜住回收站兜不住的数据丢失（磁盘故障、
 * 误清空、目录迁移翻车）。触发时机只有三类，与既有「不轮询」口径一致：
 *
 * 1. 设置与主题列表就绪后（启动）；
 * 2. 窗口重新聚焦（常驻托盘的日子靠这个补上，节流到 30 分钟一次）；
 * 3. 用户把开关从关拨到开（当场给一份，开关立刻可见）。
 *
 * 当日去重、过期清理、与手动备份的互斥都在命令层（`run_auto_backup`），
 * 这里只管触发；多余的调用只是便宜的一次目录扫描。失败大多静默——
 * 「没有可备份的内容」和重操作锁占用都是正常态，其余失败每次会话只警告一次。
 */

/** 焦点触发的最小间隔：常驻托盘时反复切窗口不该频繁扫目录 */
const FOCUS_THROTTLE_MS = 30 * 60 * 1000;
/** store 变更触发的最小间隔：设置 / 主题列表的无关变更不反复发起检查 */
const STORE_THROTTLE_MS = 60 * 1000;

const state = {
  /** init 之前不动作，避免 App 挂载早期抢跑 */
  armed: false,
  /** 同一时刻只允许一次自动备份在途 */
  running: false,
  /** 上次尝试时刻；节流用 */
  lastAttempt: 0,
  /** 本次会话是否已警告过失败 */
  warned: false,
};

function isBenignError(message: string): boolean {
  return (
    message.includes("还没有可备份的内容") || message.includes("另一个操作正在进行")
  );
}

function attempt(force = false): void {
  if (!state.armed || state.running) return;

  const { settings } = useSettingsStore.getState();
  const themes = useThemeStore.getState();
  // 设置与主题列表都就绪才动：半截状态下连「有没有内容可备份」都定不了
  if (!settings || themes.loading || themes.loadError) return;
  if (!settings.auto_backup_enabled) return;
  if (!force && Date.now() - state.lastAttempt < STORE_THROTTLE_MS) return;

  state.running = true;
  state.lastAttempt = Date.now();
  void runAutoBackup(settings.auto_backup_keep)
    .catch((err) => {
      const message = readableError(err);
      console.warn("[auto-backup]", message);
      if (!isBenignError(message) && !state.warned) {
        state.warned = true;
        toast.warning("自动备份失败", message);
      }
    })
    .finally(() => {
      state.running = false;
    });
}

function onWindowFocus(): void {
  if (Date.now() - state.lastAttempt < FOCUS_THROTTLE_MS) return;
  attempt();
}

export function initAutoBackup(): () => void {
  state.armed = true;

  window.addEventListener("focus", onWindowFocus);

  // 开关从关拨到开：当场给一份（当日已有则命令层跳过）；其余设置变更走节流
  const unsubSettings = useSettingsStore.subscribe((now, prev) => {
    const enabled = now.settings?.auto_backup_enabled ?? false;
    const wasEnabled = prev.settings?.auto_backup_enabled ?? false;
    attempt(enabled && !wasEnabled);
  });

  // 主题列表就绪（loading 翻转）也是启动闸门的一部分
  const unsubThemes = useThemeStore.subscribe((now, prev) => {
    if (now.loading !== prev.loading) attempt();
  });

  return () => {
    window.removeEventListener("focus", onWindowFocus);
    unsubSettings();
    unsubThemes();
    state.armed = false;
  };
}
