import type { ComponentType } from "react";

import { AboutSection } from "@/components/settings/AboutSection";
import { DataSection } from "@/components/settings/DataSection";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { ShortcutsSection } from "@/components/settings/ShortcutsSection";
import { SystemSection } from "@/components/settings/SystemSection";
import { ContentFrame, type ContentWidth } from "@/components/layout/ContentFrame";
import type { SettingsSection } from "@/lib/settings-sections";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 分组 → 内容组件
 *
 * `Record<SettingsSection, …>` 逼着每个分组都有内容页：加分组时忘了写
 * 这一行会编译报错，而不是点进去一片空白（与 `App.tsx` 的 `VIEWS` 同规）。
 */
const SECTIONS: Record<SettingsSection, ComponentType> = {
  general: GeneralSection,
  shortcuts: ShortcutsSection,
  data: DataSection,
  system: SystemSection,
  about: AboutSection,
};

/**
 * 分组 → 内容宽度（决策：表单类 640，数据类 768）
 *
 * 与 `SECTIONS` 同构：加分组时这里也必须补一行，宽度不会被"忘了"。
 */
const SECTION_WIDTH: Record<SettingsSection, ContentWidth> = {
  general: "form",
  shortcuts: "form",
  data: "data",
  system: "form",
  about: "form",
};

/**
 * 设置：按侧栏分组切换的管理页
 *
 * 进入「设置」后侧栏切换成分组列表，点哪组这里就换哪组的内容；
 * 页头标题/说明跟着分组走（见 `PageHeader`）。这一页不依赖主题列表——
 * 加载失败时它反而更要可用，「打开数据目录」恰恰是那时的排查入口。
 * `key` + `enter-fade`：分组切换时内容整体淡入（与换页同一套动效口径）。
 */
export function SettingsView() {
  const section = useThemeStore((s) => s.settingsSection);
  const Section = SECTIONS[section];

  return (
    <div
      data-settings-section={section}
      className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5"
    >
      <ContentFrame key={section} width={SECTION_WIDTH[section]} className="enter-fade">
        <Section />
      </ContentFrame>
    </div>
  );
}
