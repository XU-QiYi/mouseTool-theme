/**
 * 应用元信息常量 —— 与发布配置的同步点
 *
 * `APP_VERSION` 只在拿不到 Tauri 版本号时兜底（浏览器开发模式，
 * 也是检查更新失败退回时的比较基准），
 * 正式版本以 `getVersion()`（tauri.conf.json / package.json 的 version）为准；
 * 发版改版本号时记得同步这里（发布指南 §1.2 的「版本号四处一致」清单会覆盖）。
 */
export const APP_VERSION = "0.4.0";

/** 开源仓库地址（决策 13 的发布通道，也是「关于」页的反馈入口） */
export const REPO_URL = "https://github.com/XU-QiYi/mousetool-theme";

/** 检查更新的版本源：GitHub Releases 最新版 */
export const RELEASES_API =
  "https://api.github.com/repos/XU-QiYi/mousetool-theme/releases/latest";
