import { useEffect, useState } from "react";

import { getCursorPreview } from "@/services/theme";
import type { CursorPreview } from "@/types/cursor";

/** 已完成解析的结果，避免同一文件重复跨 IPC 请求 */
const done = new Map<string, CursorPreview | null>();
/** 正在进行的请求，避免并发重复调用 */
const inflight = new Map<string, Promise<CursorPreview | null>>();

function load(filePath: string): Promise<CursorPreview | null> {
  if (done.has(filePath)) return Promise.resolve(done.get(filePath) ?? null);
  const running = inflight.get(filePath);
  if (running) return running;

  const task = getCursorPreview(filePath)
    .then((preview) => {
      done.set(filePath, preview);
      return preview;
    })
    .catch(() => {
      done.set(filePath, null);
      return null;
    })
    .finally(() => inflight.delete(filePath));

  inflight.set(filePath, task);
  return task;
}

/** 取光标预览数据；未加载完成或不可用时返回 null */
export function useCursorPreview(filePath: string): CursorPreview | null {
  const [preview, setPreview] = useState<CursorPreview | null>(
    () => done.get(filePath) ?? null,
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
