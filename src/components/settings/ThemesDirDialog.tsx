import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ThemesDirPhase, ThemesDirProgress } from "@/services/settings";
import { useSettingsStore } from "@/stores/settingsStore";

/** 阶段 → 整体进度（复制占大头，后面几步都是一瞬间的收尾） */
const PHASE_PERCENT: Record<ThemesDirPhase, number> = {
  copy: 0,
  verify: 75,
  switch: 82,
  registry: 88,
  settings: 94,
  cleanup: 98,
  done: 100,
};

function progressPercent(progress: ThemesDirProgress): number {
  if (progress.phase === "copy") {
    const copied =
      progress.total > 0 ? Math.min(1, progress.current / progress.total) : progress.current > 0 ? 0.5 : 0;
    return Math.round(copied * PHASE_PERCENT.verify);
  }
  return PHASE_PERCENT[progress.phase] ?? 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 主题存储目录迁移确认
 *
 * 显示源、目标、主题数量与体积；执行中锁死关闭与重复提交，进度来自
 * `themes-dir-progress` 事件。失败时后端已回滚，这里保留对话框让用户
 * 重试或关掉，而不是把错误甩成一条过几秒就消失的 toast。
 */
export function ThemesDirDialog() {
  const open = useSettingsStore((s) => s.themesDirOpen);
  const target = useSettingsStore((s) => s.themesDirTarget);
  const plan = useSettingsStore((s) => s.themesDirPlan);
  const planLoading = useSettingsStore((s) => s.themesDirPlanLoading);
  const planError = useSettingsStore((s) => s.themesDirPlanError);
  const busy = useSettingsStore((s) => s.themesDirBusy);
  const progress = useSettingsStore((s) => s.themesDirProgress);
  const error = useSettingsStore((s) => s.themesDirError);
  const settings = useSettingsStore((s) => s.settings);
  const close = useSettingsStore((s) => s.closeThemesDirDialog);
  const retryPlan = useSettingsStore((s) => s.retryThemesDirPlan);
  const confirm = useSettingsStore((s) => s.confirmThemesDirChange);

  const isDefault = target === null;
  const source = plan?.source ?? settings?.effective_themes_dir ?? "…";
  const targetPath = plan?.target ?? (isDefault ? "默认主题目录" : target ?? "…");
  const percent = progress ? progressPercent(progress) : 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AlertDialogContent data-themes-dir-dialog className="w-[30rem]">
        <AlertDialogTitle>
          {isDefault ? "恢复默认主题目录？" : "迁移主题存储目录？"}
        </AlertDialogTitle>
        <AlertDialogDescription>
          现有主题会先完整复制到新位置并逐文件校验，通过后才切换；失败会自动回滚，
          原目录保持不变。
        </AlertDialogDescription>

        <div className="mt-4 space-y-3">
          <div>
            <p className="text-2xs text-muted-foreground">从</p>
            <p
              data-migration-source
              className="mt-0.5 break-all font-mono text-2xs text-muted-foreground select-text"
            >
              {source}
            </p>
          </div>
          <div>
            <p className="text-2xs text-muted-foreground">到</p>
            <p
              data-migration-target
              className="mt-0.5 break-all font-mono text-2xs text-foreground select-text"
            >
              {targetPath}
            </p>
          </div>

          {plan && (
            <p data-migration-stats className="text-xs text-muted-foreground">
              {plan.theme_count} 套主题 · {plan.file_count} 个文件 ·{" "}
              {formatBytes(plan.total_bytes)}
            </p>
          )}

          {planLoading && (
            <p data-migration-loading className="text-xs text-muted-foreground">
              正在检查目标目录…
            </p>
          )}

          {plan && plan.warnings.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-muted/50 p-2.5 text-2xs text-muted-foreground">
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          {planError && (
            <p data-migration-error role="alert" className="text-xs text-destructive">
              {planError}
            </p>
          )}

          {busy && progress && (
            <div data-migration-progress={progress.phase}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{progress.message}</span>
                <span className="font-mono text-2xs text-muted-foreground">{percent}%</span>
              </div>
              <div
                role="progressbar"
                aria-label="迁移进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border"
              >
                <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}

          {!busy && error && (
            <p data-migration-error role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          {busy ? (
            <Button variant="outline" disabled>
              迁移中…
            </Button>
          ) : error ? (
            <>
              <Button variant="outline" onClick={close}>
                关闭
              </Button>
              <Button onClick={() => void confirm()}>重试迁移</Button>
            </>
          ) : planError ? (
            <>
              <Button variant="outline" onClick={close}>
                关闭
              </Button>
              <Button variant="outline" onClick={() => void retryPlan()}>
                重新检查
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close} disabled={planLoading}>
                取消
              </Button>
              <Button onClick={() => void confirm()} disabled={!plan || planLoading}>
                {planLoading ? "检查中…" : "开始迁移"}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
