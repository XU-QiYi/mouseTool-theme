// 未来页面验收：诊断中心 / 备份历史 / 导入中心（浏览器 mock 链路）
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
// - 诊断中心：设置 → 数据 → 运行诊断 → 弹窗 / 4 项检查 / 只读说明 / Esc 关闭
// - 备份历史：数据 → 备份历史 → 至少 2 行（mock 预置）→ 返回数据
// - 导入中心：__importStore.enqueue 两条 mock 路径 → 开始导入 → 两项成功 → 关闭
import { spawn } from "node:child_process";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9231;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_headless_profile",
  "about:blank",
]);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? `  ${detail}` : ""}`);
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

  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.method === "Runtime.exceptionThrown") {
      pageErrors.push(d.params?.exceptionDetails?.exception?.description ?? d.params?.exceptionDetails?.text);
    }
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok) => {
      const i = ++id;
      pending.set(i, ok);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? "页面内执行失败");
    }
    return res.result?.result?.value;
  };

  const clickNav = async (label) => {
    const ok = await evaluate(`(() => {
      const btn = [...document.querySelectorAll("nav button")].find(b => b.textContent.trim().startsWith("${label}"));
      btn?.click();
      return Boolean(btn);
    })()`);
    await sleep(500);
    return ok;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:1420" });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    if (await evaluate(`Boolean(window.__toast)`).catch(() => false)) break;
  }

  // ---------------------------------------------------------------- 诊断中心
  check("进入设置", await clickNav("设置"));
  check("进入「数据」分组", await clickNav("数据"));

  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("运行诊断"));
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(600);

  const diag = await evaluate(`(() => {
    const dialog = document.querySelector("[data-diagnostics-dialog]");
    return JSON.stringify({
      open: Boolean(dialog),
      title: dialog?.querySelector("h2")?.textContent ?? null,
      checks: [...dialog?.querySelectorAll("[data-diagnostic-check]") ?? []].map((el) => el.getAttribute("data-diagnostic-check")),
      readonly: dialog?.textContent.includes("只读，不修改任何文件") ?? false,
      rescan: [...dialog?.querySelectorAll("button") ?? []].some(b => b.textContent.includes("重新扫描")),
      copy: [...dialog?.querySelectorAll("button") ?? []].some(b => b.textContent.includes("复制报告")),
    });
  })()`);
  const diagState = JSON.parse(diag);
  check("运行诊断打开弹窗", diagState.open, diag);
  check("弹窗标题是「诊断中心」", diagState.title === "诊断中心", String(diagState.title));
  check(
    "四项检查齐全（数据目录/主题/当前使用/设置）",
    ["data-dir", "themes", "active", "settings"].every((key) => diagState.checks.includes(key)),
    diagState.checks.join(","),
  );
  check("副标题含「只读，不修改任何文件」", diagState.readonly);
  check("有重新扫描与复制报告", diagState.rescan && diagState.copy);

  // Esc 关闭：焦点在弹窗内，Esc 应该收起并回到触发按钮
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
  await sleep(400);
  const diagClosed = await evaluate(`!document.querySelector("[data-diagnostics-dialog]")`);
  check("Esc 关闭诊断弹窗", diagClosed);

  // ---------------------------------------------------------------- 备份历史
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "备份历史");
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(700);

  const history = await evaluate(`(() => {
    return JSON.stringify({
      heading: document.querySelector("h2")?.textContent ?? null,
      rows: document.querySelectorAll("[data-backup-row]").length,
      empty: Boolean(document.querySelector("[data-backup-empty]")),
      actions: [...document.querySelectorAll("button")].map(b => b.textContent.trim()),
    });
  })()`);
  const historyState = JSON.parse(history);
  check("进入备份历史子页", historyState.heading === "备份历史", String(historyState.heading));
  check(
    "mock 预置至少 2 条备份",
    historyState.rows >= 2,
    `${historyState.rows} 行`,
  );
  check("子页保留主操作（立即备份/从文件恢复/导出到…/刷新）",
    ["立即备份", "从文件恢复", "导出到…", "刷新"].every((label) => historyState.actions.includes(label)),
    historyState.actions.filter((a) => ["立即备份", "从文件恢复", "导出到…", "刷新"].includes(a)).join("/"),
  );

  const backOk = await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="返回数据设置"]');
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(500);
  const backView = await evaluate(`document.querySelector("[data-data-dir]") !== null`);
  check("返回「数据」主视图正常", backOk && backView);

  // ---------------------------------------------------------------- 导入中心
  const beforeThemes = await evaluate(`window.__themeStore.getState().themes.length`);
  await evaluate(`window.__importStore.getState().enqueue(["批量甲.zip", "批量乙.zip"])`);
  await sleep(400);
  const centerOpen = await evaluate(`window.__importStore.getState().open`);
  check("enqueue 打开导入中心", centerOpen === true);

  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "开始导入");
    btn?.click();
    return Boolean(btn);
  })()`);

  // 串行执行两个 mock 任务：等它们都到终态
  let done = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const state = await evaluate(`JSON.stringify({
      running: window.__importStore.getState().running,
      statuses: window.__importStore.getState().jobs.map((job) => job.status),
    })`);
    const parsed = JSON.parse(state);
    if (!parsed.running && parsed.statuses.length === 2 && parsed.statuses.every((s) => s === "success" || s === "failed")) {
      done = true;
      break;
    }
  }
  const finalState = JSON.parse(
    await evaluate(`JSON.stringify({
      statuses: window.__importStore.getState().jobs.map((job) => job.status),
      rows: document.querySelectorAll("[data-import-job]").length,
      themes: window.__themeStore.getState().themes.length,
    })`),
  );
  check("两个任务全部结束", done, finalState.statuses.join("/"));
  check(
    "任务行状态为 success",
    finalState.statuses.every((s) => s === "success"),
    finalState.statuses.join("/"),
  );
  check("任务行数与队列一致", finalState.rows === 2, String(finalState.rows));
  check("主题列表在队列结束后刷新（+2）", finalState.themes === beforeThemes + 2, `${beforeThemes} -> ${finalState.themes}`);

  const closeOk = await evaluate(`(() => {
    window.__importStore.getState().closeCenter();
    return !window.__importStore.getState().open;
  })()`);
  await sleep(300);
  check("导入中心可关闭", closeOk);

  check("运行期无 JS 异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

  ws.close();
} finally {
  edge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[未来页面] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
