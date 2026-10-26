import type { ElementType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 内容宽度分档：四页各自的阅读宽度上限
 *
 * | width   | 上限  | 用途                                    |
 * |---------|-------|-----------------------------------------|
 * | full    | 无    | 图库网格（卡片自己会按列收缩）          |
 * | wide    | 896   | 我的主题表格                            |
 * | data    | 768   | 最近使用时间轴、设置「数据」            |
 * | form    | 640   | 设置表单类分组                          |
 *
 * 统一保留页面左右 24px（px-6）页边、内容左对齐——上限只是"读到这里为止"，
 * 不是居中卡片；居中会让左缘跟着窗口宽度漂，表格和时间轴没法和页标题对齐。
 */
export type ContentWidth = "full" | "wide" | "data" | "form";

const WIDTH_CLASS: Record<ContentWidth, string> = {
  full: "max-w-none",
  wide: "max-w-4xl",
  data: "max-w-3xl",
  form: "max-w-[40rem]",
};

interface ContentFrameProps {
  width?: ContentWidth;
  /** 语义标签（section / div） */
  as?: ElementType;
  className?: string;
  children: ReactNode;
}

export function ContentFrame({ width = "full", as: Tag = "div", className, children }: ContentFrameProps) {
  return <Tag className={cn(WIDTH_CLASS[width], className)}>{children}</Tag>;
}
