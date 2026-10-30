// 定时切换主题验收（决策 33）：默认关 / 全日窗口命中期间内主题 / 空串=清空 /
// 手动还原默认挂起、改设置解除 / 跨零点窗口判定 / 时间段内深浅色切换让位、
// 关掉定时切换后深浅色接管。前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
// 浏览器里 apply 走 mock，不写系统光标。
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT_DIR = process.env.TEMP ?? ".";
const PORT = 9238;

let PROFILE = join(OUT_DIR, "edge_schedule_profile");
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  PROFILE = join(OUT_DIR, `edge_schedule_profile_${process.pid}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEON = "9f2c1a30-7b4e-4c1d-8e55-2a6b7c901d11"; // MOCK_RECENT[0] 的主题 ID

// 与页面 isScheduleInWindow 同一条规则：跨零点窗口（22:00–06:00）当前是否命中
const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
const crossMidnightHit = nowMin >= 22 * 60 || nowMin < 6 * 60;

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

  const waitFor = async (expression, timeoutMs = 4000) => {
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

  const patch = (expression) => evaluate(expression, true);

  await goto(URL_TO_OPEN);

  // --- 1. 设置 → 通用：定时切换开关默认关闭，窗口状态行存在 ---
  await evaluate(`__themeStore.getState().setCurrentPage("settings")`);
  await evaluate(`__themeStore.getState().setSettingsSection("general")`);
  await sleep(300);
  const toggleDefault = await evaluate(
    `document.querySelector('[role="switch"][aria-label="定时切换主题"]')?.getAttribute('aria-checked')`,
  );
  assert("设置页有定时切换开关且默认关闭", toggleDefault === "false", String(toggleDefault));
  const timeInputs = await evaluate(
    `Boolean(document.querySelector('[data-schedule-start]')) && Boolean(document.querySelector('[data-schedule-end]'))`,
  );
  assert("时间段起止输入框存在", timeInputs === true);
  const windowText = await evaluate(
    `document.querySelector('[data-schedule-window]')?.textContent ?? ""`,
  );
  assert(
    "窗口状态行给出时间段内 / 外的判定",
    windowText.includes("时间段内") || windowText.includes("时间段外"),
    windowText,
  );

  // --- 2. 全日窗口：期间内主题被自动应用 ---
  await patch(
    `__settingsStore.getState().patchSettings({
      schedule_switch_enabled: true,
      schedule_start: "00:00",
      schedule_end: "23:59",
      schedule_in_id: "${NEON}",
      schedule_out_id: "",
    })`,
  );
  const applied = await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);
  assert("全日窗口命中期间内主题", applied, String(await evaluate(`__themeStore.getState().activeThemeId`)));
  const windowText2 = await evaluate(
    `document.querySelector('[data-schedule-window]')?.textContent ?? ""`,
  );
  assert("状态行判定为时间段内", windowText2.includes("时间段内"), windowText2);
  const toastText = await evaluate(
    `[...document.querySelectorAll('[data-slot="toast"]')].map(t => t.textContent).join(" ")`,
  );
  assert("自动应用有明确提示", toastText.includes("已应用"), toastText.slice(0, 60));

  // --- 2.5 启动竞态回归：settings 先就绪而主题列表还空时，首次评估不得被吞 ---
  // 真机上 settings（单文件）几乎总是先于 themes（目录扫描）就绪。曾有缺陷：
  // 空列表下 applyTheme 静默 no-op 却照常把 lastAppliedId 记上，列表就绪后的
  // 评估被去重挡住，「启动后的首次评估」永远不生效。修复后：空列表退避不记账，
  // 列表到位时的订阅回调会补上这次应用。
  const savedThemes = await evaluate(`JSON.stringify(__themeStore.getState().themes)`);
  await evaluate(`__themeStore.setState({ themes: [] })`);
  await patch(`__settingsStore.getState().patchSettings({ schedule_in_id: "sys_firefly" })`);
  await sleep(400);
  const idleWhileEmpty = await evaluate(`__themeStore.getState().activeThemeId`);
  assert(
    "列表未就绪时不抢跑也不记账",
    idleWhileEmpty === NEON,
    String(idleWhileEmpty),
  );
  await evaluate(
    `__themeStore.setState({ themes: JSON.parse(${JSON.stringify(savedThemes)}) })`,
  );
  const appliedAfterList = await waitFor(
    `__themeStore.getState().activeThemeId === "sys_firefly"`,
  );
  assert(
    "列表就绪后补上首次应用",
    appliedAfterList,
    String(await evaluate(`__themeStore.getState().activeThemeId`)),
  );
  await patch(`__settingsStore.getState().patchSettings({ schedule_in_id: "${NEON}" })`);
  // 等这次应用落定，别把在途的 apply 带进第 4 步的还原默认
  await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);

  // --- 3. 期间内主题设空串 = 清空（与深浅色映射同一语义） ---
  await patch(`__settingsStore.getState().patchSettings({ schedule_in_id: "" })`);
  const cleared = await evaluate(
    `__settingsStore.getState().settings?.schedule_in_id`,
  );
  assert("空串把期间内主题清成 null", cleared === null, String(cleared));
  await patch(`__settingsStore.getState().patchSettings({ schedule_in_id: "${NEON}" })`);

  // --- 4. 手动还原默认：挂起，不被立刻抢回；改设置后解除 ---
  await evaluate(`__themeStore.getState().restoreDefault()`, true);
  await sleep(700);
  const afterRestore = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("手动还原默认不被定时切换抢回", afterRestore === null, String(afterRestore));
  await patch(`__settingsStore.getState().patchSettings({ schedule_switch_enabled: false })`);
  await sleep(400);
  const stillDefault = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("开关关着不动作", stillDefault === null, String(stillDefault));
  await patch(`__settingsStore.getState().patchSettings({ schedule_switch_enabled: true })`);
  const reApplied = await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);
  assert("改设置解除挂起后重新应用期间内主题", reApplied);

  // --- 5. 跨零点窗口（22:00–06:00）：按当前时刻判定命中与否 ---
  // 不派发 focus：focus 会顺带触发 App 的 refreshActive()，把 mock 里最后一次
  // 应用写回 activeThemeId，覆盖本用例刚复位好的「系统默认」前提。设置补丁
  // 本身就会触发定时切换评估，足够验证窗口判定。
  await patch(
    `__settingsStore.getState().patchSettings({ auto_switch_enabled: false, auto_switch_light_id: "", auto_switch_dark_id: "" })`,
  );
  await patch(`__settingsStore.getState().patchSettings({ schedule_switch_enabled: false })`);
  // 用真实的「还原默认」复位：除了 activeThemeId，还会清掉定时模块的
  // lastAppliedId（去重记录）。直接 setState 只改前者，后面把映射改回 Neon
  // 时会被去重挡住，得到一个与产品行为无关的假失败。
  await sleep(300);
  await evaluate(`__themeStore.getState().restoreDefault()`, true);
  await sleep(200);
  const crossReset = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("跨零点用例前已还原默认", crossReset === null, String(crossReset));
  await patch(
    `__settingsStore.getState().patchSettings({
      schedule_switch_enabled: true,
      schedule_start: "22:00",
      schedule_end: "06:00",
      schedule_in_id: "sys_firefly",
      schedule_out_id: "",
    })`,
  );
  if (crossMidnightHit) {
    const hit = await waitFor(`__themeStore.getState().activeThemeId === "sys_firefly"`);
    const crossText = await evaluate(
      `document.querySelector('[data-schedule-window]')?.textContent ?? ""`,
    );
    assert("当前时刻在跨零点窗口内：应用期间内主题", hit && crossText.includes("时间段内"), crossText);
  } else {
    await sleep(800);
    const missed = await evaluate(`__themeStore.getState().activeThemeId`);
    const crossText = await evaluate(
      `document.querySelector('[data-schedule-window]')?.textContent ?? ""`,
    );
    assert(
      "当前时刻在跨零点窗口外：不动作且状态行判定时间段外",
      missed === null && crossText.includes("时间段外"),
      `${missed} / ${crossText}`,
    );
  }

  // --- 6. 让位规则：时间段内深浅色切换不动作；关掉定时切换后深浅色接管 ---
  await patch(
    `__settingsStore.getState().patchSettings({
      schedule_start: "00:00",
      schedule_end: "23:59",
      schedule_in_id: "${NEON}",
      schedule_out_id: "",
    })`,
  );
  const scheduleOwned = await waitFor(`__themeStore.getState().activeThemeId === "${NEON}"`);
  assert("回到全日窗口后期间内主题生效", scheduleOwned);
  await patch(
    `__settingsStore.getState().patchSettings({
      auto_switch_enabled: true,
      auto_switch_light_id: "sys_windows_default",
      auto_switch_dark_id: "sys_firefly",
    })`,
  );
  await sleep(900);
  const deferred = await evaluate(`__themeStore.getState().activeThemeId`);
  assert("时间段内深浅色切换让位", deferred === NEON, String(deferred));
  await patch(`__settingsStore.getState().patchSettings({ schedule_switch_enabled: false })`);
  const tookOver = await waitFor(
    `["sys_windows_default","sys_firefly"].includes(__themeStore.getState().activeThemeId)`,
  );
  assert(
    "关掉定时切换后深浅色映射接管",
    tookOver,
    String(await evaluate(`__themeStore.getState().activeThemeId`)),
  );

  // --- 7. 运行期无 JS 异常 ---
  assert("运行期无 JS 异常", pageErrors.length === 0, `errors=${pageErrors.length}`);

  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "schedule_page.png"), Buffer.from(png.result.data, "base64"));

  const failedCount = results.filter((ok) => !ok).length;
  console.log(`\n[定时切换] ${results.length - failedCount}/${results.length} 通过`);
  process.exitCode = failedCount > 0 ? 1 : 0;
} finally {
  edge.kill();
}
