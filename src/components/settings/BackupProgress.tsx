import type { TaskProgress } from "@/services/theme";

function progressPercent(progress: TaskProgress): number {
  if (progress.stage === "done") return 100;
  if (progress.total <= 0) return 0;
  return Math.min(100, Math.round((progress.current / progress.total) * 100));
}

/**
 * 备份 / 恢复的确定性进度条
 *
 * 「数据」主视图与「备份历史」子页共用一份：进度来自 `backup-progress`
 * 事件（百分比读数），不是动画。没有进行中的任务时整块不渲染。
 */
export function BackupProgress({ progress, stage }: { progress: TaskProgress; stage?: string }) {
  const percent = progressPercent(progress);
  return (
    <div data-backup-progress={stage ?? progress.stage} aria-live="polite" className="mt-3">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{progress.message}</span>
        <span className="font-mono text-2xs text-muted-foreground">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="备份进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border"
      >
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
