// 临时验证「最近使用」：排序 / 应用后置顶 / 删除后的提示
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9228;
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

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:1420" });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    if (await evaluate(`Boolean(window.__toast)`).catch(() => false)) break;
  }

  const cards = () => evaluate(`
    [...document.querySelectorAll('button')]
      .filter((b) => b.className.includes('rounded-xl'))
      .map((b) => b.innerText.replace(/\\n/g, ' | '))
  `);

  // 1. 切到「最近使用」
  await evaluate(`[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('最近使用')).click()`);
  await sleep(700);
  const first = await cards();
  check("最近使用页有历史卡片", first.length === 2, `共 ${first.length} 张`);
  check("按时间倒序（Neon Night 在前）", first[0]?.includes("Neon Night"), first[0]);
  check("副标题显示上次使用时间", first[0]?.includes("上次使用 2026-10-21 22:10"), first[0]);
  check("不再显示「功能开发中」占位", !(await evaluate(`document.body.innerText.includes('使用历史记录功能尚未实现')`)));

  // 2. 应用 firefly 后应置顶
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('button')].find((b) => b.className.includes('rounded-xl') && b.textContent.includes('firefly'));
    card.click();
  })()`);
  await sleep(500);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('应用此主题')).click()`);
  await sleep(900);
  const afterApply = await cards();
  check("应用后置顶为 firefly", afterApply[0]?.includes("firefly"), afterApply[0]);
  check("置顶项时间已刷新为今天", afterApply[0]?.includes("2026-10-22"), afterApply[0]);

  // 3. 删除 Neon Night 后，记录仍在但提示已删除
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('button')].find((b) => b.className.includes('rounded-xl') && b.textContent.includes('Neon Night'));
    card.click();
  })()`);
  await sleep(500);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('删除此主题')).click()`);
  await sleep(500);
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('确认删除')).click()`);
  await sleep(900);

  const afterDelete = await cards();
  check("删除后仅剩可用主题", afterDelete.length === 1 && afterDelete[0].includes("firefly"), afterDelete.join(" / "));
  check(
    "保留被删主题的记录数",
    await evaluate(`document.body.innerText.includes('另有 1 条记录的主题已被删除')`),
  );

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const out = join(process.env.TEMP ?? ".", "recent_page.png");
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("screenshot:", out);

  check("运行期无 JS 异常", pageErrors.length === 0, pageErrors.join(" | "));

  ws.close();
} finally {
  edge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[最近使用] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
