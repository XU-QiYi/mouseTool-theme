// 主题库批量整理验收（决策 43）：整理模式 / 全选与半选 / 搜索清空勾选 /
// 使用中禁选 / 一次移入回收站 / 清空后回到空状态。
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。浏览器里全部走 mock，不碰真实数据目录。
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT_DIR = process.env.TEMP ?? ".";
const PORT = 9243;

let PROFILE = join(OUT_DIR, "edge_batch_profile");
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  PROFILE = join(OUT_DIR, `edge_batch_profile_${process.pid}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + PROFILE,
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
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.method === "Runtime.exceptionThrown") {
      pageErrors.push(data.params?.exceptionDetails?.text ?? "unknown");
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

  const evaluate = async (expression, awaitPromise = false) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(`页面执行失败：${JSON.stringify(res.result.exceptionDetails.exception)}`);
    }
    return res.result?.result?.value;
  };

  const waitFor = async (expression, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return true;
      await sleep(100);
    }
    return false;
  };

  const waitReady = async () => {
    for (let i = 0; i < 60; i++) {
      const ready = await evaluate(
        `Boolean(globalThis.__themeStore && !globalThis.__themeStore.getState().loading)`,
      );
      if (ready) return true;
      await sleep(250);
    }
    return false;
  };

  const goMine = async () => {
    await evaluate(`__themeStore.getState().setCurrentPage("mine")`);
    await sleep(300);
  };

  const batchCount = async () =>
    evaluate(`document.querySelector("[data-batch-count]")?.textContent?.trim() ?? ""`);
  const selectedRows = async () =>
    evaluate(
      `[...document.querySelectorAll("[data-theme-row] [role=checkbox]")].filter(c => c.getAttribute("aria-checked") === "true").length`,
    );
  const headerState = async () =>
    evaluate(
      `document.querySelector('thead [role=checkbox]')?.getAttribute("aria-checked") ?? ""`,
    );

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: URL_TO_OPEN });
  await waitReady();
  await goMine();

  // ---------------------------------------------------------------- 入口与默认形态
  const initial = JSON.parse(
    await evaluate(`JSON.stringify({
      rows: document.querySelectorAll("[data-theme-row]").length,
      batchModeButton: Boolean(document.querySelector("[data-batch-mode]")),
      exportAll: Boolean(document.querySelector("[data-export-all]")),
      rowCheckboxes: document.querySelectorAll("[data-theme-row] [role=checkbox]").length,
    })`),
  );
  check("「我的主题」默认是表格形态", initial.rows === 2, `${initial.rows} 行`);
  check("默认有「批量整理」与「导出全部」", initial.batchModeButton && initial.exportAll);
  check("未进入整理模式时不出现勾选列", initial.rowCheckboxes === 0);

  await evaluate(`document.querySelector("[data-batch-mode]").click()`);
  await sleep(300);
  const entered = JSON.parse(
    await evaluate(`JSON.stringify({
      rowCheckboxes: document.querySelectorAll("[data-theme-row] [role=checkbox]").length,
      header: Boolean(document.querySelector('thead [role=checkbox]')),
      count: document.querySelector("[data-batch-count]")?.textContent?.trim() ?? "",
      deleteDisabled: document.querySelector("[data-batch-delete]")?.disabled ?? null,
      exportAll: Boolean(document.querySelector("[data-export-all]")),
    })`),
  );
  check(
    "进入整理模式出现逐行与全选复选框",
    entered.rowCheckboxes === 2 && entered.header,
    `${entered.rowCheckboxes} 个行勾选`,
  );
  check("初始未选时不显示删除入口为可用", entered.count === "已选 0 套" && entered.deleteDisabled === true, entered.count);
  check("整理模式收起「导出全部」避免动作混淆", entered.exportAll === false);

  // ---------------------------------------------------------------- 单选 / 半选 / 全选
  await evaluate(`document.querySelector("[data-theme-row] [role=checkbox]").click()`);
  await sleep(250);
  const one = JSON.parse(
    await evaluate(`JSON.stringify({
      count: document.querySelector("[data-batch-count]")?.textContent?.trim() ?? "",
      deleteDisabled: document.querySelector("[data-batch-delete]")?.disabled ?? null,
      header: document.querySelector('thead [role=checkbox]')?.getAttribute("aria-checked") ?? "",
      inspector: document.querySelector('aside[aria-label="主题详情"]')?.textContent?.includes("还没有选中主题") ?? false,
    })`),
  );
  check("勾选一套后计数与删除入口就绪", one.count === "已选 1 套" && one.deleteDisabled === false, one.count);
  check("表头复选框呈半选", one.header === "mixed", one.header);
  check("点勾选不会顺带选中检查器", one.inspector === true);

  await evaluate(`document.querySelector('thead [role=checkbox]').click()`);
  await sleep(250);
  const all = JSON.parse(
    await evaluate(`JSON.stringify({
      selected: [...document.querySelectorAll("[data-theme-row] [role=checkbox]")].filter(c => c.getAttribute("aria-checked") === "true").length,
      count: document.querySelector("[data-batch-count]")?.textContent?.trim() ?? "",
      header: document.querySelector('thead [role=checkbox]')?.getAttribute("aria-checked") ?? "",
      selectAllLabel: document.querySelector("[data-select-all]")?.textContent?.trim() ?? "",
    })`),
  );
  check("表头复选框可全选", all.selected === 2 && all.count === "已选 2 套", `${all.selected} 套`);
  check("全选后表头呈选中且按钮改为取消全选", all.header === "true" && all.selectAllLabel === "取消全选");

  // ---------------------------------------------------------------- 换搜索词清空勾选
  await evaluate(`__themeStore.getState().setSearchQuery("Neon")`);
  await sleep(250);
  const searched = JSON.parse(
    await evaluate(`JSON.stringify({
      count: document.querySelector("[data-batch-count]")?.textContent?.trim() ?? "",
      rows: document.querySelectorAll("[data-theme-row]").length,
      header: document.querySelector('thead [role=checkbox]')?.getAttribute("aria-checked") ?? "",
    })`),
  );
  check("换搜索词会清空勾选", searched.count === "已选 0 套" && searched.rows === 1, `${searched.count} / ${searched.rows} 行`);
  check("筛选后表头回到未选", searched.header === "false", searched.header);
  await evaluate(`__themeStore.getState().setSearchQuery("")`);
  await sleep(250);

  // ---------------------------------------------------------------- 使用中禁选
  await evaluate(`document.querySelector('[data-theme-row="9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"] [role=checkbox]').click()`);
  await sleep(200);
  const beforeApply = await batchCount();
  await evaluate(`__themeStore.getState().applyTheme("9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11")`);
  await waitFor(`__themeStore.getState().activeThemeId === "9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"`);
  await sleep(250);
  const afterApply = JSON.parse(
    await evaluate(`JSON.stringify({
      count: document.querySelector("[data-batch-count]")?.textContent?.trim() ?? "",
      checked: document.querySelector('[data-theme-row="9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"] [role=checkbox]')?.getAttribute("aria-checked") ?? "",
    })`),
  );
  check(
    "应用后使用中的主题自动退出勾选",
    beforeApply === "已选 1 套" && afterApply.count === "已选 0 套" && afterApply.checked === "false",
    `${beforeApply} -> ${afterApply.count}`,
  );

  const activeState = JSON.parse(
    await evaluate(`JSON.stringify({
      active: document.querySelector('[data-theme-row="9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"] [role=checkbox]')?.disabled ?? null,
      other: document.querySelector('[data-theme-row="4a7d92e1-3c8b-4f60-9a1d-5e2b8c7f0a33"] [role=checkbox]')?.disabled ?? null,
    })`),
  );
  check("使用中的主题复选框禁用", activeState.active === true, String(activeState.active));
  check("其余主题仍可勾选", activeState.other === false, String(activeState.other));

  await evaluate(`document.querySelector("[data-select-all]").click()`);
  await sleep(250);
  const activeSelect = JSON.parse(
    await evaluate(`JSON.stringify({
      count: document.querySelector("[data-batch-count]")?.textContent?.trim() ?? "",
      activeSelected: document.querySelector('[data-theme-row="9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"] [role=checkbox]')?.getAttribute("aria-checked") ?? "",
    })`),
  );
  check("全选自动排除使用中的主题", activeSelect.count === "已选 1 套" && activeSelect.activeSelected === "false", activeSelect.count);

  // ---------------------------------------------------------------- 确认框与批量删除
  await evaluate(`document.querySelector("[data-batch-delete]").click()`);
  await sleep(250);
  const dialog = JSON.parse(
    await evaluate(`JSON.stringify({
      open: Boolean(document.querySelector("[data-batch-delete-dialog]")),
      title: document.querySelector("[data-batch-delete-dialog] h2")?.textContent?.trim() ?? "",
      text: document.querySelector("[data-batch-delete-dialog]")?.textContent ?? "",
      items: [...document.querySelectorAll("[data-batch-delete-item]")].map(el => el.getAttribute("data-batch-delete-item")),
    })`),
  );
  check("批量删除弹出确认框", dialog.open && dialog.title.includes("1 套"), dialog.title);
  check("确认框点名要删的主题且不含使用中主题", dialog.items.length === 1 && dialog.text.includes("Paper & Ink") && !dialog.text.includes("Neon Night"), dialog.items.join(","));

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = join(OUT_DIR, "batch_page.png");
  writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"));
  console.log(`screenshot: ${shotPath}`);

  await evaluate(`document.querySelector("[data-confirm-batch-delete]").click()`);
  const deletedOne = await waitFor(
    `document.querySelectorAll("[data-theme-row]").length === 1 &&
     __themeStore.getState().themes.filter(t => !t.is_built_in).length === 1`,
  );
  const deleteToast = await waitFor(`document.body.textContent.includes("已移入回收站 1 套主题")`);
  const remainsActive = await evaluate(
    `__themeStore.getState().activeThemeId === "9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"`,
  );
  check("确认后批量删除成功且提示套数", deletedOne && deleteToast);
  check("使用中的主题不受影响", remainsActive === true);
  check("删除后勾选归零", (await batchCount()) === "已选 0 套", await batchCount());

  // ---------------------------------------------------------------- 清空最后一轮
  await evaluate(`__themeStore.getState().restoreDefault()`);
  await waitFor(`__themeStore.getState().activeThemeId === null`);
  await sleep(250);
  await evaluate(`document.querySelector("[data-select-all]").click()`);
  await sleep(200);
  await evaluate(`document.querySelector("[data-batch-delete]").click()`);
  await sleep(200);
  await evaluate(`document.querySelector("[data-confirm-batch-delete]").click()`);
  const emptied = await waitFor(
    `document.body.textContent.includes("还没有导入过主题") &&
     __themeStore.getState().themes.every(t => t.is_built_in)`,
  );
  check("删完最后一轮回到空状态", emptied);

  check("全程无 JS 异常", pageErrors.length === 0, pageErrors.join(" | "));
  ws.close();
  if (results.some((r) => !r.ok)) process.exitCode = 1;
} finally {
  edge.kill();
}
