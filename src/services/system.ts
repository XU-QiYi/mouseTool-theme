import { invoke } from "@tauri-apps/api/core";

import { inTauri } from "@/services/theme";

/** 浏览器演示用的程序路径 */
const MOCK_EXE = "C:\\Users\\demo\\App\\Local\\mousetool-theme.exe";

/** `.zip` 右键菜单注册状态 */
export interface ZipMenuStatus {
  registered: boolean;
  /** 当前程序路径（注册时命令会指向它） */
  exe_path: string;
}

/** Windows 版本描述（诊断信息用）；浏览器里给演示值 */
export function getWindowsVersion(): Promise<string> {
  if (!inTauri) {
    return Promise.resolve("Windows（开发模式）");
  }
  return invoke<string>("get_windows_version");
}

/** 打开经典「鼠标属性」面板（定位在指针选项卡）；浏览器里跳过 */
export function openMousePanel(): Promise<void> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，跳过打开系统面板");
    return Promise.resolve();
  }
  return invoke<void>("open_mouse_panel");
}

/** 读取 `.zip` 右键菜单注册状态 */
export function getZipMenuStatus(): Promise<ZipMenuStatus> {
  if (!inTauri) {
    return Promise.resolve({ registered: false, exe_path: MOCK_EXE });
  }
  return invoke<ZipMenuStatus>("get_zip_menu_registered");
}

/** 注册 / 移除 `.zip` 右键菜单（试点功能） */
export function setZipMenu(register: boolean): Promise<void> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，跳过注册表写入");
    return Promise.resolve();
  }
  return invoke<void>("set_zip_menu", { register });
}

/** 领取待导入的 zip 路径（右键菜单 / 二次启动转交），领取即消费 */
export function takePendingImport(): Promise<string | null> {
  if (!inTauri) {
    return Promise.resolve(null);
  }
  return invoke<string | null>("take_pending_import");
}

/** 打开数据根下的日志目录（决策 46）；浏览器里给演示路径 */
export function openLogDir(): Promise<string> {
  if (!inTauri) {
    console.warn("[dev] 非 Tauri 环境，模拟打开日志目录");
    return Promise.resolve("C:\\Users\\demo\\AppData\\Local\\CursorStudio\\logs");
  }
  return invoke<string>("open_log_dir");
}
