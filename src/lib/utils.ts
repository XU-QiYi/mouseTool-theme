import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 字节数 → 中文可读体积（备份大小、总占用这类静态读数，保留一位小数就够） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 主题名 → 可保存的文件名
 *
 * 主题名允许中文和空格，但不能原样进默认文件名：Windows 禁止 `\ / : * ? " < > |`
 * 与控制字符，末尾的点/空格会被静默吞掉，`CON` 这类保留名直接保存失败。
 */
export function sanitizeFileName(name: string, fallback = "主题"): string {
  let result = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!result) result = fallback;
  if (WINDOWS_RESERVED.test(result)) result = `${result}_`;
  return result.slice(0, 80);
}
