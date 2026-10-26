import { create } from "zustand";

import { readableError, toast } from "@/lib/toast";
import { importTheme as apiImportTheme, type TaskProgress } from "@/services/theme";
import { useThemeStore } from "@/stores/themeStore";

export type ImportJobStatus = "queued" | "importing" | "success" | "failed";
export type ImportJobKind = "zip" | "folder" | "file";

/** 一次批量导入中的一个任务：一个来源路径 = 一条 */
export interface ImportJob {
  id: string;
  path: string;
  name: string;
  kind: ImportJobKind;
  status: ImportJobStatus;
  /** 进行中的阶段进度；queued / 结束态为 null */
  progress: TaskProgress | null;
  themeId?: string;
  themeName?: string;
  slotCount?: number;
  animatedCount?: number;
  warnings: string[];
  error?: string;
}

/** 从路径猜来源类型：有 .zip 后缀是包，带分隔符的是文件夹，其余当单文件 */
function kindOf(path: string): ImportJobKind {
  if (/\.zip$/i.test(path)) return "zip";
  if (/[\\/]/.test(path)) return "folder";
  return "file";
}

function nameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

interface ImportStore {
  /** 队列（含已完成的，直到用户清除）；顺序 = 执行顺序 */
  jobs: ImportJob[];
  /** 详情面板当前展示的任务 */
  selectedId: string | null;
  /** 导入中心弹窗是否打开 */
  open: boolean;
  /** 队列是否在跑（串行执行中） */
  running: boolean;

  /** 追加任务并打开导入中心；同一路径的未完成任务不重复入队 */
  enqueue: (paths: string[]) => void;
  /** 串行执行所有 queued 任务；已在跑或单文件导入进行中时提示并返回 */
  start: () => Promise<void>;
  /** 失败项放回队列；空闲时自动开跑 */
  retry: (id: string) => Promise<void>;
  /** 移除一条未在执行的任务 */
  removeJob: (id: string) => void;
  /** 清除全部 success / failed（running 时不允许） */
  clearFinished: () => void;
  /** 关闭导入中心；running 时拒绝 */
  closeCenter: () => void;
  /** 详情面板切换任务 */
  selectJob: (id: string) => void;
}

/**
 * 批量导入中心：多个来源逐个导入的任务层状态
 *
 * - **串行执行**：后端 `import_theme` 有互斥锁（`ops::try_begin`），并发只会
 *   全部失败；一个失败不阻断后续任务。
 * - 直接调 `services/theme.ts` 的 `importTheme`，**不复用** `themeStore.importTheme`
 *   的 toast / 选中逻辑——批量场景下每条都弹 toast 会刷屏，汇总提示在队列
 *   全部结束时给一次。
 * - 队列跑完后 `loadThemes()` 一次刷新列表，并选中最后成功的主题让检查器跟上。
 */
