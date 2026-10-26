import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { APP_VERSION } from "@/lib/app-meta";

/**
 * 应用版本号：`getVersion()`（tauri.conf.json）为准，浏览器开发模式退回常量
 *
 * 侧栏品牌位与「设置 → 关于」共用；`data-app-version` 钩子挂在 AboutSection，
 * 这里只返回字符串。版本是静态值，挂载后取一次即可。
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState<string>(APP_VERSION);

  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {
        /* 浏览器环境拿不到，保持 APP_VERSION 兜底 */
      });
    return () => {
      alive = false;
    };
  }, []);

  return version;
}
