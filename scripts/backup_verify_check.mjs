// 备份完整性体检验收（决策 37）：行内体检按钮 → 完好包通过无徽标 →
// ?mock-backup-corrupt=1 注入损坏报告 → 行内「体检损坏」徽标 + 警告 toast → 无 JS 异常。
// 浏览器全走 mock；真 CRC 由 Rust 单测（STORE 条目翻字节）覆盖。
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9242;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_backup_verify_profile",
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
  const openBackupHistory = async () => {
    await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
    await evaluate(`__themeStore.getState().setSettingsSection("data")`);
    await sleep(300);
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "备份历史");
      btn?.click();
      return Boolean(btn);
    })()`);
    await sleep(400);
  };
  const firstToast = () => evaluate(`document.querySelector('[data-slot="toast"]')?.innerText ?? ""`);
  const waitToast = async (needle) => {
    for (let i = 0; i < 40; i++) {
      const text = await firstToast();
      if (text.includes(needle)) return text;
      await sleep(100);
    }
    return await firstToast();
  };
  const verifyButton = () =>
    evaluate(`document.querySelector('button[aria-label^="体检备份"]')?.getAttribute("aria-label") ?? null`);
  const clickFirstVerify = async () => {
    await evaluate(`(() => {
      const btn = document.querySelector('button[aria-label^="体检备份"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
  };
  const damagedBadges = () =>
    evaluate(`document.querySelectorAll('[data-backup-verify="damaged"]').length`);

  // ---- 1. 完好备份：体检通过，无损坏徽标 ----
  await goto("http://localhost:1420");
  await openBackupHistory();
  const btnLabel = await verifyButton();
  check("备份行有「体检」入口", Boolean(btnLabel), String(btnLabel));
  await clickFirstVerify();
  const okToast = await waitToast("体检通过");
  check("完好包提示体检通过", okToast.includes("体检通过"), okToast.slice(0, 80));
  await sleep(300);
  check("完好包行内无损坏徽标", (await damagedBadges()) === 0);

  // ---- 2. 注入损坏报告：徽标出现 + 警告 toast ----
  await goto("http://localhost:1420/?mock-backup-corrupt=1");
  await openBackupHistory();
  await clickFirstVerify();
  const badToast = await waitToast("体检发现");
  check(
    "损坏包警告并报处数",
    badToast.includes("体检发现 2 处损坏"),
    badToast.slice(0, 80),
  );
  const badges = await (async () => {
    for (let i = 0; i < 30; i++) {
      const count = await damagedBadges();
      if (count > 0) return count;
      await sleep(100);
    }
    return await damagedBadges();
  })();
  check("行内出现「体检损坏」徽标", badges > 0, `badges=${badges}`);

  // ---- 2b. 快照在 store 里（决策 42 修订）：离开子页再回来徽标仍在 ----
  await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label="返回数据设置"]');
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(400);
  await openBackupHistory();
  const badgesAfterRemount = await (async () => {
    for (let i = 0; i < 20; i++) {
      const count = await damagedBadges();
      if (count > 0) return count;
      await sleep(100);
    }
    return await damagedBadges();
  })();
  check("子页往返后体检徽标仍在（store 快照）", badgesAfterRemount > 0, `badges=${badgesAfterRemount}`);

  // ---- 2c. 复制报告带体检快照（剪贴板内容不可断言，验证成功路径 toast）----
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("复制报告"));
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(400);

  // ---- 3. 运行期无 JS 异常 ----
  check("运行期无 JS 异常", pageErrors.length === 0, `errors=${pageErrors.length}`);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const out = join(process.env.TEMP ?? ".", "backup_verify_page.png");
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n[备份体检] ${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed > 0 ? 1 : 0;
} finally {
  edge.kill();
}
