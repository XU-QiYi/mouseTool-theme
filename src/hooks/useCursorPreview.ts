import { useEffect, useState } from "react";

import { getCursorPreview } from "@/services/theme";
import { PreviewCache } from "@/lib/preview-cache";
import type { CursorPreview } from "@/types/cursor";

/**
 * 预览缓存的容量上限（条数）。应用常驻托盘、会话可以很长，每条缓存是
 * base64 帧，不设上限会无界增长（决策 45）。
 */
const PREVIEW_CACHE_LIMIT = 200;

/**
 * 已完成解析的**成功**结果。失败不进缓存：文件稍后恢复（回收站恢复、
 * 重新导入、外部修复）后同一请求要能自愈，而不是永远命中一个 null 占位图。
 */
const cache = new PreviewCache<CursorPreview>(PREVIEW_CACHE_LIMIT);
/** 正在进行的请求，避免并发重复调用 */
const inflight = new Map<string, Promise<CursorPreview | null>>();

function load(filePath: string): Promise<CursorPreview | null> {
  const cached = cache.get(filePath);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(filePath);
  if (running) return running;

  const task = getCursorPreview(filePath)
    .then((preview) => {
      if (preview) cache.put(filePath, preview);
      return preview;
    })
    .catch(() => null)
    .finally(() => inflight.delete(filePath));

  inflight.set(filePath, task);
  return task;
}

/** 失效预览缓存：传路径前缀只清命中条目（删除主题 = 清它名下的槽位文件），
 * 不传全清（主题列表重载后旧结果不再可信）。正在进行的请求不受影响。 */
export function invalidateCursorPreviews(prefix?: string): void {
  cache.invalidate(prefix);
}

/** 取光标预览数据；未加载完成或不可用时返回 null */
export function useCursorPreview(filePath: string): CursorPreview | null {
  const [preview, setPreview] = useState<CursorPreview | null>(
    () => cache.get(filePath) ?? null,
  );

  useEffect(() => {
    let alive = true;
    load(filePath).then((p) => {
      if (alive) setPreview(p);
    });
    return () => {
      alive = false;
    };
  }, [filePath]);

  return preview;
}
