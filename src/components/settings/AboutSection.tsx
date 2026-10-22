import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { Button } from "@/components/ui/button";
import { SettingCard, SettingsGroup } from "@/components/settings/SettingCard";
import { APP_VERSION, REPO_URL } from "@/lib/app-meta";
import { openExternal } from "@/lib/open-external";
import { checkForUpdates, type UpdateCheckResult } from "@/lib/update-check";
import { toast } from "@/lib/toast";

/**
 * 关于：版本、开源地址、更新检查
 *
 * 版本以 `getVersion()`（tauri.conf.json）为准，浏览器开发模式退回常量；
 * 更新检查的版本源是 GitHub Releases（发布指南的唯一发布通道）。
 */
export function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

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

  const onCheckUpdate = async () => {
    setChecking(true);
    try {
      const outcome = await checkForUpdates();
      setResult(outcome);
      if (outcome.status === "error") {
        toast.error("检查更新失败", outcome.message);
      }
    } finally {
      setChecking(false);
    }
  };

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

        <SettingCard
          title="检查更新"
          description="对照 GitHub Releases 的最新版本；「通用」里可以开启启动时自动检查"
          action={
            <Button size="sm" onClick={() => void onCheckUpdate()} disabled={checking}>
              {checking ? "检查中…" : "检查更新"}
            </Button>
          }
        >
          <p
            data-update-status
            className="mt-3 break-all text-2xs text-muted-foreground"
          >
            {result ? result.message : "还没检查过；有新版本会在启动时提示（需在「通用」里开启）"}
          </p>
          {result?.status === "update-available" && (
            <Button
              size="xs"
              variant="ghost"
              className="mt-2 px-0 text-info"
              onClick={() => void openExternal(result.releaseUrl)}
            >
              前往下载
            </Button>
          )}
        </SettingCard>
      </SettingsGroup>
    </div>
  );
}
