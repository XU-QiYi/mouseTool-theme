import { Toast } from "@base-ui/react/toast";

/**
 * 全局 toast 管理器。
 *
 * 独立于 React 组件树创建，因此 store、service 这类非组件代码也能直接调用，
 * 不需要把 toast 函数层层透传。
 */
export const toastManager = Toast.createToastManager();

export type ToastKind = "success" | "error" | "info" | "warning";

/** 错误停留更久：用户往往需要读完才知道怎么处理 */
const TIMEOUT: Record<ToastKind, number> = {
  success: 3200,
  info: 4000,
  warning: 5000,
  error: 6000,
};

function show(kind: ToastKind, title: string, description?: string) {
  return toastManager.add({
    type: kind,
    title,
    description,
    timeout: TIMEOUT[kind],
    priority: kind === "error" ? "high" : "low",
  });
}

/** 把任意异常转成可读中文，避免把 Rust 的 Debug 串直接甩给用户 */
export function readableError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "未知错误";
}

export const toast = {
  success: (title: string, description?: string) => show("success", title, description),
  error: (title: string, description?: string) => show("error", title, description),
  warning: (title: string, description?: string) => show("warning", title, description),
  info: (title: string, description?: string) => show("info", title, description),
  close: (id?: string) => toastManager.close(id),
};

// 仅开发环境：方便在控制台或自动化脚本里直接验证三种提示的排版
if (import.meta.env.DEV) {
  (globalThis as unknown as { __toast?: typeof toast }).__toast = toast;
}
