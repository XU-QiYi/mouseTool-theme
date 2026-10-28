// 保存当前光标验收：外部改写态 → 保存并应用 → 收编为我的主题（浏览器 mock 链路）
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9236;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_capture_profile",
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
  await send("Page.navigate", { url: "http://localhost:1420/?mock-external=1" });
  await waitReady();

  // ---------------------------------------------------------------- 外部改写态
  const initial = JSON.parse(
    await evaluate(`(() => {
      const state = window.__themeStore.getState();
      return JSON.stringify({
        activeExternal: state.activeExternal,
        activeThemeId: state.activeThemeId,
        filled: state.currentSlotsFilled,
        themes: state.themes.length,
        card: document.querySelector("aside")?.textContent ?? "",
        saveButton: [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "保存并应用"),
      });
    })()`),
  );
  check("初始为「被系统设置修改」态", initial.activeExternal === true && initial.activeThemeId === null, JSON.stringify(initial));
  check("状态卡显示外部改写与占用槽位", initial.card.includes("光标已被系统设置修改") && initial.card.includes("非本应用主题"), "");
  check("状态卡出现「保存并应用」入口", initial.saveButton === true);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = join(process.env.TEMP ?? ".", "capture_before.png");
  writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"));
  console.log(`screenshot: ${shotPath}`);

  // ---------------------------------------------------------------- 保存并应用
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "保存并应用");
    btn?.click();
    return Boolean(btn);
  })()`);
  check("点击保存入口", clicked);

  let settled = false;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const state = JSON.parse(
      await evaluate(`(() => {
        const s = window.__themeStore.getState();
        return JSON.stringify({ external: s.activeExternal, id: s.activeThemeId, themes: s.themes.length });
      })()`),
    );
    if (!state.external && state.id && state.themes === initial.themes + 1) {
      settled = true;
      break;
    }
  }
  check("保存后当前主题被接管", settled);

  const after = JSON.parse(
    await evaluate(`(() => {
      const s = window.__themeStore.getState();
      const saved = s.themes.find(t => t.id === s.activeThemeId);
      return JSON.stringify({
        activeThemeId: s.activeThemeId,
        savedName: saved?.name ?? null,
        savedBuiltIn: saved?.is_built_in ?? null,
        themeCount: s.themes.length,
        selectionGallery: s.selection.gallery,
        selectionMine: s.selection.mine,
        card: document.querySelector("aside")?.textContent ?? "",
        saveButton: [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "保存并应用"),
        toast: document.body.innerText.includes("已保存并应用"),
      });
    })()`),
  );
  check("新主题名为「当前光标 …」且为我的主题", Boolean(after.savedName?.startsWith("当前光标 ")) && after.savedBuiltIn === false, String(after.savedName));
  check("主题列表 +1", after.themeCount === initial.themes + 1, `${initial.themes} -> ${after.themeCount}`);
  check("保存的主题被选中在图库与我的主题", after.selectionGallery === after.activeThemeId && after.selectionMine === after.activeThemeId);
  check("状态卡切换到「当前使用中」", after.card.includes("当前使用中"), "");
  check("接管后保存入口消失", after.saveButton === false);
  check("成功提示说明已保存并应用", after.toast);

  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  const shotPath2 = join(process.env.TEMP ?? ".", "capture_after.png");
  writeFileSync(shotPath2, Buffer.from(shot2.result.data, "base64"));
  console.log(`screenshot: ${shotPath2}`);

  // ---------------------------------------------------------------- 普通态无入口
  await send("Page.navigate", { url: "http://localhost:1420" });
  await waitReady();
  const normal = await evaluate(`(() => {
    const state = window.__themeStore.getState();
    return JSON.stringify({
      external: state.activeExternal,
      saveButton: [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "保存并应用"),
    });
  })()`);
  const normalState = JSON.parse(normal);
  check("普通状态不出现保存入口", normalState.external === false && normalState.saveButton === false);

  check("运行期无 JS 异常", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));

  ws.close();
} finally {
  edge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[保存当前光标] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
