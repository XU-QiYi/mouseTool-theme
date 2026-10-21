// 设计规范落地验证：不点「应用」（避免动系统光标），只验结构、焦点与截图
// 用法：node scripts/design_check.mjs [URL]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT_DIR = process.env.TEMP ?? ".";
const PORT = 9225;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(OUT_DIR, "edge_design_profile"),
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

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.result?.exceptionDetails) {
      return "ERR: " + (r.result.exceptionDetails.exception?.description ?? "unknown");
    }
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Page.navigate", { url: URL_TO_OPEN });
  await sleep(3200);

  // 1. 结构断言（逐条查，任何一条出错都能定位）
  const checks = {
    导航项数: `document.querySelectorAll("nav button").length`,
    当前页有aria_current: `[...document.querySelectorAll("nav button")].filter(b => b.getAttribute("aria-current") === "page").length`,
    导航全部带焦点环: `[...document.querySelectorAll("nav button")].every(b => b.className.includes("focus-visible:ring-3"))`,
    卡片带焦点环: `(() => { const c = [...document.querySelectorAll("button")].find(b => b.className.includes("rounded-xl")); return c ? c.className.includes("focus-ring") : null; })()`,
    卡片带aria_pressed: `(() => { const c = [...document.querySelectorAll("button")].find(b => b.className.includes("rounded-xl")); return c ? c.getAttribute("aria-pressed") : null; })()`,
    卡片描边方式: `(() => { const c = [...document.querySelectorAll("button")].find(b => b.className.includes("rounded-xl")); return c ? (c.className.includes("ring-1") ? "ring" : "border") : null; })()`,
    自定义滚动区数量: `document.querySelectorAll('[data-slot="scroll-area"]').length`,
    原生滚动容器数: `[...document.querySelectorAll("*")].filter(e => { const s = getComputedStyle(e); return s.overflowY === "auto" && e.clientHeight > 100; }).length`,
  };
  console.log("结构审计:");
  for (const [k, expr] of Object.entries(checks)) {
    console.log(`  ${k}: ${await evaluate(expr)}`);
  }

  // 2. 键盘焦点：按 Tab 走入界面，截取焦点态
  const tab = async () => {
    for (const type of ["rawKeyDown", "char", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
    }
    await sleep(180);
  };

  const focused = [];
  for (let i = 0; i < 6; i++) {
    await tab();
    const info = await evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "BODY";
      const s = getComputedStyle(el);
      const hasRing = s.boxShadow && s.boxShadow !== "none";
      return (el.tagName + " · " + (el.textContent || "").trim().slice(0, 10) +
        " · ring: " + (hasRing ? s.boxShadow.replace(/rgba?\\([^)]*\\)/g, m => m).slice(-70) : "无")).replace(/\\s+/g, " ");
    })()`);
    focused.push(info);
  }
  console.log("Tab 焦点序列:");
  focused.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  const shot1 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_focus.png"), Buffer.from(shot1.result.data, "base64"));

  // 3. 选中第一张卡，截整体
  await evaluate(`(() => {
    const card = [...document.querySelectorAll("button")].find(b => b.className.includes("rounded-xl"));
    card?.click();
    return "ok";
  })()`);
  await sleep(900);

  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_selected.png"), Buffer.from(shot2.result.data, "base64"));

  // 4. Toast：浏览器环境 applyTheme 是 mock，不会改系统光标，可以安全点击
  const applyClicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("应用此主题"));
    if (!btn) return "NOT_FOUND";
    if (btn.disabled) return "DISABLED";
    btn.click();
    return "CLICKED";
  })()`);
  await sleep(700);

  const toastState = await evaluate(`(() => {
    const text = document.body.innerText;
    const hit = text.includes("已应用");
    const viewport = [...document.querySelectorAll("div")].find(e => {
      const s = getComputedStyle(e);
      return s.position === "fixed" && s.zIndex === "60";
    });
    return hit ? "出现：" + (viewport ? viewport.innerText.replace(/\\s+/g, " ").slice(0, 40) : "但找不到容器") : "未出现";
  })()`);
  console.log("应用按钮:", applyClicked, "| Toast:", toastState);

  const shot3 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_toast.png"), Buffer.from(shot3.result.data, "base64"));

  // 5. 删除确认弹窗：选第二个（已导入）主题，点删除
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll("button")].filter(b => b.className.includes("rounded-xl"));
    if (cards.length < 2) return "ONLY_" + cards.length;
    cards[1].click();
    return "OK";
  })()`);
  await sleep(700);

  const delState = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("删除此主题"));
    if (!btn) return "NO_BTN";
    if (btn.disabled) return "DISABLED";
    btn.click();
    return "CLICKED";
  })()`);
  await sleep(700);

  const dialog = await evaluate(`(() => {
    const el = document.querySelector('[role="alertdialog"]');
    if (!el) return "弹窗未出现";
    return "弹窗：" + el.innerText.replace(/\\s+/g, " ").slice(0, 80);
  })()`);
  console.log("删除按钮:", picked, delState, "|", dialog);

  const shot5 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_confirm.png"), Buffer.from(shot5.result.data, "base64"));

  // 点取消关闭，不真正删除
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent.trim() === "取消");
    btn?.click();
    return btn ? "CANCELLED" : "NO_CANCEL";
  })()`);
  await sleep(400);

  // 6. 长文案：验证真实错误信息的换行与高度（模拟 Rust 返回的最长错误）
  await evaluate(`window.__toast?.close()`);
  await sleep(300);
  const longErr = await evaluate(`(() => {
    if (!window.__toast) return "NO_HOOK";
    window.__toast.error("导入失败", "光标文件名认不出来。请改用 arrow、busy、text、hand 这类标准命名后重新打包");
    return "OK";
  })()`);
  await sleep(600);
  console.log("长文案测试:", longErr);

  const shot4 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_toast_long.png"), Buffer.from(shot4.result.data, "base64"));

  // 7. 完整删除链路：确认后列表应减少一项（浏览器里 deleteTheme 是 mock，不会碰磁盘）
  const before = await evaluate(
    `document.querySelectorAll('button[class*="rounded-xl"]').length`,
  );
  await evaluate(`(() => {
    const cards = [...document.querySelectorAll("button")].filter(b => b.className.includes("rounded-xl"));
    const target = cards.find(c => c.textContent.includes("Neon Night"));
    target?.click();
    return !!target;
  })()`);
  await sleep(500);
  await evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("删除此主题"))?.click()`);
  await sleep(500);
  await evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent.includes("确认删除"))?.click()`);
  await sleep(900);

  const after = await evaluate(
    `document.querySelectorAll('button[class*="rounded-xl"]').length`,
  );
  const delToast = await evaluate(
    `document.body.innerText.includes("已删除") ? "toast 出现" : "toast 缺失"`,
  );
  console.log(`删除链路: ${before} 项 → ${after} 项 | ${delToast}`);

  const shot6 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_deleted.png"), Buffer.from(shot6.result.data, "base64"));

  console.log(
    "截图:",
    join(OUT_DIR, "design_confirm.png"),
    join(OUT_DIR, "design_deleted.png"),
  );
  ws.close();
} finally {
  edge.kill();
}
