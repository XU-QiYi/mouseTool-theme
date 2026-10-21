// 复现导航切换问题：依次点击各导航项并截图
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9226;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(process.env.TEMP ?? ".", "edge_nav_profile"),
  "about:blank",
]);

try {
  let page = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      page = targets.find((t) => t.type === "page");
      if (page) break;
    } catch {
      /* wait */
    }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, err) => {
    ws.onopen = ok;
    ws.onerror = err;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
      return;
    }
    if (d.method === "Runtime.exceptionThrown") {
      const desc = d.params?.exceptionDetails?.exception?.description
        ?? d.params?.exceptionDetails?.text;
      console.log("  ✗ 页面异常:", String(desc).split("\n").slice(0, 6).join("\n     "));
    }
    if (d.method === "Runtime.consoleAPICalled" && d.params?.type === "error") {
      const text = (d.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      console.log("  ✗ console.error:", String(text).slice(0, 300));
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok) => {
      const n = ++id;
      pending.set(n, ok);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:1420" });
  await sleep(3000);

  const clickNav = async (label) => {
    const r = await send("Runtime.evaluate", {
      expression: `(() => {
        const btn = [...document.querySelectorAll("nav button")].find(b => b.textContent.trim() === "${label}");
        if (!btn) return "NOT_FOUND";
        btn.click();
        return "OK";
      })()`,
      returnByValue: true,
    });
    await sleep(600);
    return r.result?.result?.value;
  };

  const probe = async () => {
    const r = await send("Runtime.evaluate", {
      expression: `(() => {
        const root = document.querySelector("#root > div");
        const sections = [...root.children].map(el => ({
          tag: el.tagName,
          w: el.offsetWidth,
          h: el.offsetHeight,
          text: (el.textContent || "").trim().slice(0, 40)
        }));
        return JSON.stringify({ children: sections });
      })()`,
      returnByValue: true,
    });
    return r.result?.result?.value;
  };

  for (const [label, file] of [["已导入", "nav_imported"], ["最近使用", "nav_recent"], ["主题图库", "nav_library"]]) {
    const ok = await clickNav(label);
    console.log(`点击「${label}」: ${ok}`);
    console.log("  结构:", await probe());
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const out = join(process.env.TEMP ?? ".", `${file}.png`);
    writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    console.log("  截图:", out);
  }

  ws.close();
} finally {
  edge.kill();
}
