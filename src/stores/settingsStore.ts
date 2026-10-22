import { create } from "zustand";

import { readableError, toast } from "@/lib/toast";
import {
  getAutostart as apiGetAutostart,
  getSettings as apiGetSettings,
  setAutostart as apiSetAutostart,
  updateSettings as apiUpdateSettings,
  type AutostartStatus,
  type SettingsPatch,
  type SettingsSnapshot,
} from "@/services/settings";

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

  loadSettings: () => Promise<void>;
  loadAutostart: () => Promise<void>;
  /** 局部更新（只有通用页的三个行为项）；失败回读真实状态 */
  patchSettings: (patch: SettingsPatch) => Promise<void>;
  toggleAutostart: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,
  autostart: null,
  settingsError: false,

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
}));
