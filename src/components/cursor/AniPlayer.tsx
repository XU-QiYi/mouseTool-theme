import { useEffect, useRef } from "react";

interface AniPlayerProps {
  /** 各帧 PNG 的 base64 列表 */
  frames: string[];
  /** 帧间隔（毫秒） */
  rateMs: number;
  /** 画布尺寸上限，由外层按场景传入（默认槽位卡的 48px） */
  className?: string;
}

/**
 * 用 canvas 逐帧播放动态光标
 *
 * 只在**看得见**的时候跑：一个 15 槽位主题在检查器里会同时挂十几块画布，
 * 每块都是一条 setTimeout 链；滚出视野之后还照跑，纯属白烧 CPU。
 * 停表时保留最后一帧，所以视觉上没有任何变化。
 */
export function AniPlayer({ frames, rateMs, className = "max-h-12 max-w-12" }: AniPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // frames 数组每次渲染都是新引用，用内容长度 + 首帧做稳定标识避免重复播放
  const key = `${frames.length}:${frames[0]?.slice(0, 32) ?? ""}`;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let index = 0;
    let images: HTMLImageElement[] = [];
    /** 画布是否在视口内 */
    let intersecting = true;
    /** 当前是否停表（离屏或窗口不可见） */
    let blocked = false;

    const canvas = canvasRef.current;

    const decode = (b64: string) =>
      new Promise<HTMLImageElement | null>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = `data:image/png;base64,${b64}`;
      });

    const step = () => {
      if (cancelled || blocked) return;
      if (!canvas || images.length === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(images[index % images.length], 0, 0);
      index += 1;
      timer = window.setTimeout(step, Math.max(rateMs, 16));
    };

    const stop = () => {
      if (timer) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    /** 两个停表条件（离屏 / 窗口最小化）合成一个状态，任一条成立就停 */
    const sync = () => {
      const next = document.hidden || !intersecting;
      if (next === blocked) return;
      blocked = next;
      if (blocked) stop();
      else step();
    };

    Promise.all(frames.map(decode))
      .then((loaded) => {
        if (cancelled) return;
        images = loaded.filter((img): img is HTMLImageElement => img !== null);
        if (images.length === 0 || !canvas) return;

        canvas.width = Math.max(...images.map((i) => i.naturalWidth));
        canvas.height = Math.max(...images.map((i) => i.naturalHeight));
        step();
      })
      .catch(() => {
        /* 解码失败时保持空白，外层会显示占位 */
      });

    // 观察挂上就会先回调一次，拿到初始的可见性
    const observer = canvas ? new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      sync();
    }) : null;
    if (canvas && observer) observer.observe(canvas);

    const onVisibilityChange = () => sync();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      stop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      images = [];
    };
  }, [key, frames, rateMs]);

  return <canvas ref={canvasRef} className={`${className} object-contain`} aria-hidden />;
}
