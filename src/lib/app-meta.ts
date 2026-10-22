/**
 * 应用元信息常量 —— 与发布配置的同步点
 *
 * `APP_VERSION` 只在拿不到 Tauri 版本号时兜底（浏览器开发模式），
 * 正式版本以 `getVersion()`（tauri.conf.json / package.json 的 version）为准；
 * 发版改版本号时记得同步这里（发布指南 §1.3 的「版本错位」检查会覆盖）。
 */
export const APP_VERSION = "0.1.0";

/** 开源仓库地址（决策 13 的发布通道，也是「关于」页的反馈入口） */
export const REPO_URL = "https://github.com/XU-QiYi/mouseTool-theme";

/** 检查更新的版本源：GitHub Releases 最新版 */
export const RELEASES_API =
  "https://api.github.com/repos/XU-QiYi/mouseTool-theme/releases/latest";
