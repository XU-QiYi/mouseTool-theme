// 后台启动/停止 dev server。用法：node scripts/dev_bg.mjs start|stop|status
// 为什么不用 `npm run dev | head`：管道一关 vite 写 stdout 就拿 EPIPE 直接死掉
// （页面变成"无法连接"）。这里把 stdout/stderr 接到日志文件，进程与管道彻底解耦。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const PID_FILE = join(ROOT, ".dev-server.pid");
const LOG_FILE = join(ROOT, ".dev-server.log");
const PORT = 1420;

const cmd = process.argv[2] ?? "status";

function readPid() {
  try {
    return Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return 0;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function httpUp() {
  return new Promise((resolve) => {
    const req = fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(800) });
    req.then(() => resolve(true)).catch(() => resolve(false));
  });
}

async function status() {
  const pid = readPid();
  const up = await httpUp();
  if (up) {
    console.log(`dev server 运行中 http://localhost:${PORT} (pid=${pid || "?"})`);
  } else {
    console.log("dev server 未运行");
    if (alive(pid)) console.log(`注意：pid ${pid} 存活但端口未响应，可执行 stop 清理`);
  }
  return up ? 0 : 1;
}

async function start() {
  if (await httpUp()) {
    console.log(`已在运行 http://localhost:${PORT}`);
    return 0;
  }
  const stale = readPid();
  if (alive(stale)) {
    console.log(`pid ${stale} 残留，先 stop`);
    return 1;
  }
  mkdirSync(ROOT, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(
    process.execPath,
    [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(PORT)],
    {
      cwd: ROOT,
      detached: true, // 独立进程组，不随本脚本退出而死
      stdio: ["ignore", logFd, logFd], // 关键：接文件，不接管道
      windowsHide: true,
    },
  );
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  // 轮询就绪，最多 20s
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await httpUp()) {
      console.log(`已启动 http://localhost:${PORT} (pid=${child.pid}) 日志: ${LOG_FILE}`);
      return 0;
    }
    if (!alive(child.pid)) {
      console.error(`vite 启动即退出，日志尾部：`);
      try {
        const tail = readFileSync(LOG_FILE, "utf8").split("\n").slice(-15).join("\n");
        console.error(tail);
      } catch {}
      rmSync(PID_FILE, { force: true });
      return 1;
    }
  }
  console.log(`已启动但 20s 内未响应，查看 ${LOG_FILE}`);
  return 0;
}

function stop() {
  const pid = readPid();
  if (!alive(pid)) {
    rmSync(PID_FILE, { force: true });
    console.log("未在运行");
    return 0;
  }
  try {
    // Windows：杀整棵进程树（vite 还有 esbuild 子进程）
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid);
    }
    console.log(`已停止 pid=${pid}`);
  } catch (e) {
    console.error(`停止失败: ${e.message}`);
    return 1;
  }
  rmSync(PID_FILE, { force: true });
  return 0;
}

const handlers = { start, stop, status };
const fn = handlers[cmd];
if (!fn) {
  console.error(`未知命令 ${cmd}，用法: node scripts/dev_bg.mjs start|stop|status`);
  process.exit(2);
}
process.exit(await fn());
