// 备份内容浏览与单主题恢复验收（决策 34，浏览器 mock 链路）
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
// 覆盖：备份历史 → 查看内容 → 已在主题库禁用 → 恢复一套 → 列表重读 → 重新打开仍显示已在库
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9232;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_headless_profile_backup",
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
      pageErrors.push(
        d.params?.exceptionDetails?.exception?.description ??
          d.params?.exceptionDetails?.text,
      );
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
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(
        res.result.exceptionDetails.exception?.description ?? "页面内执行失败",
      );
    }
    return res.result?.result?.value;
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
  await send("Page.navigate", { url: "http://localhost:1420/?mock-backup-partial=1" });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    if (await evaluate(`Boolean(window.__toast)`).catch(() => false)) break;
  }

  check("进入设置", await clickNav("设置"));
  check("进入「数据」分组", await clickNav("数据"));

  const openHistory = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "备份历史");
    btn?.click();
    return Boolean(btn);
  })()`);
  await sleep(700);
  check("进入备份历史", openHistory);

  const rowCount = await evaluate(
    `document.querySelectorAll("[data-backup-row]").length`,
  );
  check("mock 预置至少 2 份备份", rowCount >= 2, `${rowCount} 行`);

  const openContent = await evaluate(`(() => {
    const btn = document.querySelector('[aria-label^="查看备份"]');
    btn?.click();
    return Boolean(btn);
  })()`);
  check("备份行有「查看内容」入口", openContent);

  await sleep(600);
  const listing = JSON.parse(
    await evaluate(`(() => {
      const dialog = document.querySelector("[data-backup-content]");
      return JSON.stringify({
        open: Boolean(dialog),
        file: dialog?.querySelector("[data-backup-content-file]")?.textContent ?? null,
        count: dialog?.querySelector("[data-backup-content-count]")?.textContent ?? null,
        rows: [...dialog?.querySelectorAll("[data-backup-theme-row]") ?? []].map((row) => ({
          id: row.getAttribute("data-backup-theme-row"),
          state: row.getAttribute("data-backup-theme-state"),
          missing: row.getAttribute("data-backup-theme-missing"),
          text: row.textContent,
          buttons: [...row.querySelectorAll("button")].map((b) => b.textContent.trim()),
        })),
      });
    })()`),
  );

  check("打开备份内容弹窗", listing.open);
  check(
    "列出备份里的主题",
    listing.rows.length === 2,
    listing.rows.map((row) => row.id).join(","),
  );
  check(
    "内容计数正确",
    listing.count?.startsWith("2 套主题"),
    String(listing.count),
  );
  const local = listing.rows.find((row) => row.state === "local");
  const partial = listing.rows.find((row) => row.state === "partial");
  const restorable = listing.rows.find(
    (row) => row.state === "restorable" || row.state === "partial",
  );
  check("已有主题标为「已在主题库」", Boolean(local), local?.text ?? "缺失");
  check(
    "已在库的主题不提供恢复按钮",
    Boolean(local) && !local.buttons.some((text) => text.includes("恢复")),
    local?.buttons.join("/"),
  );
  check("存在只在该备份里的主题", Boolean(restorable), restorable?.text ?? "缺失");
  check(
    "缺文件主题标出缺口",
    Boolean(partial) && partial.missing === "1" && partial.text.includes("缺 1 个文件"),
    partial ? `${partial.state}/${partial.missing}/${partial.text}` : "缺失",
  );
  check(
    "恢复按钮存在",
    Boolean(restorable) && restorable.buttons.some((text) => text.includes("恢复")),
    restorable?.buttons.join("/"),
  );

  const restoreId = restorable?.id;
  if (restoreId) {
    const clicked = await evaluate(`(() => {
      const row = document.querySelector('[data-backup-theme-row="${restoreId}"]');
      const btn = [...row?.querySelectorAll("button") ?? []].find(b => b.textContent.includes("恢复"));
      btn?.click();
      return Boolean(btn);
    })()`);
    check("点击单主题恢复", clicked);

    let restored = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      restored = await evaluate(
        `window.__themeStore.getState().themes.some(t => t.id === "${restoreId}")`,
      );
      if (restored) break;
    }
    check("恢复后主题列表重读并包含该主题", restored);

    await sleep(400);
    const after = JSON.parse(
      await evaluate(`(() => {
        const row = document.querySelector('[data-backup-theme-row="${restoreId}"]');
        const state = window.__themeStore.getState();
        return JSON.stringify({
          rowState: row?.getAttribute("data-backup-theme-state") ?? null,
          gallery: state.selection.gallery,
          mine: state.selection.mine,
          search: state.searchQuery,
          toast: [...document.querySelectorAll('[data-slot="toast"]')]
            .map((item) => item.textContent)
            .join(" "),
        });
      })()`),
    );
    check("恢复后该行变为「已在主题库」", after.rowState === "local", String(after.rowState));
    check(
      "恢复缺文件主题时提示缺口",
      after.toast.includes("槽位文件缺失"),
      String(after.toast).slice(0, 160),
    );
    check(
      "恢复后在图库与我的主题里选中",
      after.gallery === restoreId && after.mine === restoreId,
      `${after.gallery}/${after.mine}`,
    );
    check("恢复后清空搜索词", after.search === "", JSON.stringify(after.search));

    const closed = await evaluate(`(() => {
      const dialog = document.querySelector("[data-backup-content]");
      const btn = [...dialog?.querySelectorAll("button") ?? []].find(b => b.textContent.trim() === "关闭");
      btn?.click();
      return Boolean(btn);
    })()`);
    await sleep(500);
    check("关闭备份内容弹窗", closed && !(await evaluate(`Boolean(document.querySelector("[data-backup-content]"))`)));

    const reopened = await evaluate(`(() => {
      const btn = document.querySelector('[aria-label^="查看备份"]');
      btn?.click();
      return Boolean(btn);
    })()`);
    await sleep(600);
    const reopenedState = await evaluate(
      `document.querySelector('[data-backup-theme-row="${restoreId}"]')?.getAttribute("data-backup-theme-state") ?? null`,
    );
    check("重新打开后恢复过的主题仍显示已在库", reopened && reopenedState === "local", String(reopenedState));
  }

  check("运行期无 JS 异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

  ws.close();
} finally {
  edge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[备份内容] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
