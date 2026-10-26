// 主题存储目录迁移验收：确认框信息、执行中锁定、进度、成功、失败回滚、预检报错
// 用法：node scripts/dev_bg.mjs start; node scripts/migration_check.mjs; node scripts/dev_bg.mjs stop
//      （必须与 dev server 写在同一条命令里，跨命令的 vite 会被回收）
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://localhost:1420";
const PORT = 9227;
const SHOT_DIR = join(process.cwd(), "docs", "screenshots");
const TARGET_OK = "D:/Cursors/Migrated";
const TARGET_ROLLBACK = "D:/Cursors/Rollback";
const DEFAULT_DIR = "C:\\Users\\demo\\AppData\\Local\\CursorStudio\\themes";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(process.env.TEMP ?? ".", "edge_migration_profile"),
  "about:blank",
]);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? `  ${detail}` : ""}`);
};

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
      const desc =
        d.params?.exceptionDetails?.exception?.description ?? d.params?.exceptionDetails?.text;
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
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.result?.exceptionDetails) {
      return "ERR: " + (r.result.exceptionDetails.exception?.description ?? "unknown");
    }
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  mkdirSync(SHOT_DIR, { recursive: true });

  const openSettings = async () => {
    const ok = await evaluate(`(() => {
      const btn = [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().startsWith("设置"));
      btn?.click();
      return !!btn;
    })()`);
    await sleep(500);
    return ok;
  };

  const openDialog = async (target) => {
    const value = target === null ? "null" : JSON.stringify(target);
    return evaluate(
      `(() => { window.__settingsStore.getState().openThemesDirDialog(${value}); return true; })()`,
    );
  };

  const clickDialogButton = (label) =>
    evaluate(`(() => {
      const btn = [...document.querySelectorAll("[data-themes-dir-dialog] button")]
        .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      btn?.click();
      return !!btn;
    })()`);

  const dialogState = () =>
    evaluate(`(() => {
      const dialog = document.querySelector("[data-themes-dir-dialog]");
      const bar = dialog?.querySelector('[role="progressbar"]');
      return {
        open: !!dialog,
        source: dialog?.querySelector("[data-migration-source]")?.textContent?.trim() ?? null,
        target: dialog?.querySelector("[data-migration-target]")?.textContent?.trim() ?? null,
        stats: dialog?.querySelector("[data-migration-stats]")?.textContent?.trim() ?? null,
        error: dialog?.querySelector("[data-migration-error]")?.textContent?.trim() ?? null,
        progress: dialog?.querySelector("[data-migration-progress]")?.getAttribute("data-migration-progress") ?? null,
        percent: bar?.getAttribute("aria-valuenow") ?? null,
        buttons: [...(dialog?.querySelectorAll("button") ?? [])].map((b) => ({
          text: b.textContent.trim(),
          disabled: b.disabled,
        })),
      };
    })()`);

  const storeState = () =>
    evaluate(`(() => {
      const s = window.__settingsStore.getState();
      return {
        open: s.themesDirOpen,
        busy: s.themesDirBusy,
        stored: s.settings?.themes_dir ?? null,
        effective: s.settings?.effective_themes_dir ?? null,
        error: s.themesDirError,
      };
    })()`);

  const screenshot = (name) => send("Page.captureScreenshot", { format: "png" }).then((shot) => {
    const out = join(SHOT_DIR, name);
    writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    return out;
  });

  await send("Page.navigate", { url: BASE });
  await sleep(2500);
  // 从干净状态开始：localStorage 可能留着上一次验收的迁移结果
  await evaluate(`localStorage.clear(); location.reload(); "ok"`);
  await sleep(2200);
  check("设置页可进入", (await openSettings()) === true);

  // 1. 确认框：源、目标、数量、体积
  await openDialog(TARGET_OK);
  await sleep(500);
  const plan = await dialogState();
  check("确认框打开并显示源目录", plan.open && (plan.source ?? "").includes("CursorStudio"), plan.source);
  check("确认框显示目标目录", plan.target === TARGET_OK, plan.target);
  check(
    "确认框显示主题数量与体积",
    !!plan.stats && plan.stats.includes("套主题") && plan.stats.includes("个文件") && /(B|KB|MB)$/.test(plan.stats),
    plan.stats,
  );
  check("预检成功时没有错误提示", plan.error === null);
  const shot1 = await screenshot("migration-dialog.png");

  // 2. 执行中：进度可见、按钮锁定
  const started = await clickDialogButton("开始迁移");
  check("可以开始迁移", started === true);
  await sleep(160);
  const busy = await dialogState();
  check("执行中显示进度条", !!busy.progress && Number(busy.percent) > 0, `${busy.progress} ${busy.percent}%`);
  check(
    "执行中锁住操作（只剩禁用的「迁移中…」）",
    busy.buttons.length === 1 && busy.buttons[0].disabled && busy.buttons[0].text.includes("迁移中"),
    JSON.stringify(busy.buttons),
  );
  const shot2 = await screenshot("migration-progress.png");

  // 3. 成功：对话框关闭、设置与目录一起切换
  let after = null;
  for (let i = 0; i < 30; i++) {
    await sleep(120);
    after = await storeState();
    if (!after.open && !after.busy) break;
  }
  check("迁移完成后对话框关闭", after && after.open === false, JSON.stringify(after));
  check("迁移后主题目录指向新位置", after?.effective === TARGET_OK, after?.effective);
  check("迁移后设置里记下自定义目录", after?.stored === TARGET_OK, after?.stored);
  check("迁移后不残留错误", after?.error === null);

  // 4. 失败回滚：设置写入失败，对话框保留、可重试
  await send("Page.navigate", { url: `${BASE}/?mock-migrate-fail=settings` });
  await sleep(2200);
  await openSettings();
  await openDialog(TARGET_ROLLBACK);
  await sleep(500);
  const rollbackPlan = await dialogState();
  check("失败场景的预检正常", rollbackPlan.error === null, rollbackPlan.error);
  await clickDialogButton("开始迁移");
  await sleep(1000);
  const failed = await dialogState();
  const failedStore = await storeState();
  check("失败后对话框保留并说明原因", failed.open && (failed.error ?? "").includes("回滚"), failed.error);
  check("失败后恢复可操作（重试 / 关闭）", failed.buttons.some((b) => b.text === "重试迁移" && !b.disabled));
  check("失败后设置仍指向原目录", failedStore.effective === TARGET_OK, failedStore.effective);
  const shot3 = await screenshot("migration-error.png");

  const closed = await clickDialogButton("关闭");
  await sleep(300);
  check("失败后可以关闭对话框", closed && !(await dialogState()).open);

  // 5. 预检失败：目标不合法时直接给出原因，不给「开始迁移」
  await send("Page.navigate", { url: `${BASE}/?mock-migrate-error` });
  await sleep(2200);
  await openSettings();
  await openDialog("D:/Cursors/Conflict");
  await sleep(500);
  const rejected = await dialogState();
  check(
    "预检失败显示原因且不能开始迁移",
    rejected.open && (rejected.error ?? "").includes("同名主题") && !rejected.buttons.some((b) => b.text === "开始迁移"),
    JSON.stringify({ error: rejected.error, buttons: rejected.buttons }),
  );
  check("预检失败提供重新检查", rejected.buttons.some((b) => b.text === "重新检查"));

  // 恢复默认的预检：目标应是默认目录（先离开 mock-migrate-error）
  await send("Page.navigate", { url: BASE });
  await sleep(2200);
  await openSettings();
  await openDialog(null);
  await sleep(500);
  const defaultPlan = await dialogState();
  check("恢复默认的预检目标是默认目录", defaultPlan.target === DEFAULT_DIR, defaultPlan.target);

  console.log("\n截图:");
  for (const shot of [shot1, shot2, shot3]) console.log("  " + shot);

  await evaluate(`localStorage.clear(); "ok"`);
  ws.close();
  if (results.some((r) => !r.ok)) process.exitCode = 1;
} finally {
  edge.kill();
}
