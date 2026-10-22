import { Mouse } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { useThemeStore } from "@/stores/themeStore";
import { useEffect } from "react";

/**
 * 系统集成：Windows 快捷入口与右键菜单试点（决策 12）
 *
 * 系统级调参不做进应用，给直达门；右键菜单是试点，开关在用户手里。
 */
export function SystemSection() {
  const zipMenu = useThemeStore((s) => s.zipMenu);
  const zipMenuError = useThemeStore((s) => s.zipMenuError);
  const loadZipMenuStatus = useThemeStore((s) => s.loadZipMenuStatus);
  const toggleZipMenu = useThemeStore((s) => s.toggleZipMenu);
  const openMousePanel = useThemeStore((s) => s.openMousePanel);

  useEffect(() => {
    loadZipMenuStatus();
  }, [loadZipMenuStatus]);

  return (
    <div>
      <SettingsGroup>
        <SettingCard
          title="快捷入口"
          description="指针方案、双击、滚轮速度都在 Windows 的鼠标属性面板里，这里直达（当前定位在「指针」选项卡）"
          action={
            <Button size="sm" variant="outline" onClick={openMousePanel}>
              <Mouse data-icon="inline-start" />
              鼠标属性面板
            </Button>
          }
        />

        <SettingCard
          title="右键菜单导入"
          description="第一步点右侧按钮注册；之后在任意 .zip 文件上点右键，菜单里选「用鼠标主题工具导入」，应用会自动导入这份主题包"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={toggleZipMenu}
              disabled={!zipMenu}
            >
              {zipMenu?.registered ? "移除注册" : "注册到右键菜单"}
            </Button>
          }
        >
          <p data-zip-menu-status className="mt-3 break-all text-2xs text-muted-foreground">
            {zipMenuError
              ? "状态读取失败：应用可能是旧版本，重启应用后重试"
              : zipMenu
                ? zipMenu.registered
                  ? `已注册 · 命令指向 ${zipMenu.exe_path}`
                  : "尚未注册，注册后 .zip 右键菜单才会出现导入项"
                : "读取中…"}
          </p>
          <p className="mt-1 text-2xs text-muted-foreground">
            试点功能（先看效果再定去留）：注册的是当前程序位置，移动安装目录后需重新注册
          </p>
        </SettingCard>
      </SettingsGroup>
    </div>
  );
}
