import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

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
