import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CursorPreviewImage } from "@/components/cursor/CursorPreviewImage";
import { useCursorPreview } from "@/hooks/useCursorPreview";
import type { CursorSlot } from "@/types/theme";

export function CursorSlotCard({ slot }: { slot: CursorSlot }) {
  const preview = useCursorPreview(slot.file_path);
  const isAnimated = preview ? preview.is_animated : slot.file_type === "ani";

  return (
    <Card className="py-0">
      <CardContent className="flex flex-col items-center gap-1.5 px-3 py-3">
        <div className="relative flex h-12 w-12 items-center justify-center">
          <CursorPreviewImage slot={slot} />
          {isAnimated && (
            <Badge
              variant="secondary"
              className="absolute -right-3 -bottom-1 h-4 px-1 text-3xs font-normal"
            >
              ANI
            </Badge>
          )}
        </div>
        <span className="text-xs font-medium">{slot.display_name}</span>
        <span className="text-2xs text-muted-foreground">{slot.english_name}</span>
      </CardContent>
    </Card>
  );
}
