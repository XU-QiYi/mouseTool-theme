import { useEffect, useRef } from "react";

interface AniPlayerProps {
  /** 各帧 PNG 的 base64 列表 */
  frames: string[];
  /** 帧间隔（毫秒） */
  rateMs: number;
}

/** 用 canvas 逐帧播放动态光标 */
export function AniPlayer({ frames, rateMs }: AniPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // frames 数组每次渲染都是新引用，用内容长度 + 首帧做稳定标识避免重复播放
  const key = `${frames.length}:${frames[0]?.slice(0, 32) ?? ""}`;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let index = 0;
    let images: HTMLImageElement[] = [];

    const decode = (b64: string) =>
      new Promise<HTMLImageElement | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = `data:image/png;base64,${b64}`;
      });

    Promise.all(frames.map(decode))
      .then((loaded) => {
        if (cancelled) return;
        images = loaded.filter((img): img is HTMLImageElement => img !== null);
        const canvas = canvasRef.current;
        if (images.length === 0 || !canvas) return;

        canvas.width = Math.max(...images.map((i) => i.naturalWidth));
        canvas.height = Math.max(...images.map((i) => i.naturalHeight));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const step = () => {
          if (cancelled) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(images[index % images.length], 0, 0);
          index += 1;
          timer = window.setTimeout(step, Math.max(rateMs, 16));
        };
        step();
      })
      .catch(() => {
        /* 解码失败时保持空白，外层会显示占位 */
      });

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      images = [];
    };
  }, [key, frames, rateMs]);

  return <canvas ref={canvasRef} className="max-h-12 max-w-12 object-contain" aria-hidden />;
}
