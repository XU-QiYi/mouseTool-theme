// 主题文件完整性验收（决策 31）：行内提示 / 检查器警示条 / 诊断第五项（浏览器 mock 链路）
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
import { spawn } from "node:child_process";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9243;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_integrity_profile",
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
  const waitReady = async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(300);
      if (await evaluate(`Boolean(window.__toast && window.__themeStore)`).catch(() => false)) return;
    }
    throw new Error("页面没有就绪");
  };

  await send("Page.enable");
  await send("Runtime.enable");

  /** 进设置 → 数据 → 打开诊断弹窗，返回五项检查的 id/严重度与文件完整性项的摘要 */
  const openDiagnostics = async () => {
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "设置");
      btn?.click();
      return true;
    })()`);
    await sleep(400);
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "数据");
      btn?.click();
      return true;
    })()`);
    await sleep(400);
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("运行诊断"));
      btn?.click();
      return true;
    })()`);
    await sleep(600);
    const raw = await evaluate(`(() => {
      const dialog = document.querySelector("[data-diagnostics-dialog]");
      return JSON.stringify({
        open: Boolean(dialog),
        checks: [...dialog?.querySelectorAll("[data-diagnostic-check]") ?? []].map((el) => ({
          id: el.getAttribute("data-diagnostic-check"),
          severity: el.getAttribute("data-diagnostic-severity"),
        })),
        gapsText: dialog?.textContent.includes("套主题的光标文件缺失") ?? false,
        allFineText: dialog?.textContent.includes("全部主题的光标文件都在") ?? false,
      });
    })()`);
    return JSON.parse(raw);
  };

  /** 点进某一项检查，返回详情面板的文本 */
  const openCheck = async (checkId) => {
    await evaluate(`(() => {
      const item = document.querySelector('[data-diagnostic-check="${checkId}"]');
      item?.click();
      return true;
    })()`);
    await sleep(300);
    return evaluate(`document.querySelector("[data-diagnostics-dialog]")?.textContent ?? ""`);
  };

  const pressEsc = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    }
    await sleep(300);
  };

  const goMine = async () => {
    // 侧栏按钮的 textContent 带计数徽标（「我的主题2」），按文本等值匹配会落空；
    // 页面切换本身由 nav_check 验收，这里直接走 store action 保证确定到达
    await evaluate(`window.__themeStore.getState().setCurrentPage("mine")`);
    await sleep(400);
  };

  const myThemesSnapshot = () =>
    evaluate(`JSON.stringify({
      rows: document.querySelectorAll("[data-theme-row]").length,
      gaps: [...document.querySelectorAll("[data-gap-hint]")].map((el) => el.textContent.trim()),
      storeGaps: window.__themeStore.getState().fileGaps,
    })`).then((raw) => JSON.parse(raw));

  // ---------------------------------------------------------------- 正常态：没有缺口
  await send("Page.navigate", { url: "http://localhost:1420/" });
  await waitReady();
  await goMine();
  const plain = await myThemesSnapshot();
  check("正常态：我的主题行没有缺口提示", plain.rows > 0 && plain.gaps.length === 0, JSON.stringify(plain.gaps));
  check("正常态：store 的 fileGaps 为空数组", Array.isArray(plain.storeGaps) && plain.storeGaps.length === 0);

  const plainDiag = await openDiagnostics();
  check(
    "诊断弹窗包含文件完整性检查",
    plainDiag.open && plainDiag.checks.some((c) => c.id === "file-gaps"),
    plainDiag.checks.map((c) => c.id).join(","),
  );
  check(
    "五项检查齐全（数据目录/主题/当前使用/设置/文件完整性）",
    ["data-dir", "themes", "active", "settings", "file-gaps"].every((key) =>
      plainDiag.checks.some((c) => c.id === key),
    ),
  );
  check("正常态：文件完整性显示「正常」", plainDiag.checks.find((c) => c.id === "file-gaps")?.severity === "ok");
  check("正常态：摘要为「全部主题的光标文件都在」", plainDiag.allFineText && !plainDiag.gapsText);
  const plainDetail = await openCheck("file-gaps");
  check("正常态：详情说明只查存在性", plainDetail.includes("只查存在性"));
  await pressEsc();

  // ---------------------------------------------------------------- 缺口态：?mock-broken-files=1
  await send("Page.navigate", { url: "http://localhost:1420/?mock-broken-files=1" });
  await waitReady();
  await goMine();
  const broken = await myThemesSnapshot();
  check("缺口态：行内出现「缺 2 个文件」提示", broken.gaps.length === 1 && broken.gaps[0] === "缺 2 个文件", JSON.stringify(broken.gaps));
  check("缺口态：store 收到对应主题的缺口清单", broken.storeGaps.length === 1 && broken.storeGaps[0].slots.length === 2, JSON.stringify(broken.storeGaps));

  // 选中缺口主题：检查器头部出现警示条，点名中文名而不是注册表键
  await evaluate(`(() => {
    const row = document.querySelector("[data-theme-row]");
    row?.querySelector("button")?.click();
    return true;
  })()`);
  await sleep(400);
  const inspector = await evaluate(`(() => {
    const strip = document.querySelector("[data-missing-files]");
    return JSON.stringify({ exists: Boolean(strip), text: strip?.textContent ?? "" });
  })()`).then((raw) => JSON.parse(raw));
  check("检查器出现文件缺口警示条", inspector.exists);
  check(
    "警示条写后果并点名槽位中文名",
    inspector.text.includes("应用后这些槽位会被写成空") &&
      inspector.text.includes("正常选择") &&
      inspector.text.includes("忙"),
    inspector.text.slice(0, 60),
  );

  const brokenDiag = await openDiagnostics();
  check(
    "缺口态：文件完整性显示「注意」",
    brokenDiag.checks.find((c) => c.id === "file-gaps")?.severity === "warning",
  );
  check("缺口态：摘要提到缺失主题数", brokenDiag.gapsText);
  const brokenDetail = await openCheck("file-gaps");
  check("缺口态：详情点名「Neon Night」", brokenDetail.includes("Neon Night"), "");
  check("缺口态：详情给出处理建议", brokenDetail.includes("重新导入"));
  await pressEsc();

  check("运行期无 JS 异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

  ws.close();
} finally {
  edge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[主题文件完整性] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
