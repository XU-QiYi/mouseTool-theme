// 维护工具箱验收（决策 34）：存储占用 / 备份内容预览 / 批量导出 / 清空使用记录
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。浏览器里全部走 mock，不碰真实数据目录。
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT_DIR = process.env.TEMP ?? ".";
const PORT = 9240;

// 固定 profile 会留下上一轮的 localStorage 设置：每轮清一次，清不掉就换名
let PROFILE = join(OUT_DIR, "edge_maintenance_profile");
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  PROFILE = join(OUT_DIR, `edge_maintenance_profile_${process.pid}`);
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

  const results = [];
  const assert = (name, ok, detail = "") => {
    results.push(ok);
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? `  ${detail}` : ""}`);
  };

  await send("Page.enable");
  await send("Runtime.enable");

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

  const openDataMain = async () => {
    await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
    await evaluate(`__themeStore.getState().setSettingsSection("data")`);
    await sleep(300);
  };

  const clickButtonByText = async (text) =>
    evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === ${JSON.stringify(text)});
      if (!btn) return false;
      btn.click();
      return true;
    })()`);

  await goto(URL_TO_OPEN);

  // --------------------------------------------------- 1. 存储占用（设置 → 数据）
  await openDataMain();
  const statsShown = await waitFor(
    `Boolean(document.querySelector("[data-storage-stats]"))`,
  );
  assert("数据页渲染出存储占用统计", statsShown);
  const statRows = JSON.parse(
    await evaluate(`JSON.stringify({
      keys: [...document.querySelectorAll("[data-storage-row]")].map(r => r.getAttribute("data-storage-row")),
      total: document.querySelector('[data-storage-row="total"]')?.textContent ?? "",
    })`),
  );
  assert(
    "统计含五个区域与总占用",
    ["themes", "backups", "trash", "history", "settings", "total"].every((key) =>
      statRows.keys.includes(key),
    ),
    statRows.keys.join(","),
  );
  assert("总占用带可读体积", /\d+(\.\d+)?\s*(B|KB|MB|GB)/.test(statRows.total), statRows.total);
  const themeRow = JSON.parse(
    await evaluate(`JSON.stringify(document.querySelector('[data-storage-row="themes"]')?.textContent ?? "")`),
  );
  assert("主题库行给出套数与体积", /套主题/.test(themeRow) && /\d+(\.\d+)?\s*(B|KB|MB|GB)/.test(themeRow), themeRow);
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("重新统计"));
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(500);
  const statsError = await evaluate(`document.querySelector("[data-storage-error]")?.textContent ?? ""`);
  assert("重新统计不报错", statsError === "", statsError);

  // --------------------------------------------------- 2. 备份内容预览（备份历史）
  await clickButtonByText("备份历史");
  await sleep(400);
  const peekOpened = await evaluate(`(() => {
    const btn = document.querySelector('button[aria-label^="查看备份内容"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  assert("备份行有「查看内容」入口", peekOpened);
  const peekLoaded = await waitFor(
    `document.querySelectorAll("[data-peek-theme]").length > 0`,
  );
  const peek = JSON.parse(
    await evaluate(`JSON.stringify({
      names: [...document.querySelectorAll("[data-peek-theme]")].map(r => r.getAttribute("data-peek-theme")),
      text: document.querySelector("[data-backup-peek]")?.textContent ?? "",
    })`),
  );
  assert("预览列出包内主题名", peekLoaded && peek.names.length > 0, peek.names.join("/"));
  assert("每个主题带槽位数", /个槽位/.test(peek.text), peek.text.slice(0, 80));
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "关闭");
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(300);
  const peekClosed = await evaluate(`document.querySelector("[data-backup-peek]") === null`);
  assert("预览可关闭", peekClosed);

  // --------------------------------------------------- 3. 批量导出（我的主题）
  await evaluate(`document.querySelector('button[aria-label="返回数据设置"]')?.click()`);
  await sleep(200);
  const beforeThemes = await evaluate(`__themeStore.getState().themes.length`);
  await evaluate(`__importStore.getState().enqueue(["批量甲.zip", "批量乙.zip"])`);
  await sleep(400);
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "开始导入");
    btn?.click();
    return Boolean(btn);
  })()`);
  const importsDone = await waitFor(
    `(() => {
      const s = __importStore.getState();
      return !s.running && s.jobs.length === 2 && s.jobs.every(j => j.status === "success" || j.status === "failed");
    })()`,
    8000,
  );
  await evaluate(`__importStore.getState().closeCenter()`);
  await sleep(200);
  const minePage = await evaluate(`__themeStore.getState().setCurrentPage("mine") ?? true`);
  await sleep(300);
  const hasBar = await evaluate(
    `Boolean(document.querySelector("[data-export-all-bar] [data-export-all]"))`,
  );
  assert("导入两套后「我的主题」出现导出全部", importsDone && minePage && hasBar);
  await evaluate(`document.querySelector("[data-export-all]").click()`);
  const exportDone = await waitFor(
    `(() => {
      const s = __themeStore.getState();
      return !s.busy["export:all"] && s.exportAllProgress === null && document.body.textContent.includes("已导出 2 套主题");
    })()`,
    6000,
  );
  assert("批量导出完成并提示成功套数", exportDone);
  const afterThemes = await evaluate(`__themeStore.getState().themes.length`);
  assert("导出不改变主题列表", afterThemes === beforeThemes + 2, `${beforeThemes} -> ${afterThemes}`);

  // --------------------------------------------------- 4. 清空使用记录
  await openDataMain();
  await evaluate(`document.querySelector("[data-clear-history]").click()`);
  await sleep(300);
  const confirmShown = await evaluate(
    `Boolean(document.querySelector("[data-confirm-clear-history]"))`,
  );
  assert("清空使用记录弹出确认框", confirmShown);
  await evaluate(`document.querySelector("[data-confirm-clear-history]").click()`);
  const cleared = await waitFor(`__themeStore.getState().recent.length === 0`);
  const clearToast = await waitFor(
    `document.body.textContent.includes("已清空") || document.body.textContent.includes("没有可清空")`,
  );
  assert("确认后使用记录清空并有提示", cleared && clearToast);
  await evaluate(`__themeStore.getState().setCurrentPage("recent")`);
  await sleep(300);
  const recentEmpty = JSON.parse(
    await evaluate(`JSON.stringify({
      rows: document.querySelectorAll("[data-recent-row]").length,
      empty: document.body.textContent.includes("还没有使用记录"),
    })`),
  );
  assert("「最近使用」页随之变空", recentEmpty.rows === 0 && recentEmpty.empty, JSON.stringify(recentEmpty));

  // --------------------------------------------------- 5. 运行期无 JS 异常
  assert("运行期无 JS 异常", pageErrors.length === 0, `errors=${pageErrors.length}`);

  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "maintenance_page.png"), Buffer.from(png.result.data, "base64"));

  const failedCount = results.filter((ok) => !ok).length;
  console.log(`\n[维护工具箱] ${results.length - failedCount}/${results.length} 通过`);
  process.exitCode = failedCount > 0 ? 1 : 0;
} finally {
  edge.kill();
}
