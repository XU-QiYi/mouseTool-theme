import { MousePointer2 } from "lucide-react";

import { AniPlayer } from "@/components/cursor/AniPlayer";
import { useCursorPreview } from "@/hooks/useCursorPreview";
import type { CursorSlot } from "@/types/theme";

/** 光标预览图：动态光标用 canvas 播放，静态光标直接显示图片，取不到时降级为占位图标 */
export function CursorPreviewImage({ slot }: { slot: CursorSlot }) {
  const preview = useCursorPreview(slot.file_path);

  if (!preview?.image) {
    return <MousePointer2 className="size-8 text-muted-foreground" />;
  }

  if (preview.is_animated && preview.frames.length > 1) {
    return <AniPlayer frames={preview.frames} rateMs={preview.rate_ms} />;
  }

  return (
    <img
      src={`data:image/png;base64,${preview.image}`}
      alt={slot.display_name}
      className="max-h-12 max-w-12 object-contain"
    />
  );
}
