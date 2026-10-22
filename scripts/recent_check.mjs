// 验证「最近使用」时间轴：按天分组 / 再次应用后置顶 / 被删主题的记录仍在
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

  // 时间轴的读数：分组标题、每行的时间与文案、每行有没有「再次应用」
  const timeline = () =>
    evaluate(`(() => {
      const groups = [...document.querySelectorAll("[data-view] section")].map((sec) => ({
        label: sec.querySelector("h2")?.textContent ?? "",
        count: sec.querySelectorAll("[data-recent-row]").length,
      }));
      const rows = [...document.querySelectorAll("[data-recent-row]")].map((r) => ({
        time: r.querySelector("time")?.textContent ?? "",
        text: r.innerText.replace(/\\n/g, " | "),
        canReapply: !!r.querySelector("button"),
      }));
      return JSON.stringify({ groups, rows });
    })()`);

  // 1. 切到「最近使用」
  await evaluate(`[...document.querySelectorAll('nav button')].find((b) => b.textContent.includes('最近使用')).click()`);
  await sleep(700);

  const first = JSON.parse(await timeline());
  check("时间轴按自然日分组", first.groups.length >= 3, first.groups.map((g) => `${g.label}×${g.count}`).join(" / "));
  check("分组含「今天」「昨天」", first.groups[0]?.label === "今天" && first.groups[1]?.label === "昨天");
  check("首条是最新的 Neon Night", first.rows[0]?.text.includes("Neon Night"), first.rows[0]?.text);
  check("左列显示时刻", /^\d{1,2}:\d{2}$/.test(first.rows[0]?.time ?? ""), first.rows[0]?.time);
  check("时间轴页不挂右侧检查器", !(await evaluate(`!!document.querySelector('aside[aria-label="主题详情"]')`)));

  const deletedRow = first.rows.find((r) => r.text.includes("Midnight Blue"));
  check("被删主题的记录仍在", Boolean(deletedRow), deletedRow?.text);
  check("被删记录标记为已删除且不可应用", Boolean(deletedRow) && deletedRow.text.includes("已删除") && !deletedRow.canReapply);

  // 2. 在时间轴上直接「再次应用」firefly，应归入今天并置顶
  const reapply = await evaluate(`(() => {
    const row = [...document.querySelectorAll("[data-recent-row]")].find((r) => r.textContent.includes("firefly"));
    const btn = row?.querySelector("button");
    if (!btn) return "NO_BTN";
    btn.click();
    return "CLICKED";
  })()`);
  check("时间轴可再次应用", reapply === "CLICKED", reapply);
  await sleep(900);

  const afterApply = JSON.parse(await timeline());
  check("应用后置顶为 firefly", afterApply.rows[0]?.text.includes("firefly"), afterApply.rows[0]?.text);
  check("今天分组增加到 2 条", afterApply.groups[0]?.label === "今天" && afterApply.groups[0].count === 2, JSON.stringify(afterApply.groups[0]));
  check("原 Neon Night 记录仍在", afterApply.rows.some((r) => r.text.includes("Neon Night")));

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
