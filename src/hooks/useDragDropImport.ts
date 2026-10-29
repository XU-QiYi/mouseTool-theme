import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { toast } from "@/lib/toast";
import { inTauri } from "@/services/theme";
import { useImportStore } from "@/stores/importStore";
import { useThemeStore } from "@/stores/themeStore";

/** 拖入内容的最小描述：Tauri 给完整路径，浏览器给文件名 */
interface DropItem {
  /** 展示与校验用：文件名（含扩展名） */
  name: string;
  /** 传给导入链路：Tauri 是完整路径，浏览器 mock 里就是文件名 */
  path: string;
}

const IMPORTABLE_EXT = /\.(zip|theme)$/i;

/** 一次拖入能进队列的上限：防误拖整个下载目录把界面塞爆 */
const MAX_DROP_ITEMS = 20;

/** 从完整路径取文件名（正反斜杠都兼容） */
function fileNameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * 校验拖入内容：返回错误文案，null = 放行
 *
 * 文件夹导入（决策 16）后，完整路径不再按扩展名拦：文件夹名可能带点
 * （「我的主题.v2」），前端也判不了路径是不是目录——zip / .theme 方案 /
 * 文件夹 / 其它文件交给后端 `import_theme` 权威校验，各自给出精准文案。
 * 只有浏览器通路（拿到的只有文件名、没有路径）维持白名单：.zip 与 .theme。
 * 多项（2–20 个）放行进导入中心；单项保持原导入链路。
 */
export function validateDrop(items: DropItem[]): string | null {
  if (items.length === 0) return null;
  if (items.length > MAX_DROP_ITEMS) {
    return `一次最多导入 ${MAX_DROP_ITEMS} 个主题包`;
  }
  for (const item of items) {
    const isFullPath = /[\\/]/.test(item.path);
    if (!isFullPath && !IMPORTABLE_EXT.test(item.name)) {
      return "只支持 .zip 主题包或 .theme 光标方案";
    }
  }
  return null;
}

/**
 * 全窗口拖拽导入（.zip 主题包或主题文件夹）
 *
 * 三条通路收敛到同一套校验：
 * - Tauri：`dragDropEnabled` 接管原生拖放后，WebView2 的 HTML5 drag 事件不会触发，
 *   必须监听 Tauri 的 drag-drop 事件——负载直接给文件路径，正是 `import_theme` 的入参；
 * - 浏览器（开发与自动化验收）：HTML5 dragenter/dragover/drop，从 dataTransfer.files 取文件名。
 * - 拖入 1 项走原单文件链路（toast / 侧栏进度）；拖入 2–20 项全部进导入中心
 *   队列，由用户点「开始导入」串行执行（批量导入中心见 importStore）。
 *
 * 拖放是全局动作：侧栏「导入主题」在三页都有入口，拖放不该比它受限。
 */
export function useDragDropImport() {
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    /** 监听只挂一次，store 状态在回调里现取：不订阅、不进依赖数组 */
    const drop = (items: DropItem[]) => {
      if (items.length === 0) {
        // 文本、网页元素这类非文件拖入没有可处理的内容：弹「导入失败」反而是打扰
        return;
      }
      const error = validateDrop(items);
      if (error) {
        toast.error("导入失败", error);
        return;
      }
      // 批量队列在跑时不再接新拖入：后端互斥锁会拒绝并发，先说清原因
      const importCenter = useImportStore.getState();
      if (importCenter.running) {
        toast.warning("正在批量导入，请稍候", "等队列跑完再拖入新的主题");
        return;
      }
      const { importing, importTheme } = useThemeStore.getState();
      if (importing) {
        toast.warning("正在导入，请稍候", "上一次导入还没完成");
        return;
      }
      if (items.length === 1) {
        void importTheme(items[0].path);
        return;
      }
      importCenter.enqueue(items.map((item) => item.path));
      toast.info(
        `已加入导入队列（${items.length} 个）`,
        "在导入中心点「开始导入」后会逐个执行",
      );
    };

    if (inTauri) {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "enter") {
            setDragActive(true);
          } else if (event.payload.type === "leave") {
            setDragActive(false);
          } else if (event.payload.type === "drop") {
            setDragActive(false);
            drop(event.payload.paths.map((path) => ({ name: fileNameOf(path), path })));
          }
          // over 逐帧触发但不携带新信息：enter 已把遮罩点亮，无需跟手
        })
        .then((fn) => {
          // 组件先于 promise 卸载时补一次反注册，避免监听泄漏
          if (disposed) fn();
          else unlisten = fn;
        });
      return () => {
        disposed = true;
        unlisten?.();
      };
    }

    // 浏览器 mock 通路。窗口内元素间移动也会触发 dragenter/dragleave
    // （relatedTarget 非 null），只在真正进出窗口边界时切换遮罩，否则拖过内容区会闪烁
    const onDragEnter = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      drop(files.map((file) => ({ name: file.name, path: file.name })));
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return { dragActive };
}
