// 后台启动/停止 dev server。用法：node scripts/dev_bg.mjs start|stop|status
// 为什么不用 `npm run dev | head`：管道一关 vite 写 stdout 就拿 EPIPE 直接死掉
// （页面变成"无法连接"）。这里把 stdout/stderr 接到日志文件，进程与管道彻底解耦。
//
// 2026-10-22 修：以前端口被**残留的旧 vite** 占着时，start 会打印"已在运行"然后成功返回，
// 于是"启动 → 验证 → 停止"三步全绿，实际验的是旧代码（两次误判就是这么来的）。
// 现在 start/stop 都以"端口实际归谁"为准，而不是只认 PID 文件。
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(800) })
      .then(() => resolve(true))
      .catch(() => resolve(false));
  });
}

/** 谁在监听这个端口？拿不到就返回 0 */
function portOwner() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
      const line = out
        .split("\n")
        .find((l) => l.includes(`:${PORT} `) && l.includes("LISTENING"));
      return line ? Number.parseInt(line.trim().split(/\s+/).pop(), 10) || 0 : 0;
    }
    const out = execFileSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf8" });
    return Number.parseInt(out.trim().split("\n")[0] ?? "0", 10) || 0;
  } catch {
    return 0;
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    // Windows 要杀整棵树：vite 还有 esbuild 子进程
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid);
    }
  } catch {
    /* 已经没了就算了 */
  }
}

async function waitPortFree(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await httpUp())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function status() {
  const pid = readPid();
  const up = await httpUp();
  if (up) {
    const owner = portOwner();
    const owned = owner && owner === pid;
    console.log(
      `dev server 运行中 http://localhost:${PORT} (pid=${owner || pid || "?"})` +
        (owned ? "" : "  ⚠ 不是当前 PID 文件记录的进程，可能是残留"),
    );
  } else {
    console.log("dev server 未运行");
    if (alive(pid)) console.log(`注意：pid ${pid} 存活但端口未响应，可执行 stop 清理`);
  }
  return up ? 0 : 1;
}

async function start() {
  const own = readPid();

  if (await httpUp()) {
    const owner = portOwner();
    if (owner && owner === own) {
      console.log(`已在运行 http://localhost:${PORT} (pid=${owner})`);
      return 0;
    }
    // 端口被不是我们这次启动的进程占着：它跑的可能是旧代码，必须清掉重来
    console.log(
      `端口 ${PORT} 被进程 ${owner || "?"} 占用（不是当前 PID 文件里的进程），先终止再启动`,
    );
    killTree(owner);
    if (!(await waitPortFree())) {
      console.error(`端口 ${PORT} 仍被占用，无法启动。请手动检查占用进程。`);
      return 1;
    }
  }

  if (alive(own)) {
    console.log(`pid ${own} 残留，先 stop`);
    return 1;
  }

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
      console.error("vite 启动即退出，日志尾部：");
      try {
        const tail = readFileSync(LOG_FILE, "utf8").split("\n").slice(-15).join("\n");
        console.error(tail);
      } catch {
        /* 日志读不到就只报这一句 */
      }
      rmSync(PID_FILE, { force: true });
      return 1;
    }
  }
  console.log(`已启动但 20s 内未响应，查看 ${LOG_FILE}`);
  return 0;
}

function stop() {
  // 以端口为准：PID 文件丢了也要能把残留的 vite 清掉
  const targets = new Set([readPid(), portOwner()].filter((p) => p && alive(p)));
  if (targets.size === 0) {
    rmSync(PID_FILE, { force: true });
    console.log("未在运行");
    return 0;
  }
  for (const pid of targets) killTree(pid);
  rmSync(PID_FILE, { force: true });
  console.log(`已停止 pid=${[...targets].join(",")}`);
  return 0;
}

const handlers = { start, stop, status };
const fn = handlers[cmd];
if (!fn) {
  console.error(`未知命令 ${cmd}，用法: node scripts/dev_bg.mjs start|stop|status`);
  process.exit(2);
}
process.exit(await fn());
