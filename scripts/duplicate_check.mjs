// 主题去重诊断验收（决策 38）：诊断中心第六项默认「没有重复」→ ?mock-duplicates=1
// 注入一组重复 → 摘要变「1 组内容重复」+ 注意徽标 → 详情点名成员与可省字节 → 无 JS 异常。
// 浏览器全走 mock；真实比对（指纹预分组 + 组内逐字节）由 Rust 单测覆盖。
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9243;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_duplicate_profile",
  "about:blank",
]);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? `  ${detail}` : ""}`);
};

try {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {}
  }
  const page = targets.find((t) => t.type === "page");
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
      pageErrors.push(data.params?.exceptionDetails?.exception?.description ?? data.params?.exceptionDetails?.text);
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
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? "页面内执行失败");
    }
    return res.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");

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
  const openDiagnostics = async () => {
    await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
    await evaluate(`__themeStore.getState().setSettingsSection("data")`);
    await sleep(300);
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("运行诊断"));
      btn?.click();
      return Boolean(btn);
    })()`);
    await sleep(400);
  };
  const diagState = async () =>
    JSON.parse(
      await evaluate(`(() => {
        const dialog = document.querySelector("[data-diagnostics-dialog]");
        const chip = dialog?.querySelector('[data-diagnostic-check="duplicates"]');
        const detail = dialog?.querySelector(".flex-1 p + p")?.textContent ?? "";
        return JSON.stringify({
          ids: [...dialog?.querySelectorAll("[data-diagnostic-check]") ?? []].map(el => el.getAttribute("data-diagnostic-check")),
          severity: chip?.getAttribute("data-diagnostic-severity") ?? null,
          summary: chip?.querySelector("span + span")?.textContent ?? null,
        });
      })()`),
    );
  const waitSummary = async (needle) => {
    for (let i = 0; i < 40; i++) {
      const state = await diagState();
      if (state.summary?.includes(needle)) return state;
      await sleep(150);
    }
    return await diagState();
  };

  // ---- 1. 默认态：六项齐全，重复主题为「没有内容重复」----
  await goto("http://localhost:1420");
  await openDiagnostics();
  const idle = await waitSummary("没有内容重复的主题");
  check("诊断中心六项齐全", ["data-dir", "themes", "active", "settings", "file-gaps", "duplicates"].every(id => idle.ids.includes(id)), idle.ids.join(","));
  check("默认无重复且判定正常", idle.summary === "没有内容重复的主题" && idle.severity === "ok", JSON.stringify(idle));

  // ---- 2. 重新扫描后仍正常 ----
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("重新扫描"));
    btn?.click();
    return Boolean(btn);
  })()`);
  const afterRescan = await waitSummary("没有内容重复的主题");
  check("重新扫描后查重仍通过", afterRescan.summary === "没有内容重复的主题", afterRescan.summary ?? "");

  // ---- 3. 注入重复组：注意徽标 + 详情点名 ----
  await goto("http://localhost:1420/?mock-duplicates=1");
  await openDiagnostics();
  const dup = await waitSummary("1 组内容重复");
  check("摘要报出重复组数", dup.summary === "1 组内容重复", dup.summary ?? "");
  check("严重度升为「注意」", dup.severity === "warning", String(dup.severity));
  await evaluate(`(() => {
    const chip = document.querySelector('[data-diagnostic-check="duplicates"]');
    chip?.click();
    return true;
  })()`);
  await sleep(200);
  const detailText = await evaluate(
    `document.querySelector('[data-diagnostics-dialog] .scroll-thin.flex-1')?.textContent ?? ""`,
  );
  check(
    "详情点名成员、槽位与可省字节",
    detailText.includes("内容相同") && detailText.includes("4 个槽位") && detailText.includes("可省"),
    detailText.slice(0, 120),
  );

  // ---- 4. 运行期无 JS 异常 ----
  check("运行期无 JS 异常", pageErrors.length === 0, `errors=${pageErrors.length}`);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const out = join(process.env.TEMP ?? ".", "duplicate_page.png");
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n[主题去重] ${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed > 0 ? 1 : 0;
} finally {
  edge.kill();
}
