// 阶段 3 UI 自动化验证：无头 Edge + CDP
// 用法：node scripts/ui_check.mjs [URL]
// 步骤：打开页面 → 点击第一个主题卡片 → 截图保存
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT = join(process.env.TEMP ?? ".", "mousetool_click.png");
const PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(process.env.TEMP ?? ".", "edge_headless_profile"),
  "about:blank",
]);
try {
  // 等调试端口就绪
  let targets = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === "page")) break;
    } catch { /* 端口未就绪，继续等 */ }
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error("找不到页面调试目标");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
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

  await send("Page.enable");
  await send("Page.navigate", { url: URL_TO_OPEN });
  await sleep(3000); // 等 React 渲染 + 数据加载

  // 找到主题卡片（ThemeCard 是带 rounded-xl 类的 button）并点击
  const click = await send("Runtime.evaluate", {
    expression: `(() => {
      const card = [...document.querySelectorAll("button")].find(b => b.className.includes("rounded-xl"));
      if (!card) return "NOT_FOUND";
      card.click();
      return "CLICKED: " + card.textContent.trim().slice(0, 20);
    })()`,
    returnByValue: true,
  });
  console.log("点击卡片:", click.result?.result?.value);
  await sleep(800);

  // 点击「应用此主题」
  const apply = await send("Runtime.evaluate", {
    expression: `(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("应用此主题"));
      if (!btn) return "NOT_FOUND";
      if (btn.disabled) return "DISABLED";
      btn.click();
      return "CLICKED";
    })()`,
    returnByValue: true,
  });
  console.log("点击应用:", apply.result?.result?.value);
  await sleep(1000);

  const state = await send("Runtime.evaluate", {
    expression: `(() => {
      const badge = [...document.querySelectorAll("button")].find(b => b.textContent.includes("当前使用中"));
      const using = [...document.querySelectorAll("*")].some(e => e.textContent === "使用中");
      return JSON.stringify({ 按钮变为使用中: !!badge, 卡片有使用中角标: using });
    })()`,
    returnByValue: true,
  });
  console.log("状态:", state.result?.result?.value);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
  console.log("已保存:", OUT);

  ws.close();
} finally {
  edge.kill();
}
