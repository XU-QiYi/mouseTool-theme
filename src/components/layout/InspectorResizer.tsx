import { useRef } from "react";

import { INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN } from "@/hooks/useInspectorWidth";

interface InspectorResizerProps {
  width: number;
  onChange: (width: number) => void;
}

/** 键盘一次挪多少：两档字号的宽度，够微调又不至于看不出变化 */
const KEY_STEP = 16;

/**
 * 检查器与正文之间的分隔条：拖动改宽度
 *
 * 三条容易漏的：
 * 1. 拖动要用 `setPointerCapture` —— 指针滑出 6px 的分隔条后事件还得继续来；
 * 2. 必须支持键盘（`role="separator"` + 左右键），否则纯键盘用户只能接受默认宽度；
 * 3. 双击复位。把面板拖窄之后没有"恢复默认"的入口，用户只能靠拖回去猜原值。
 */
export function InspectorResizer({ width, onChange }: InspectorResizerProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整详情面板宽度"
      aria-valuenow={width}
      aria-valuemin={INSPECTOR_MIN}
      aria-valuemax={INSPECTOR_MAX}
      title="拖动调整宽度，双击复位"
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        // 往左拖 = 面板变宽，所以是 startX - clientX
        onChange(drag.current.startWidth + (drag.current.startX - e.clientX));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onChange(INSPECTOR_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onChange(width + KEY_STEP);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onChange(width - KEY_STEP);
        } else if (e.key === "Home") {
          e.preventDefault();
          onChange(INSPECTOR_MIN);
        } else if (e.key === "End") {
          e.preventDefault();
          onChange(INSPECTOR_MAX);
        }
      }}
      className="group focus-ring relative w-1.5 shrink-0 cursor-col-resize touch-none select-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-[background-color,width] duration-(--motion-fast) ease-standard group-hover:w-0.5 group-hover:bg-primary/50 group-active:w-0.5 group-active:bg-primary group-focus-visible:w-0.5 group-focus-visible:bg-primary"
      />
    </div>
  );
}
