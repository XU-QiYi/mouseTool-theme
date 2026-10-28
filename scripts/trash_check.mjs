// 回收站验收：删除 → 移入回收站 → 恢复 / 彻底删除 / 清空（浏览器 mock 链路）
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9235;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_trash_profile",
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
  const clickText = async (label) => {
    const ok = await evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "${label}");
      btn?.click();
      return Boolean(btn);
    })()`);
    await sleep(400);
    return ok;
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
    if (await evaluate(`Boolean(window.__toast && window.__themeStore)`).catch(() => false)) break;
  }

  // ---------------------------------------------------------------- 初始列表
  check("进入设置", await clickNav("设置"));
  check("进入「数据」分组", await clickNav("数据"));

  await clickText("打开回收站");
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (await evaluate(`document.querySelectorAll("[data-trash-row]").length >= 2`)) break;
  }

  const initial = JSON.parse(
    await evaluate(`JSON.stringify({
      heading: document.querySelector("h2")?.textContent ?? null,
      rows: document.querySelectorAll("[data-trash-row]").length,
      statuses: [...document.querySelectorAll("[data-trash-status]")].map(el => el.getAttribute("data-trash-status")),
      text: document.querySelector("[data-settings-section]")?.textContent ?? "",
    })`),
  );
  check("回收站子页标题", initial.heading === "回收站", String(initial.heading));
  check("mock 预置至少 2 条回收站条目", initial.rows >= 2, `${initial.rows} 行`);
  check(
    "预置条目状态均为可恢复",
    initial.statuses.length > 0 && initial.statuses.every((status) => status === "ok"),
    initial.statuses.join("/"),
  );
  check("显示保留数量上限", initial.text.includes("/ 20"), "应出现「n / 20」");
  check("显示清空入口", initial.text.includes("清空回收站"));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = join(process.env.TEMP ?? ".", "trash_page.png");
  writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"));
  console.log(`screenshot: ${shotPath}`);

  // ---------------------------------------------------------------- 删除 → 回收站
  const beforeDelete = await evaluate(`window.__themeStore.getState().themes.length`);
  const deleteOk = await evaluate(`window.__themeStore.getState().deleteTheme("4a7d92e1-3c8b-4f60-9a1d-5e2b8c7f0a33")`);
  await sleep(500);
  const afterDelete = await evaluate(`window.__themeStore.getState().themes.length`);
  check("删除动作成功", deleteOk === true);
  check("删除后主题列表 -1", afterDelete === beforeDelete - 1, `${beforeDelete} -> ${afterDelete}`);

  await clickText("刷新");
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (await evaluate(`document.querySelectorAll("[data-trash-row]").length >= 3`)) break;
  }
  const withDeleted = JSON.parse(
    await evaluate(`JSON.stringify({
      rows: document.querySelectorAll("[data-trash-row]").length,
      hasPaper: [...document.querySelectorAll("[data-trash-row]")].some(row => row.textContent.includes("Paper & Ink")),
    })`),
  );
  check("删除的主题出现在回收站", withDeleted.hasPaper, `${withDeleted.rows} 行`);

  // ---------------------------------------------------------------- 恢复
  const restored = await evaluate(`(() => {
    const row = [...document.querySelectorAll("[data-trash-row]")].find(r => r.textContent.includes("Paper & Ink"));
    const btn = row ? [...row.querySelectorAll("button")].find(b => b.textContent.includes("恢复")) : null;
    btn?.click();
    return Boolean(btn);
  })()`);
  check("找到并点击「恢复」", restored);
  for (let i = 0; i < 25; i++) {
    await sleep(200);
    const state = JSON.parse(
      await evaluate(`JSON.stringify({
        rows: document.querySelectorAll("[data-trash-row]").length,
        themes: window.__themeStore.getState().themes.length,
      })`),
    );
    if (state.rows === 2 && state.themes === beforeDelete) break;
  }
  const afterRestore = JSON.parse(
    await evaluate(`JSON.stringify({
      rows: document.querySelectorAll("[data-trash-row]").length,
      themes: window.__themeStore.getState().themes.length,
      hasPaper: [...document.querySelectorAll("[data-trash-row]")].some(row => row.textContent.includes("Paper & Ink")),
    })`),
  );
  check("恢复后回收站 -1", afterRestore.rows === 2, `${afterRestore.rows} 行`);
  check("恢复后主题列表回到删除前", afterRestore.themes === beforeDelete, String(afterRestore.themes));
  check("恢复的主题不再出现在回收站", !afterRestore.hasPaper);

  // ---------------------------------------------------------------- 彻底删除
  const purgeClicked = await evaluate(`(() => {
    const row = document.querySelector("[data-trash-row]");
    const btn = row?.querySelector('[aria-label^="彻底删除"]');
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(400);
  const purgeDialog = await evaluate(`Boolean(document.querySelector("[data-trash-purge-dialog]"))`);
  check("彻底删除有二次确认", purgeClicked && purgeDialog);

  const purged = await evaluate(`(() => {
    const dialog = document.querySelector("[data-trash-purge-dialog]");
    const btn = dialog ? [...dialog.querySelectorAll("button")].find(b => b.textContent.trim() === "彻底删除") : null;
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(700);
  const afterPurge = await evaluate(`document.querySelectorAll("[data-trash-row]").length`);
  check("确认后条目被彻底删除", purged && afterPurge === 1, `剩 ${afterPurge} 行`);

  // ---------------------------------------------------------------- 清空
  await clickText("清空回收站");
  const emptyDialog = await evaluate(`Boolean(document.querySelector("[data-trash-empty-dialog]"))`);
  check("清空回收站有二次确认", emptyDialog);
  const emptied = await evaluate(`(() => {
    const dialog = document.querySelector("[data-trash-empty-dialog]");
    const btn = dialog ? [...dialog.querySelectorAll("button")].find(b => b.textContent.trim() === "确认清空") : null;
    btn?.click();
    return Boolean(btn);
  })()`);
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (await evaluate(`Boolean(document.querySelector("[data-trash-empty]"))`)) break;
  }
  const emptyState = await evaluate(`Boolean(document.querySelector("[data-trash-empty]"))`);
  check("清空后显示空状态", emptied && emptyState);

  // ---------------------------------------------------------------- 损坏条目
  await send("Page.navigate", { url: "http://localhost:1420/?mock-trash-damaged" });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    if (await evaluate(`Boolean(window.__toast && window.__themeStore)`).catch(() => false)) break;
  }
  await clickNav("设置");
  await clickNav("数据");
  await clickText("打开回收站");
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (await evaluate(`document.querySelectorAll("[data-trash-row]").length >= 2`)) break;
  }
  const damaged = JSON.parse(
    await evaluate(`(() => {
      const row = [...document.querySelectorAll("[data-trash-row]")].find(r => r.getAttribute("data-trash-status") === "damaged");
      const restore = row ? [...row.querySelectorAll("button")].find(b => b.textContent.includes("恢复")) : null;
      return JSON.stringify({
        hasDamaged: Boolean(row),
        badge: row?.textContent.includes("无法恢复") ?? false,
        restoreDisabled: restore ? restore.hasAttribute("disabled") : null,
        hint: row?.textContent.includes("回收站记录不是有效 JSON") ?? false,
      });
    })()`),
  );
  check("损坏条目仍会列出并标记", damaged.hasDamaged && damaged.badge);
  check("损坏条目的恢复按钮被禁用", damaged.restoreDisabled === true);
  check("损坏条目说明具体原因", damaged.hint);

  check("运行期无 JS 异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

  ws.close();
} finally {
  edge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[回收站] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
