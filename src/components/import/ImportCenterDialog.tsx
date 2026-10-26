import type { ReactNode } from "react";
import { FolderUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { pickAndQueueThemes } from "@/lib/import-zip";
import { cn } from "@/lib/utils";
import { useImportStore, type ImportJob, type ImportJobStatus } from "@/stores/importStore";
import { useThemeStore } from "@/stores/themeStore";

const STATUS_BADGE: Record<ImportJobStatus, ReactNode> = {
  queued: <StatusBadge tone="muted">等待</StatusBadge>,
  importing: (
    <StatusBadge tone="neutral" dot>
      导入中
    </StatusBadge>
  ),
  success: (
    <StatusBadge tone="success" dot>
      成功
    </StatusBadge>
  ),
  failed: (
    <StatusBadge tone="warning" dot>
      失败
    </StatusBadge>
  ),
};

const KIND_LABEL: Record<ImportJob["kind"], string> = {
  zip: "ZIP 包",
  folder: "文件夹",
  file: "文件",
};

/** 确定性进度：total>0 才画百分比条，否则只有阶段文字（禁止转圈动画） */
function JobProgress({ job }: { job: ImportJob }) {
  const percent =
    job.progress && job.progress.total > 0
      ? Math.min(100, Math.round((job.progress.current / job.progress.total) * 100))
      : null;
  return (
    <div className="mt-1.5" aria-hidden>
      {percent !== null ? (
        <div className="h-1 overflow-hidden rounded-full bg-border">
          <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      ) : (
        job.progress && <p className="truncate text-2xs text-muted-foreground">{job.progress.message}</p>
      )}
    </div>
  );
}

/**
 * 导入中心：批量导入的任务层弹窗
 *
 * 队列状态在 `importStore`（串行执行，失败不阻断后续）；这里只做展示与
 * 触发。不展示 `.inf` / 文件名推断来源——后端没返回，前端也不猜。
 */
export function ImportCenterDialog() {
  const jobs = useImportStore((s) => s.jobs);
  const selectedId = useImportStore((s) => s.selectedId);
  const open = useImportStore((s) => s.open);
  const running = useImportStore((s) => s.running);
  const start = useImportStore((s) => s.start);
  const retry = useImportStore((s) => s.retry);
  const removeJob = useImportStore((s) => s.removeJob);
  const clearFinished = useImportStore((s) => s.clearFinished);
  const closeCenter = useImportStore((s) => s.closeCenter);
  const selectJob = useImportStore((s) => s.selectJob);

  const selected = jobs.find((job) => job.id === selectedId) ?? null;
  const counts = jobs.reduce(
    (acc, job) => {
      acc[job.status] += 1;
      return acc;
    },
    { queued: 0, importing: 0, success: 0, failed: 0 } as Record<ImportJobStatus, number>,
  );
  const allDone = !running && jobs.length > 0 && counts.queued === 0 && counts.importing === 0;
  const hasFinished = counts.success + counts.failed > 0;
  const summary = running
    ? `正在导入（${counts.importing} 个进行中，${counts.queued} 个等待）`
    : allDone
      ? counts.failed > 0
        ? `完成：成功 ${counts.success} 个 · 失败 ${counts.failed} 个`
        : `完成：全部成功（${counts.success} 个）`
      : `共 ${jobs.length} 项：${counts.queued} 等待 · ${counts.success} 成功 · ${counts.failed} 失败`;

  const viewMine = () => {
    closeCenter();
    useThemeStore.getState().setCurrentPage("mine");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 运行中拒关的逻辑在 closeCenter 里（toast 说明原因），这里只透传意图
        if (!next) closeCenter();
      }}
    >
      {open && (
        <DialogContent data-import-center className="flex max-h-[70vh] w-[44rem] max-w-3xl flex-col">
          <div className="min-w-0">
            <DialogTitle>导入中心</DialogTitle>
            <DialogDescription>逐个导入，一次只处理一个；失败可单独重试</DialogDescription>
          </div>

          {/* 顶部：队列计数 + 动作 */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground tabular-nums">
              队列 {jobs.length} 项 · 成功 {counts.success} · 失败 {counts.failed}
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void pickAndQueueThemes()}>
                <FolderUp data-icon="inline-start" />
                添加更多
              </Button>
              <Button
                size="sm"
                onClick={() => void start()}
                disabled={running || counts.queued === 0}
              >
                {running ? "导入中…" : "开始导入"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={clearFinished}
                disabled={running || !hasFinished}
              >
                清除已完成
              </Button>
            </div>
          </div>

          {/* 主体两栏：左任务列表，右详情 */}
          <div className="mt-4 flex min-h-0 flex-1 gap-4">
            <div className="scroll-thin w-72 shrink-0 overflow-y-auto pr-1">
              {jobs.length === 0 ? (
                <div className="rounded-lg bg-muted/50 p-4 text-center">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    一次拖入多个 ZIP 或文件夹，或点上方「批量导入 / 添加更多」
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    className="mt-2"
                    onClick={() => void pickAndQueueThemes()}
                  >
                    添加更多
                  </Button>
                </div>
              ) : (
                <ul className="space-y-1">
                  {jobs.map((job) => (
                    <li key={job.id}>
                      <button
                        type="button"
                        data-import-job={job.id}
                        data-import-status={job.status}
                        onClick={() => selectJob(job.id)}
                        aria-pressed={job.id === selectedId}
                        className={cn(
                          "focus-ring w-full rounded-lg px-2.5 py-2 text-left transition-[background-color] duration-(--motion-fast) ease-standard",
                          job.id === selectedId ? "bg-accent" : "hover:bg-muted/50",
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium" title={job.name}>
                              {job.name}
                            </span>
                            <span className="block text-2xs text-muted-foreground">
                              {KIND_LABEL[job.kind]}
                            </span>
                          </span>
                          {STATUS_BADGE[job.status]}
                        </span>
                        {job.status === "importing" && job.progress && (
                          <span aria-busy="true">
                            <JobProgress job={job} />
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="scroll-thin min-w-0 flex-1 overflow-y-auto pl-1">
              {!selected ? (
                <p className="pt-8 text-center text-xs text-muted-foreground">
                  {jobs.length === 0 ? "队列为空" : "在左侧选择一个任务查看详情"}
                </p>
              ) : (
                <div>
                  <p className="text-sm font-medium">{selected.name}</p>
                  <p className="mt-1 break-all font-mono text-2xs text-muted-foreground select-text">
                    {selected.path}
                  </p>

                  <div className="mt-3 flex items-center gap-2">
                    {STATUS_BADGE[selected.status]}
                    <span className="text-2xs text-muted-foreground">{KIND_LABEL[selected.kind]}</span>
                  </div>

                  {selected.status === "success" && (
                    <dl className="mt-3 space-y-1 text-xs">
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-muted-foreground">主题名</dt>
                        <dd className="min-w-0 break-all">{selected.themeName}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-muted-foreground">槽位</dt>
                        <dd className="tabular-nums">
                          {selected.slotCount} 个
                          {selected.animatedCount ? `（含动态 ${selected.animatedCount} 个）` : ""}
                        </dd>
                      </div>
                    </dl>
                  )}

                  {selected.error && (
                    <div className="mt-3">
                      <p className="text-2xs font-medium text-muted-foreground">失败原因</p>
                      <p className="mt-1 text-xs leading-relaxed text-destructive">{selected.error}</p>
                    </div>
                  )}

                  {selected.warnings.length > 0 && (
                    <div className="mt-3">
                      <p className="text-2xs font-medium text-muted-foreground">提示</p>
                      <ul className="mt-1 space-y-1">
                        {selected.warnings.map((warning, index) => (
                          <li key={index} className="break-all text-2xs leading-relaxed text-muted-foreground">
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="mt-4 flex items-center gap-2">
                    {selected.status === "failed" && (
                      <Button size="sm" variant="outline" onClick={() => void retry(selected.id)} disabled={running}>
                        重试此项
                      </Button>
                    )}
                    {(selected.status === "queued" || selected.status === "failed") && !running && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeJob(selected.id)}
                        className="text-muted-foreground"
                      >
                        从队列移除
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 页脚：汇总 + 动作 */}
          <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-2xs text-muted-foreground">{summary}</p>
            <div className="flex items-center gap-2">
              {allDone && counts.success > 0 && (
                <Button size="sm" variant="outline" onClick={viewMine}>
                  查看我的主题
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={closeCenter} disabled={running}>
                关闭
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
