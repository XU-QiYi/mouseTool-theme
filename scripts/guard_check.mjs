// 光标守护验收：默认关 / 开启即恢复 / 启动恢复 / 外部改写恢复 / 手动还原不抢 /
// 关开关不动 / 手动立即恢复 / 自动切换优先 / 上次主题被删不瞎恢复 / 读取失败不动作
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。浏览器里 apply 走 mock，不写系统光标。
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT_DIR = process.env.TEMP ?? ".";
const PORT = 9236;

// 固定 profile 会让上一轮残留的「守护已开启」影响默认态断言：每轮都清一次；
// 清不掉（上一轮 Edge 还没退干净）就另起一个，别拿脏设置跑默认态断言
let PROFILE = join(OUT_DIR, "edge_guard_profile");
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  PROFILE = join(OUT_DIR, `edge_guard_profile_${process.pid}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEON = "9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"; // MOCK_RECENT[0] 的主题 ID

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

  const waitFor = async (expression, timeoutMs = 3000) => {
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

  await goto(URL_TO_OPEN);

  // --- 1. 设置页：守护开关存在且默认关闭，状态行指出可恢复的最近主题 ---
  await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
  await evaluate(`__themeStore.getState().setSettingsSection("general")`);
  await sleep(300);
  const toggleDefault = await evaluate(
    `document.querySelector('[role="switch"][aria-label="光标守护"]')?.getAttribute('aria-checked')`,
  );
  assert("设置页有守护开关且默认关闭", toggleDefault === "false", String(toggleDefault));
  const statusText = await evaluate(
    `document.querySelector('[data-guard-status]')?.textContent ?? ""`,
  );
  assert(
    "状态行指出可恢复的最近主题",
    statusText.includes("Neon Night") && statusText.includes("可恢复"),
    statusText,
  );

  // --- 2. UI 点开关 → 立即恢复上次主题（系统默认态也恢复，这是开关的承诺） ---
  await evaluate(`document.querySelector('[role="switch"][aria-label="光标守护"]').click()`);
  const enabled = await waitFor(`__settingsStore.getState().settings?.cursor_guard_enabled === true`);
  const restored = await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);
  assert("点开关后开关注入 settings.json", enabled);
  assert("开启守护后立即恢复上次主题", restored, String(await evaluate(`__themeStore.getState().activeThemeId`)));
  const toastText = await evaluate(
    `[...document.querySelectorAll('[data-slot="toast"]')].map(t => t.textContent).join(" ")`,
  );
  assert("自动恢复有明确提示", toastText.includes("光标守护"), toastText);

  // --- 3. 重载：devActive 归零，守护的启动检查应把上次主题恢复回来 ---
  await goto(URL_TO_OPEN);
  const startupRestored = await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);
  assert(
    "重载后启动检查恢复上次主题",
    startupRestored,
    String(await evaluate(`__themeStore.getState().activeThemeId`)),
  );

  // --- 4. 模拟聚焦发现外部改写：槽位非空但认不出主题 → 自动夺回 ---
  await evaluate(
    `__themeStore.setState({ activeThemeId: null, activeExternal: true, currentSlotsFilled: 13 })`,
  );
  const reclaimed = await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);
  assert(
    "外部改写触发自动恢复",
    reclaimed && !(await evaluate(`__themeStore.getState().activeExternal`)),
    String(await evaluate(`__themeStore.getState().activeThemeId`)),
  );

  // --- 5. 手动还原默认：运行期不碰系统默认，不能被守护立刻抢回 ---
  await evaluate(`__themeStore.getState().restoreDefault()`, true);
  await sleep(700);
  const afterRestore = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("手动还原默认不被立刻抢回", afterRestore === null, String(afterRestore));

  // --- 6. 下一轮外部改写仍能接管 ---
  await evaluate(
    `__themeStore.setState({ activeThemeId: null, activeExternal: true, currentSlotsFilled: 13 })`,
  );
  const reclaimedAgain = await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);
  assert("下一轮外部改写重新接管", reclaimedAgain);

  // --- 7. 关闭开关 → 外部改写不再自动恢复 ---
  await evaluate(
    `__settingsStore.getState().patchSettings({ cursor_guard_enabled: false })`,
    true,
  );
  await evaluate(
    `__themeStore.setState({ activeThemeId: null, activeExternal: true, currentSlotsFilled: 13 })`,
  );
  await sleep(700);
  const afterDisable = await evaluate(
    `JSON.stringify({ id: __themeStore.getState().activeThemeId, external: __themeStore.getState().activeExternal })`,
  );
  assert("关闭守护后外部改写不动", afterDisable === `{"id":null,"external":true}`, afterDisable);

  // --- 8. 手动「立即恢复」不依赖开关；开关关着也能救一次 ---
  // 先把 mock 的「注册表状态」也清成系统默认，否则手动路径的 fresh 重查
  // 会看到上一轮应用过的主题，正确地选择不动（那会测不到手动入口）
  await evaluate(`__themeStore.getState().restoreDefault()`, true);
  await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
  await evaluate(`__themeStore.getState().setSettingsSection("general")`);
  await sleep(300);
  const clicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "立即恢复");
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);
  const manualRestored = await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);
  assert("手动立即恢复不依赖开关", clicked && manualRestored);

  // --- 9. 自动切换开启时，守护优先恢复当前深浅色的配对主题（不是历史里最后一条） ---
  await evaluate(
    `__settingsStore.getState().patchSettings({
        cursor_guard_enabled: true,
        auto_switch_enabled: true,
        auto_switch_light_id: "sys_windows_default",
        auto_switch_dark_id: "sys_firefly",
      })`,
    true,
  );
  await waitFor(`__themeStore.getState().activeThemeId === "sys_windows_default"`);
  // 把历史伪造成 Neon Night，外部改写后仍应选配对主题，证明优先级不是「最后一条」
  await evaluate(`__themeStore.setState({
      recent: [{
        theme_id: "${NEON}",
        name: "Neon Night",
        is_built_in: false,
        applied_at: "2026-10-28 09:12",
      }],
      activeThemeId: null,
      activeExternal: true,
      currentSlotsFilled: 13,
    })`);
  const prefersMapping = await waitFor(
    `__themeStore.getState().activeThemeId === "sys_windows_default"`,
  );
  assert(
    "自动切换开启时优先恢复配对主题",
    prefersMapping,
    String(await evaluate(`__themeStore.getState().activeThemeId`)),
  );

  // --- 10. 上次使用的主题已被删除：不拿别的主题顶替，手动入口禁用 ---
  await evaluate(
    `__settingsStore.getState().patchSettings({ auto_switch_enabled: false })`,
    true,
  );
  await evaluate(`__themeStore.setState({
      recent: [{
        theme_id: "6b1f0c44-2d95-4a37-8f18-0c9d2e5b7a90",
        name: "Midnight Blue",
        is_built_in: false,
        applied_at: "2026-10-28 10:05",
      }],
      activeThemeId: null,
      activeExternal: true,
      currentSlotsFilled: 13,
    })`);
  await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
  await evaluate(`__themeStore.getState().setSettingsSection("general")`);
  await sleep(500);
  const missingState = await evaluate(`JSON.stringify({
      id: __themeStore.getState().activeThemeId,
      status: document.querySelector("[data-guard-status]")?.textContent ?? "",
      buttonDisabled: [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "立即恢复")?.disabled,
    })`);
  const missing = JSON.parse(missingState);
  assert("上次主题被删除时不瞎恢复", missing.id === null, missingState);
  assert("状态行说明无法恢复", missing.status.includes("已不在主题库"), missing.status);
  assert("没有目标时手动入口禁用", missing.buttonDisabled === true, String(missing.buttonDisabled));

  // --- 11. 主题列表读取失败：守护不拿空列表去猜，页面照常给出错误态与重试 ---
  const failUrl = new URL(URL_TO_OPEN);
  failUrl.searchParams.set("mock-fail", "");
  await goto(failUrl.toString());
  await sleep(700);
  const failedState = await evaluate(`JSON.stringify({
      errorState: Boolean(document.querySelector("[data-error-state]")),
      active: __themeStore.getState().activeThemeId,
    })`);
  const failed = JSON.parse(failedState);
  assert("读取失败时显示错误态", failed.errorState === true, failedState);
  assert("读取失败时守护不动作", failed.active === null, failedState);
  await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
  await evaluate(`__themeStore.getState().setSettingsSection("general")`);
  await sleep(300);
  const failedGuard = await evaluate(`JSON.stringify({
      status: document.querySelector("[data-guard-status]")?.textContent ?? "",
      buttonDisabled: [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "立即恢复")?.disabled,
    })`);
  const fg = JSON.parse(failedGuard);
  assert("读取失败时状态行说明原因", fg.status.includes("读取失败"), failedGuard);
  assert("读取失败时手动入口禁用", fg.buttonDisabled === true, String(fg.buttonDisabled));

  // --- 12. 运行期无 JS 异常 ---
  assert("运行期无 JS 异常", pageErrors.length === 0, `errors=${pageErrors.length}`);

  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "guard_page.png"), Buffer.from(png.result.data, "base64"));

  const failedCount = results.filter((ok) => !ok).length;
  console.log(`\n[光标守护] ${results.length - failedCount}/${results.length} 通过`);
  process.exitCode = failedCount > 0 ? 1 : 0;
} finally {
  edge.kill();
}
