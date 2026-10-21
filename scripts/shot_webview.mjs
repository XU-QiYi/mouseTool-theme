// 连接已运行的 WebView2 调试端口，直接截取内核渲染结果
// 用法：node scripts/shot_webview.mjs [端口]
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.argv[2] ?? 9225);
const OUT = join(process.env.TEMP ?? ".", "mousetool_cdp.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
for (let i = 0; i < 25; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const targets = await res.json();
    page = targets.find((t) => t.type === "page");
    if (page) break;
  } catch {
    /* 端口未就绪 */
  }
  await sleep(400);
}
if (!page) {
  console.error("连不上调试端口", PORT);
  process.exit(1);
}
console.log("目标页面:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, err) => {
  ws.onopen = ok;
  ws.onerror = err;
});
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const d = JSON.parse(ev.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  }
};
const send = (method, params = {}) =>
  new Promise((ok) => {
    const id = ++msgId;
    pending.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
const size = await send("Runtime.evaluate", {
  expression: `JSON.stringify({w: innerWidth, h: innerHeight, title: document.title, bodyLen: document.body.innerHTML.length, cards: document.querySelectorAll("button").length})`,
  returnByValue: true,
});
console.log("页面状态:", size.result?.result?.value);

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
  console.log("已保存:", OUT);
} else {
  console.error("截图失败:", JSON.stringify(shot).slice(0, 200));
}
ws.close();
