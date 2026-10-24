import { MousePointer2 } from "lucide-react";

import { AniPlayer } from "@/components/cursor/AniPlayer";
import { useCursorPreview } from "@/hooks/useCursorPreview";
import type { CursorSlot } from "@/types/theme";

/** 三档显示尺寸：sm 表格缩略图 / md 槽位卡 / lg 画廊封面 */
export type PreviewSize = "sm" | "md" | "lg";

const PLACEHOLDER: Record<PreviewSize, string> = {
  sm: "size-5",
  md: "size-8",
  lg: "size-10",
};

const IMAGE: Record<PreviewSize, string> = {
  sm: "max-h-6 max-w-6",
  md: "max-h-12 max-w-12",
  lg: "max-h-16 max-w-16",
};

interface CursorPreviewImageProps {
  slot: CursorSlot;
  size?: PreviewSize;
}

/** 光标预览图：动态光标用 canvas 播放，静态光标直接显示图片，取不到时降级为占位图标 */
export function CursorPreviewImage({ slot, size = "md" }: CursorPreviewImageProps) {
  const preview = useCursorPreview(slot.file_path);

  if (!preview?.image) {
    return <MousePointer2 className={`${PLACEHOLDER[size]} text-muted-foreground`} />;
  }

  if (preview.is_animated && preview.frames.length > 1) {
    return (
      <AniPlayer
        frames={preview.frames}
        rateMs={preview.rate_ms}
        className={IMAGE[size]}
      />
    );
  }

  return (
    <img
      src={`data:image/png;base64,${preview.image}`}
      // 预览图是装饰：槽位名 / 主题名就在旁边，读屏再念一遍光标名只是噪音
      alt=""
      className={`${IMAGE[size]} object-contain`}
    />
  );
}
