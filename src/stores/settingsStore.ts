import { create } from "zustand";

import { readableError, toast } from "@/lib/toast";
import {
  getAutostart as apiGetAutostart,
  getSettings as apiGetSettings,
  previewThemesDir as apiPreviewThemesDir,
  setAutostart as apiSetAutostart,
  setThemesDir as apiSetThemesDir,
  updateSettings as apiUpdateSettings,
  type AutostartStatus,
  type SettingsPatch,
  type SettingsSnapshot,
  type ThemesDirPlan,
  type ThemesDirProgress,
} from "@/services/settings";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 行为设置（设置 → 通用 / 快捷键）
 *
 * 状态读 Rust 的 settings.json（开发模式是 localStorage 顶上）；写操作
 * **改完即生效**：自启动写注册表、关闭行为即时同步托盘、开关在下次
 * 对应行为触发时生效。与 `theme-mode`（外观，存 localStorage）分工见
 * `utils/settings.rs` 模块注释。
 */
interface SettingsStore {
  /** null = 还没读到 */
  settings: SettingsSnapshot | null;
  /** 自启动状态；null = 还没读到 */
  autostart: AutostartStatus | null;
  /** 读取失败（典型：前端新、Rust 旧）；与「还没读到」区分开 */
  settingsError: boolean;

  /** 迁移确认框是否打开 */
  themesDirOpen: boolean;
  /** 选定的目标；null = 默认目录 */
  themesDirTarget: string | null;
  /** 预检结果；null = 还没拿到 */
  themesDirPlan: ThemesDirPlan | null;
  themesDirPlanLoading: boolean;
  /** 预检失败（目录不合法等），显示在确认框里 */
  themesDirPlanError: string | null;
  /** 迁移执行中：锁住按钮与关闭动作 */
  themesDirBusy: boolean;
  /** 执行进度（来自 `themes-dir-progress` 事件） */
  themesDirProgress: ThemesDirProgress | null;
  /** 迁移失败原因；失败后保留对话框，可重试或关闭 */
  themesDirError: string | null;

  loadSettings: () => Promise<void>;
  loadAutostart: () => Promise<void>;
  /** 局部更新（只有通用页的三个行为项）；失败回读真实状态 */
  patchSettings: (patch: SettingsPatch) => Promise<void>;
  toggleAutostart: () => Promise<void>;
  /** 打开迁移确认框并预检目标（null = 回默认） */
  openThemesDirDialog: (path: string | null) => void;
  /** 关闭确认框；执行中忽略 */
  closeThemesDirDialog: () => void;
  /** 预检失败后重试 */
  retryThemesDirPlan: () => Promise<void>;
  /** 确认迁移；成功后设置与主题列表一起刷新 */
  confirmThemesDirChange: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,
  autostart: null,
  settingsError: false,
  themesDirOpen: false,
  themesDirTarget: null,
  themesDirPlan: null,
  themesDirPlanLoading: false,
  themesDirPlanError: null,
  themesDirBusy: false,
  themesDirProgress: null,
  themesDirError: null,

  loadSettings: async () => {
    try {
      set({ settings: await apiGetSettings(), settingsError: false });
    } catch (err) {
      // 卡在「读取中…」比失败更骗人：挂错误态让界面能说清原因
      console.warn("[loadSettings]", readableError(err));
      set({ settingsError: true });
    }
  },

  loadAutostart: async () => {
    try {
      set({ autostart: await apiGetAutostart() });
    } catch (err) {
      console.warn("[loadAutostart]", readableError(err));
    }
  },

  patchSettings: async (patch) => {
    try {
      set({ settings: await apiUpdateSettings(patch) });
    } catch (err) {
      console.error("更新设置失败：", err);
      toast.error("设置失败", readableError(err));
      // 操作失败时回读真实状态，别让界面停在猜出来的值上
      await get().loadSettings();
    }
  },

  toggleAutostart: async () => {
    const current = get().autostart;
    if (!current) return;
    try {
      const next = await apiSetAutostart(!current.enabled);
      set({ autostart: next });
      toast.success(
        next.enabled ? "已开启开机自启动" : "已关闭开机自启动",
        next.enabled ? `命令指向 ${next.exe_path}` : undefined,
      );
    } catch (err) {
      console.error("设置开机自启动失败：", err);
      toast.error("设置失败", readableError(err));
      try {
        set({ autostart: await apiGetAutostart() });
      } catch {
        /* 回读失败就保留旧值 */
      }
    }
  },

  openThemesDirDialog: (path) => {
    if (get().themesDirBusy) return;
    set({
      themesDirOpen: true,
      themesDirTarget: path,
      themesDirPlan: null,
      themesDirPlanLoading: false,
      themesDirPlanError: null,
      themesDirProgress: null,
      themesDirError: null,
    });
    void get().retryThemesDirPlan();
  },

  closeThemesDirDialog: () => {
    // 迁移执行中不允许关闭：中途退出只会让人以为没搬完 / 没回滚
    if (get().themesDirBusy) return;
    set({
      themesDirOpen: false,
      themesDirTarget: null,
      themesDirPlan: null,
      themesDirPlanError: null,
      themesDirProgress: null,
      themesDirError: null,
    });
  },

  retryThemesDirPlan: async () => {
    const target = get().themesDirTarget;
    set({ themesDirPlanLoading: true, themesDirPlanError: null, themesDirPlan: null });
    try {
      const plan = await apiPreviewThemesDir(target);
      // 预检期间用户换了目标 / 关了对话框：丢弃过期结果
      if (get().themesDirTarget !== target || !get().themesDirOpen) return;
      set({ themesDirPlan: plan });
    } catch (err) {
      console.error("预检主题存储目录失败：", err);
      if (get().themesDirTarget === target) {
        set({ themesDirPlanError: readableError(err) });
      }
    } finally {
      set({ themesDirPlanLoading: false });
    }
  },

  confirmThemesDirChange: async () => {
    if (get().themesDirBusy) return;
    const target = get().themesDirTarget;
    const plan = get().themesDirPlan;
    if (!plan) return;

    set({
      themesDirBusy: true,
      themesDirError: null,
      themesDirProgress: {
        phase: "copy",
        current: 0,
        total: plan.file_count,
        message: "正在准备迁移…",
      },
    });

    try {
      const result = await apiSetThemesDir(target, (progress) => {
        // 只接受当前这次迁移的进度，避免关掉再开时旧事件串台
        if (get().themesDirBusy) set({ themesDirProgress: progress });
      });
      set({
        settings: result.settings,
        themesDirBusy: false,
        themesDirOpen: false,
        themesDirTarget: null,
        themesDirPlan: null,
        themesDirProgress: null,
        themesDirError: null,
      });
      toast.success("主题存储目录已更改", result.report.target);
      if (result.report.warnings.length > 0) {
        toast.warning(
          `迁移完成，有 ${result.report.warnings.length} 条提示`,
          result.report.warnings[0],
        );
      }
      // 目录换了，列表得从新位置重读，不然「我的主题」还停在旧目录的幻影上
      await useThemeStore.getState().loadThemes();
    } catch (err) {
      console.error("更改主题存储目录失败：", err);
      // 后端已回滚：保留对话框、显示原因，用户可以重试或关掉稍后再来
      set({ themesDirBusy: false, themesDirProgress: null, themesDirError: readableError(err) });
      await get().loadSettings();
    }
  },
}));

// 仅开发环境：迁移对话框的验收脚本需要直接驱动这套状态
if (import.meta.env.DEV) {
  (globalThis as unknown as { __settingsStore?: typeof useSettingsStore }).__settingsStore =
    useSettingsStore;
}
