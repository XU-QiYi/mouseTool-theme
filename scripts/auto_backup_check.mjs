// 自动备份验收（决策 32）：默认关 / 开启即出当天「自动」条目 / 当日去重 /
// 重载启动触发 / 超保留数清理且手动备份不动 / 关闭开关不再动作
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。浏览器里备份走 mock，不碰真实 backups\。
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT_DIR = process.env.TEMP ?? ".";
const PORT = 9237;

// 固定 profile 会带着上一轮「自动备份已开启」的设置，污染默认态断言：每轮清一次；
// 清不掉（上一轮 Edge 还没退干净）就另起一个
let PROFILE = join(OUT_DIR, "edge_auto_backup_profile");
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  PROFILE = join(OUT_DIR, `edge_auto_backup_profile_${process.pid}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const todayStamp = (() => {
  const now = new Date();
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
})();

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + PROFILE,
  "about:blank",
]);

try {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {
      /* 端口未就绪 */
    }
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error("找不到页面调试目标");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, err) => {
    ws.onopen = ok;
    ws.onerror = err;
  });

  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.method === "Runtime.exceptionThrown") {
      pageErrors.push(data.params?.exceptionDetails?.text ?? "unknown");
    }
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok) => {
      const id = ++msgId;
      pending.set(id, ok);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const results = [];
  const assert = (name, ok, detail = "") => {
    results.push(ok);
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? `  ${detail}` : ""}`);
  };

  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async (expression, awaitPromise = false) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(`页面执行失败：${JSON.stringify(res.result.exceptionDetails.exception)}`);
    }
    return res.result?.result?.value;
  };

  const waitFor = async (expression, timeoutMs = 4000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await sleep(100);
    }
    return false;
  };

  const waitReady = async () => {
    for (let i = 0; i < 60; i++) {
      const ready = await evaluate(
        `Boolean(globalThis.__settingsStore?.getState()?.settings && globalThis.__themeStore && !globalThis.__themeStore.getState().loading)`,
      );
      if (ready) return true;
      await sleep(250);
    }
    return false;
  };

  const goto = async (url) => {
    await send("Page.navigate", { url });
    await sleep(800);
    await waitReady();
  };

  const openDataMain = async () => {
    await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
    await evaluate(`__themeStore.getState().setSettingsSection("data")`);
    await sleep(300);
  };

  const openBackupHistory = async () => {
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "备份历史");
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await sleep(300);
  };

  const countRows = async () =>
    JSON.parse(
      await evaluate(`(() => {
      const rows = [...document.querySelectorAll("[data-backup-row]")].map(r => r.getAttribute("data-backup-row") ?? "");
      return JSON.stringify({
        auto: rows.filter(n => n.startsWith("cursorstudio-backup-auto-")).length,
        manual: rows.filter(n => !n.startsWith("cursorstudio-backup-auto-")).length,
        todayAuto: rows.some(n => n.includes("${todayStamp}")),
      });
    })()`),
    );

  await goto(URL_TO_OPEN);

  // --- 1. 设置 → 数据：自动备份开关默认关闭，保留份数选择器随开关禁用 ---
  await openDataMain();
  const toggleDefault = await evaluate(
    `document.querySelector('[role="switch"][aria-label="自动备份"]')?.getAttribute('aria-checked')`,
  );
  assert("设置页有自动备份开关且默认关闭", toggleDefault === "false", String(toggleDefault));
  const keepDisabled = await evaluate(
    `document.querySelector('[data-auto-backup-keep]')?.disabled`,
  );
  assert("开关关闭时保留份数选择器禁用", keepDisabled === true, String(keepDisabled));

  // --- 2. UI 点开关 → 立即触发一份当天自动备份，备份历史出现「自动」条目 ---
  await evaluate(`document.querySelector('[role="switch"][aria-label="自动备份"]').click()`);
  const enabled = await waitFor(
    `__settingsStore.getState().settings?.auto_backup_enabled === true`,
  );
  assert("点开关后开关注入 settings", enabled);
  // 备份历史子页挂载时才拉一次列表：等自动备份（mock 延迟 80ms）完成后再进
  await sleep(800);
  await openBackupHistory();
  const appeared = await waitFor(
    `Boolean(document.querySelector('[data-backup-row^="cursorstudio-backup-auto-"]'))`,
  );
  assert("开启后备份历史出现自动备份条目", appeared);
  let rows = await countRows();
  assert("当天自动备份恰好一份", rows.auto === 1, JSON.stringify(rows));
  assert("自动备份带今天的日期段", rows.todayAuto, JSON.stringify(rows));
  assert("示例手动备份不被牵连", rows.manual === 2, JSON.stringify(rows));
  const badge = await evaluate(
    `[...document.querySelectorAll('[data-backup-row^="cursorstudio-backup-auto-"] [data-status-badge]')].map(b => b.textContent).join(" ")`,
  );
  assert("自动条目带「自动」徽标", badge.includes("自动"), badge);

  // --- 3. 关了再开：当日去重，不重打第二份 ---
  await evaluate(`document.querySelector('button[aria-label="返回数据设置"]').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('[role="switch"][aria-label="自动备份"]').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('[role="switch"][aria-label="自动备份"]').click()`);
  const reEnabled = await waitFor(
    `__settingsStore.getState().settings?.auto_backup_enabled === true`,
  );
  assert("再次开启开关生效", reEnabled);
  await openBackupHistory();
  await sleep(400);
  rows = await countRows();
  assert("同日再触发不新增备份", rows.auto === 1, JSON.stringify(rows));

  // --- 4. 调小保留份数 → 重载（带 6 份旧自动备份的 mock）→ 启动触发 + 清理 ---
  await evaluate(`document.querySelector('button[aria-label="返回数据设置"]').click()`);
  await sleep(300);
  await evaluate(
    `__settingsStore.getState().patchSettings({ auto_backup_keep: 5 })`,
    true,
  );
  const oldUrl = new URL(URL_TO_OPEN);
  oldUrl.searchParams.set("mock-backup-old", "6");
  await goto(oldUrl.toString());
  // 启动后自动备份由 lib 触发（mock 延迟 80ms），留足时间再进历史页
  await sleep(1000);
  await openDataMain();
  await openBackupHistory();
  const pruned = await waitFor(
    `[...document.querySelectorAll("[data-backup-row]")].filter(r => (r.getAttribute("data-backup-row") ?? "").startsWith("cursorstudio-backup-auto-")).length === 5`,
  );
  rows = await countRows();
  assert("启动触发补上当天备份并清理到保留份数", pruned && rows.auto === 5, JSON.stringify(rows));
  assert("清理只动自动备份，手动备份保留", rows.manual === 2, JSON.stringify(rows));
  assert("当天自动备份在保留之列", rows.todayAuto, JSON.stringify(rows));
  // 修复回归：年龄按文件名时间戳算——被清的必须是文件名最旧的两天
  // （5/6 天前），最近 4 天的占位与当天都留下；mtime 排序会反过来删错
  // 只扫自动备份行：mock 初始数据里的手动备份可能带任意日期（如 10-25），
  // 混进来会在特定系统日期产生假阳性（2026-10-30 实际撞过一次）
  const seedStamps = [0, 1, 2, 3, 4, 5].map((i) => {
    const d = new Date(Date.now() - (i + 1) * 86_400_000);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  });
  const rowNames = await evaluate(
    `[...document.querySelectorAll("[data-backup-row]")].map(r=>r.getAttribute("data-backup-row")).filter(n=>n&&n.startsWith("cursorstudio-backup-auto-"))`,
  );
  const seedKept = seedStamps.map((stamp) =>
    rowNames.some((name) => name && name.includes(stamp)),
  );
  assert(
    "清理删的是文件名最旧的（保最近 4 天 + 当天）",
    seedKept.slice(0, 4).every(Boolean) && !seedKept[4] && !seedKept[5],
    JSON.stringify(seedKept),
  );  // 保留份数选择器在主视图：先返回再读
  await evaluate(`document.querySelector('button[aria-label="返回数据设置"]').click()`);
  await sleep(300);
  const keepValue = await evaluate(`document.querySelector('[data-auto-backup-keep]')?.value`);
  assert("保留份数已落盘为 5", keepValue === "5", String(keepValue));

  // --- 5. 关闭开关：设置落盘 ---
  await evaluate(
    `__settingsStore.getState().patchSettings({ auto_backup_enabled: false })`,
    true,
  );
  const disabled = await waitFor(
    `__settingsStore.getState().settings?.auto_backup_enabled === false`,
  );
  const toggleAfter = await evaluate(
    `document.querySelector('[role="switch"][aria-label="自动备份"]')?.getAttribute('aria-checked')`,
  );
  assert("关闭开关落盘", disabled && toggleAfter === "false", String(toggleAfter));

  // --- 6. 运行期无 JS 异常 ---
  assert("运行期无 JS 异常", pageErrors.length === 0, `errors=${pageErrors.length}`);

  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "auto_backup_page.png"), Buffer.from(png.result.data, "base64"));

  const failedCount = results.filter((ok) => !ok).length;
  console.log(`\n[自动备份] ${results.length - failedCount}/${results.length} 通过`);
  process.exitCode = failedCount > 0 ? 1 : 0;
} finally {
  edge.kill();
}