export const useImportStore = create<ImportStore>((set, get) => ({
  jobs: [],
  selectedId: null,
  open: false,
  running: false,

  enqueue: (paths) => {
    if (paths.length === 0) return;
    set((state) => {
      // 同一路径的未完成任务不重复入队：再拖一次同一个包应该提示而不是排两条
      const pending = new Set(
        state.jobs
          .filter((job) => job.status === "queued" || job.status === "importing")
          .map((job) => job.path),
      );
      const fresh = paths
        .filter((path) => !pending.has(path))
        .map((path) => ({
          id: crypto.randomUUID(),
          path,
          name: nameOf(path),
          kind: kindOf(path),
          status: "queued" as const,
          progress: null,
          warnings: [],
        }));
      if (fresh.length === 0) return state;
      return {
        jobs: [...state.jobs, ...fresh],
        selectedId: fresh[0]?.id ?? state.selectedId,
        open: true,
      };
    });
  },

  start: async () => {
    if (get().running) return;
    // 单文件导入（侧栏 / Ctrl+O / 拖单个）与批量共用后端互斥锁，
    // 两条链路互相看得见才能给出准确的"请稍候"
    if (useThemeStore.getState().importing) {
      toast.warning("正在导入，请稍候", "上一次导入还没完成");
      return;
    }

    set({ running: true });
    let lastSuccessId: string | null = null;
    let successCount = 0;
    let failCount = 0;

    try {
      // 逐条取下一个 queued：retry / remove 会改队列，不能一次圈定范围
      for (;;) {
        const job = get().jobs.find((item) => item.status === "queued");
        if (!job) break;

        set((state) => ({
          jobs: state.jobs.map((item) =>
            item.id === job.id
              ? { ...item, status: "importing", progress: null, error: undefined }
              : item,
          ),
          selectedId: job.id,
        }));

        try {
          const { theme, warnings } = await apiImportTheme(job.path, (progress) => {
            set((state) => ({
              jobs: state.jobs.map((item) =>
                item.id === job.id ? { ...item, progress } : item,
              ),
            }));
          });
          successCount += 1;
          lastSuccessId = theme.id;
          set((state) => ({
            jobs: state.jobs.map((item) =>
              item.id === job.id
                ? {
                    ...item,
                    status: "success",
                    progress: null,
                    themeId: theme.id,
                    themeName: theme.name,
                    slotCount: theme.cursors.length,
                    animatedCount: theme.cursors.filter((slot) => slot.file_type === "ani").length,
                    warnings,
                  }
                : item,
            ),
          }));
        } catch (err) {
          failCount += 1;
          const message = readableError(err);
          console.error(`批量导入「${job.name}」失败：`, message);
          set((state) => ({
            jobs: state.jobs.map((item) =>
              item.id === job.id
                ? { ...item, status: "failed", progress: null, error: message }
                : item,
            ),
          }));
        }
      }
    } finally {
      set({ running: false });
    }

    // 队列全部结束：刷新一次列表 + 选中最新的成功项 + 汇总提示
    await useThemeStore.getState().loadThemes();
    if (lastSuccessId) {
      useThemeStore.getState().selectTheme(lastSuccessId);
    }
    if (successCount > 0 && failCount > 0) {
      toast.warning(
        `批量导入完成：成功 ${successCount} 个、失败 ${failCount} 个`,
        "失败项可在导入中心单独重试",
      );
    } else if (successCount > 0) {
      toast.success(`批量导入完成：成功 ${successCount} 个主题`);
    } else if (failCount > 0) {
      toast.error(`批量导入完成：全部失败（${failCount} 个）`, "点击失败项查看原因");
    }
  },

  retry: async (id) => {
    if (get().running) return;
    const job = get().jobs.find((item) => item.id === id);
    if (!job || job.status !== "failed") return;
    set((state) => ({
      jobs: state.jobs.map((item) =>
        item.id === id ? { ...item, status: "queued", error: undefined } : item,
      ),
      selectedId: id,
    }));
    await get().start();
  },

  removeJob: (id) => {
    const job = get().jobs.find((item) => item.id === id);
    if (!job || job.status === "importing") return;
    set((state) => ({
      jobs: state.jobs.filter((item) => item.id !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
    }));
  },

  clearFinished: () => {
    if (get().running) return;
    set((state) => {
      const kept = state.jobs.filter(
        (item) => item.status === "queued" || item.status === "importing",
      );
      return {
        jobs: kept,
        selectedId: kept.some((item) => item.id === state.selectedId)
          ? state.selectedId
          : null,
      };
    });
  },

  closeCenter: () => {
    // 运行中拒绝关闭：批量任务不能取消（后端没有取消通道），
    // 关掉界面会让人以为"没在导入了"
    if (get().running) {
      toast.warning("正在批量导入，请稍候", "任务完成后即可关闭");
      return;
    }
    set({ open: false });
  },

  selectJob: (id) => set({ selectedId: id }),
}));

// 开发期挂到 window：验收脚本通过 __importStore.enqueue / start 驱动批量链路
if (import.meta.env.DEV) {
  (globalThis as unknown as { __importStore?: typeof useImportStore }).__importStore =
    useImportStore;
}
