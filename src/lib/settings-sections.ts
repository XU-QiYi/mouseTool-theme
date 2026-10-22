import { Database, Info, Keyboard, Settings2, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * 设置分组清单 —— 加一个分组只改两处
 *
 * 1. 这张表加一条（侧栏文案 / 内容页标题 / 页头说明）；
 * 2. `SettingsView.tsx` 的 `SECTIONS` 映射加一行分组组件。
 *
 * 与 `lib/pages.ts` 同一个思路：`Record<SettingsSection, …>` 逼着补全，
 * 漏了就编译不过。进入「设置」后侧栏从主导航切换成本表的分组列表，
 * 点分组即换内容页——设置不是一页大杂烩，是几个各管一摊的小页。
 */
export interface SettingsSectionMeta {
  /** 侧栏分组文案 */
  label: string;
  icon: LucideIcon;
  /** 内容页主标题（与侧栏一致：进哪组看哪页） */
  title: string;
  /** 页头副标题：这一组管什么 */
  hint: string;
}

export const SETTINGS_SECTIONS = {
  general: {
    label: "通用",
    icon: SlidersHorizontal,
    title: "通用",
    hint: "外观、启动与关闭、存储与更新",
  },
  shortcuts: {
    label: "快捷键",
    icon: Keyboard,
    title: "快捷键",
    hint: "应用内键盘操作一览与开关",
  },
  data: {
    label: "数据",
    icon: Database,
    title: "数据",
    hint: "数据目录、备份与诊断信息",
  },
  system: {
    label: "系统集成",
    icon: Settings2,
    title: "系统集成",
    hint: "Windows 面板直达与右键菜单试点",
  },
  about: {
    label: "关于",
    icon: Info,
    title: "关于",
    hint: "版本、开源地址与更新检查",
  },
} satisfies Record<string, SettingsSectionMeta>;

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

/** 分组顺序 = 这里的声明顺序；第一个是进入设置时的默认分组 */
export const SETTINGS_SECTION_ORDER = Object.keys(SETTINGS_SECTIONS) as SettingsSection[];
