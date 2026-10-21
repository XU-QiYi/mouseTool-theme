import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import os from "os";
import path from "path";

// SIGPIPE 守护：输出管道被提前关闭（如误用 `npm run dev | head`）后，
// 写 stdout/stderr 触发 EPIPE，默认行为是整个进程退出。吞掉该错误让 dev server 继续服务。
// @ts-expect-error process is a nodejs global
const nodeProcess = process;
nodeProcess.stdout.on("error", () => {});
nodeProcess.stderr.on("error", () => {});

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  // 依赖缓存放 OS 临时目录：safe-delete 护栏对「项目内批量删除 >50 个文件」fail-closed
  // （vite 重优化会整目录 rm 旧 deps，74 个文件直接把进程炸掉）。临时目录是护栏自己的
  // 豁免区（与 npm 缓存暂存同等待遇，视为可再生缓存），删除走原生 rm，不进回收站。
  cacheDir: path.join(os.tmpdir(), "mousetool-theme-vite-cache"),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
