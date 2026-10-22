import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { Button } from "@/components/ui/button";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { APP_VERSION, REPO_URL } from "@/lib/app-meta";
import { openExternal } from "@/lib/open-external";

/**
 * 关于：版本、开源地址、更新检查
 *
 * 版本以 `getVersion()`（tauri.conf.json）为准，浏览器开发模式退回常量；
 * 更新检查的版本源是 GitHub Releases（发布指南的唯一发布通道）。
 */
export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);

  // 版本号是静态值，挂载后取一次即可
  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {
        if (alive) setVersion(APP_VERSION);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <SettingsGroup>
        <SettingCard
          title="版本信息"
          description="当前安装的程序版本；报障时请附上这串版本号"
        >
          <p data-app-version className="mt-3 font-mono text-2xs text-muted-foreground select-text">
            鼠标主题工具 v{version ?? "…"}
          </p>
        </SettingCard>

        <SettingCard
          title="开源地址"
          description="源码、问题反馈与发布都在这里"
          action={
            <Button size="sm" variant="outline" onClick={() => void openExternal(REPO_URL)}>
              打开仓库
            </Button>
          }
        >
          <p className="mt-3 break-all font-mono text-2xs text-muted-foreground select-text">
            {REPO_URL}
          </p>
        </SettingCard>
      </SettingsGroup>
    </div>
  );
}
