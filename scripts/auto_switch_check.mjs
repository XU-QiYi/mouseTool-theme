// 自动切换主题验收：跟随系统深浅色应用配对主题 / 还原默认挂起 / 关开关后不动
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。浏览器里 apply 走 mock，不写系统光标。
// - 设置 → 通用：开关与两个映射下拉随状态渲染
// - 开启并配对 → 系统深浅色翻转（CDP 模拟）→ 自动应用对应主题
// - 还原默认 → 挂起（不被立刻覆盖）；下次深浅色翻转恢复接管
// - 关闭开关 → 深浅色翻转不再切
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT_DIR = process.env.TEMP ?? ".";
const PORT = 9233;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(OUT_DIR, "edge_auto_switch_profile"),
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
  await send("Page.navigate", { url: URL_TO_OPEN });
  await sleep(1500);

  const evaluate = async (expression, awaitPromise = false) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (res.result?.exceptionDetails) {
      throw new Error(`页面执行失败：${JSON.stringify(res.result.exceptionDetails.exception)}`);
    }
    return res.result?.result?.value;
  };

  // 等设置与主题列表都就绪，不然自动切换的首次评估会踩在空列表上
  // （用 globalThis 属性访问：模块还没执行时拿 undefined 而不是 ReferenceError）
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate(
      `Boolean(globalThis.__settingsStore?.getState()?.settings && globalThis.__themeStore && !globalThis.__themeStore.getState().loading)`,
    );
    if (ready) break;
    await sleep(250);
  }

  // --- 1. 设置页结构：开关默认关，两个映射下拉存在 ---
  await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
  await sleep(300);
  const toggleUnchecked = await evaluate(
    `document.querySelector('[role="switch"][aria-label="跟随系统切换主题"]')?.getAttribute('aria-checked')`,
  );
  assert("设置页有开关且默认关闭", toggleUnchecked === "false", String(toggleUnchecked));
  const selects = await evaluate(
    `['系统浅色时用','系统深色时用'].map(l => Boolean(document.querySelector(\`[data-auto-switch-select="\${l}"]\`)))`,
  );
  assert("两个映射下拉都存在", selects[0] === true && selects[1] === true);

  // --- 2. UI 点开关 → 状态进 store ---
  await evaluate(
    `document.querySelector('[role="switch"][aria-label="跟随系统切换主题"]').click()`,
  );
  await sleep(300);
  const enabledInStore = await evaluate(
    `__settingsStore.getState().settings?.auto_switch_enabled`,
  );
  assert("点开关后 store 记下开启", enabledInStore === true, String(enabledInStore));

  // --- 3. 配对映射：浅色 = Windows 默认，深色 = firefly；当前浅色 → 自动应用浅色主题 ---
  await evaluate(
    `__settingsStore.getState().patchSettings({
        auto_switch_light_id: "sys_windows_default",
        auto_switch_dark_id: "sys_firefly",
      })`,
    true,
  );
  await sleep(400);
  const activeAfterEnable = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("浅色系统自动应用浅色映射主题", activeAfterEnable === "sys_windows_default", String(activeAfterEnable));
  const selectValue = await evaluate(
    `document.querySelector('[data-auto-switch-select="系统浅色时用"]')?.value`,
  );
  assert("下拉反映已存的映射", selectValue === "sys_windows_default", String(selectValue));

  // --- 4. 系统翻转成深色 → 自动切到深色映射 ---
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await sleep(400);
  const activeInDark = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("系统转深色自动切到深色映射主题", activeInDark === "sys_firefly", String(activeInDark));

  // --- 5. 翻回浅色 → 自动切回 ---
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await sleep(400);
  const activeBackInLight = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("系统转回浅色自动切回", activeBackInLight === "sys_windows_default", String(activeBackInLight));

  // --- 6. 还原默认 → 挂起：自动切换不能立刻覆盖回去 ---
  await evaluate(`__themeStore.getState().restoreDefault()`, true);
  await sleep(500);
  const suspendedActive = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("还原默认后不被自动切换覆盖", suspendedActive === null, String(suspendedActive));

  // --- 7. 系统再次翻转 → 挂起解除，接管 ---
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await sleep(400);
  const resumedActive = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("深浅色再次翻转后恢复接管", resumedActive === "sys_firefly", String(resumedActive));

  // --- 8. 关开关 → 翻转不再切 ---
  await evaluate(
    `__settingsStore.getState().patchSettings({ auto_switch_enabled: false })`,
    true,
  );
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await sleep(400);
  const activeAfterDisable = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("关闭开关后翻转不再切", activeAfterDisable === "sys_firefly", String(activeAfterDisable));

  // --- 9. 运行期无 JS 异常 ---
  assert("运行期无 JS 异常", pageErrors.length === 0, `errors=${pageErrors.length}`);

  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "auto_switch_page.png"), Buffer.from(png.result.data, "base64"));

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n[自动切换] ${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed > 0 ? 1 : 0;
} finally {
  edge.kill();
}
