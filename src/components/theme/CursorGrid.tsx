import { CursorSlotCard } from "@/components/cursor/CursorSlotCard";
import type { CursorTheme } from "@/types/theme";

export function CursorGrid({ theme }: { theme: CursorTheme }) {
  return (
    <div className="grid grid-cols-4 gap-3">
      {theme.cursors.map((slot) => (
        <CursorSlotCard key={slot.registry_key} slot={slot} />
      ))}
    </div>
  );
}
