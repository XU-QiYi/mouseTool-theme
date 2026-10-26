// 设计规范落地验证：不点「应用」以外的系统动作（浏览器里 apply 走 mock），只验结构、焦点与截图
// 用法：node scripts/dev_bg.mjs start; node scripts/design_check.mjs; node scripts/dev_bg.mjs stop
//      （必须与 dev server 写在同一条命令里，跨命令的 vite 会被回收）
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const OUT_DIR = process.env.TEMP ?? ".";
const PORT = 9225;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(OUT_DIR, "edge_design_profile"),
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
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
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

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.result?.exceptionDetails) {
      return "ERR: " + (r.result.exceptionDetails.exception?.description ?? "unknown");
    }
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Page.navigate", { url: URL_TO_OPEN });
  await sleep(3200);

  const assert = (name, ok, detail) => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? " · " + detail : ""}`);
    if (!ok) process.exitCode = 1;
  };

  // 0. 静态配置：窗口最小尺寸（检查器最小 280 + 正文 440 + 侧栏 224 ≈ 944，留出余量）
  const winConfig =
    JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app?.windows?.[0] ?? {};
  assert(
    "窗口最小尺寸 ≥ 1080×640",
    winConfig.minWidth >= 1080 && winConfig.minHeight >= 640,
    `${winConfig.minWidth}×${winConfig.minHeight}`,
  );

  // 0.5 品牌标记：侧栏顶部用应用图标里的指针轮廓（单色），不是 lucide 通用箭头
  assert(
    "侧栏品牌位用品牌指针",
    await evaluate(`!!document.querySelector("aside [data-brand-mark]")`),
  );

  // 1. 结构断言（逐条查，任何一条出错都能定位）
  const checks = {
    导航项数: `document.querySelectorAll("nav button").length`,
    当前页有aria_current: `[...document.querySelectorAll("nav button")].filter(b => b.getAttribute("aria-current") === "page").length`,
    导航全部带焦点环: `[...document.querySelectorAll("nav button")].every(b => b.className.includes("focus-visible:ring-3"))`,
    导航带计数: `[...document.querySelectorAll("nav button")].filter(b => /\\d+/.test(b.textContent)).length + "/" + document.querySelectorAll("nav button").length`,
    画廊卡带焦点环: `[...document.querySelectorAll("[data-theme-card]")].every(b => b.className.includes("focus-ring"))`,
    画廊卡带aria_pressed: `["true","false"].includes(document.querySelector("[data-theme-card]")?.getAttribute("aria-pressed"))`,
    画廊卡描边方式: `document.querySelector("[data-theme-card]")?.className.includes("ring-1") ? "ring" : "border"`,
    页头有一级标题: `document.querySelectorAll("h1").length`,
    检查器存在: `!!document.querySelector('aside[aria-label="主题详情"]')`,
    常驻状态卡: `!!document.querySelector("aside .preview-surface")`,
    自定义滚动区数量: `document.querySelectorAll('[data-slot="scroll-area"]').length`,
    原生滚动容器数: `[...document.querySelectorAll("*")].filter(e => { const s = getComputedStyle(e); return s.overflowY === "auto" && e.clientHeight > 100; }).length`,
  };
  console.log("结构审计:");
  for (const [k, expr] of Object.entries(checks)) {
    console.log(`  ${k}: ${await evaluate(expr)}`);
  }

  // 1.5 三页的「中间区域」必须是三种结构，而不是同一张列表换个过滤条件
  const switchTo = async (label) => {
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("nav button")].find(b => b.textContent.includes("${label}"));
      btn?.click();
      return !!btn;
    })()`);
    await sleep(500);
  };

  await switchTo("我的主题");
  await evaluate(`document.querySelector("[data-theme-row] button")?.click()`);
  await sleep(500);
  const tableState = await evaluate(`(() => {
    const rows = [...document.querySelectorAll("[data-theme-row]")];
    return JSON.stringify({
      行数: rows.length,
      有表头: !!document.querySelector("table thead th"),
      选中行有aria_pressed: rows[0]?.querySelector("button")?.getAttribute("aria-pressed"),
      检查器有应用按钮: [...document.querySelectorAll("button")].some(b => b.textContent.includes("应用此主题")),
    });
  })()`);
  console.log("我的主题页:", tableState);
  await sleep(300);
  const shotMine = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(OUT_DIR, "design_mine_page.png"),
    Buffer.from(shotMine.result.data, "base64"),
  );

  await switchTo("最近使用");
  const recentState = await evaluate(`(() => {
    return JSON.stringify({
      时间轴行: document.querySelectorAll("[data-recent-row]").length,
      有检查器: !!document.querySelector('aside[aria-label="主题详情"]'),
      有日期分组: document.body.innerText.includes("今天"),
      有再次应用: document.body.innerText.includes("再次应用"),
    });
  })()`);
  console.log("最近使用页:", recentState);
  const shotRecent = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(OUT_DIR, "design_recent_page.png"),
    Buffer.from(shotRecent.result.data, "base64"),
  );

  await switchTo("设置");
  // 进设置后侧栏是分组导航：数据目录/诊断在「数据」分组里（决策 14）
  await switchTo("数据");
  const settingsState = await evaluate(`(() => {
    return JSON.stringify({
      路径已显示: !!document.querySelector("[data-data-dir]")?.textContent,
      打开按钮存在: [...document.querySelectorAll("button")].some(b => b.textContent.includes("打开数据目录")),
      检查器: !!document.querySelector('aside[aria-label="主题详情"]'),
    });
  })()`);
  console.log("设置页:", settingsState);
  const shotSettings = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    join(OUT_DIR, "design_settings_page.png"),
    Buffer.from(shotSettings.result.data, "base64"),
  );

  // 返回主导航再回图库：设置形态下侧栏是「返回 + 分组」，没有「主题图库」按钮
  await switchTo("返回");
  await switchTo("主题图库");

  // 2. 键盘焦点：按 Tab 走入界面，截取焦点态
  const tab = async () => {
    for (const type of ["rawKeyDown", "char", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
    }
    await sleep(180);
  };

  const focused = [];
  for (let i = 0; i < 6; i++) {
    await tab();
    const info = await evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "BODY";
      const s = getComputedStyle(el);
      const hasRing = s.boxShadow && s.boxShadow !== "none";
      return (el.tagName + " · " + (el.textContent || "").trim().slice(0, 10) +
        " · ring: " + (hasRing ? s.boxShadow.slice(-60) : "无")).replace(/\\s+/g, " ");
    })()`);
    focused.push(info);
  }
  console.log("Tab 焦点序列:");
  focused.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  const shot1 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_focus.png"), Buffer.from(shot1.result.data, "base64"));

  // 3. 选中一张卡，截整体
  await evaluate(`document.querySelector("[data-theme-card]")?.click()`);
  await sleep(900);

  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_selected.png"), Buffer.from(shot2.result.data, "base64"));

  // 3.1 选中环不能被滚动容器裁掉：卡片上沿离容器上沿至少 2px（环画在盒子外面）
  const ringClearance = await evaluate(`(() => {
    const card = document.querySelector("[data-theme-card]");
    const scroller = card?.closest(".overflow-y-auto");
    if (!card || !scroller) return null;
    return Math.round(card.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
  })()`);
  const clearanceOk = typeof ringClearance === "number" && ringClearance >= 2;
  console.log(`卡片顶部余量: ${ringClearance}px ${clearanceOk ? "OK" : "✗ 会被裁切"}`);
  if (!clearanceOk) process.exitCode = 1;

  // 3.2 检查器：宽度可拖 + 15 槽位在常规窗口里不该出现滚动条
  //（选中项此刻是 15 槽位的「Windows 默认」，正好是内容最多的那种）
  const inspector = JSON.parse(
    await evaluate(`(() => {
      const aside = document.querySelector('aside[aria-label="主题详情"]');
      const body = aside?.querySelector('.overflow-y-auto');
      const cs = body ? getComputedStyle(body) : null;
      const row = body?.querySelector('.grid > *');
      return JSON.stringify({
        width: Math.round(aside?.getBoundingClientRect().width ?? 0),
        overflow: body ? body.scrollHeight - body.clientHeight : null,
        scrollbar: cs?.scrollbarWidth ?? null,
        gutter: cs?.scrollbarGutter ?? null,
        scrollbarSpace: body ? body.offsetWidth - body.clientWidth : null,
        slots: body?.querySelectorAll('.grid > *').length ?? 0,
        rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
        resizer: !!document.querySelector('[aria-label="调整详情面板宽度"]'),
        ariaNow: document.querySelector('[aria-label="调整详情面板宽度"]')?.getAttribute("aria-valuenow"),
      });
    })()`),
  );
  console.log("检查器:", JSON.stringify(inspector));
  assert("分隔条存在且有 aria-valuenow", inspector.resizer && inspector.ariaNow !== null);
  assert("15 槽位在默认宽度下不溢出", inspector.overflow === 0, `溢出 ${inspector.overflow}px`);
  assert("滚动条预留槽位（gutter stable）", inspector.gutter === "stable", inspector.gutter);
  assert(
    "滚动条是 6px 细条而不是 15px 经典条",
    inspector.scrollbarSpace !== null && inspector.scrollbarSpace <= 6,
    `占宽 ${inspector.scrollbarSpace}px`,
  );

  await evaluate(`document.querySelector('[aria-label="调整详情面板宽度"]')?.focus()`);
  await sleep(150);
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "ArrowLeft",
      code: "ArrowLeft",
      windowsVirtualKeyCode: 37,
      nativeVirtualKeyCode: 37,
    });
  }
  await sleep(250);
  const widened = await evaluate(
    `Math.round(document.querySelector('aside[aria-label="主题详情"]').getBoundingClientRect().width)`,
  );
  assert("分隔条支持键盘加宽（←）", widened === inspector.width + 16, `${inspector.width} → ${widened}`);

  await evaluate(`(() => {
    const el = document.querySelector('[aria-label="调整详情面板宽度"]');
    el?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    return "OK";
  })()`);
  await sleep(250);
  const reset = await evaluate(
    `Math.round(document.querySelector('aside[aria-label="主题详情"]').getBoundingClientRect().width)`,
  );
  assert("双击分隔条复位到默认宽度", reset === 320, `→ ${reset}`);

  // 4. Toast：浏览器环境 applyTheme 是 mock，不会改系统光标，可以安全点击
  const applyClicked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("应用此主题"));
    if (!btn) return "NOT_FOUND";
    if (btn.disabled) return "DISABLED";
    btn.click();
    return "CLICKED";
  })()`);
  await sleep(700);

  const toastState = await evaluate(`(() => {
    const text = document.body.innerText;
    const hit = text.includes("已应用");
    const viewport = [...document.querySelectorAll("div")].find(e => {
      const s = getComputedStyle(e);
      return s.position === "fixed" && s.zIndex === "60";
    });
    return hit ? "出现：" + (viewport ? viewport.innerText.replace(/\\s+/g, " ").slice(0, 40) : "但找不到容器") : "未出现";
  })()`);
  console.log("应用按钮:", applyClicked, "| Toast:", toastState);

  const shot3 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_toast.png"), Buffer.from(shot3.result.data, "base64"));

  // 5. 删除确认弹窗：选中 Neon Night，点检查器里的删除
  await evaluate(`(() => {
    const card = [...document.querySelectorAll("[data-theme-card]")].find(c => c.textContent.includes("Neon Night"));
    card?.click();
    return !!card;
  })()`);
  await sleep(600);

  const delState = await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="删除此主题"]');
    if (!btn) return "NO_BTN";
    if (btn.disabled) return "DISABLED";
    btn.click();
    return "CLICKED";
  })()`);
  await sleep(700);

  const dialog = await evaluate(`(() => {
    const el = document.querySelector('[role="alertdialog"]');
    if (!el) return "弹窗未出现";
    return "弹窗：" + el.innerText.replace(/\\s+/g, " ").slice(0, 80);
  })()`);
  console.log("删除按钮:", delState, "|", dialog);

  const shot5 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_confirm.png"), Buffer.from(shot5.result.data, "base64"));

  // 点取消关闭，不真正删除
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent.trim() === "取消");
    btn?.click();
    return btn ? "CANCELLED" : "NO_CANCEL";
  })()`);
  await sleep(400);

  // 6. 重命名：点铅笔 → 全选 → 输入 → Enter
  const pencilHit = await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="重命名"]');
    if (!btn) return "NO_PENCIL";
    btn.click();
    return "CLICKED";
  })()`);
  await sleep(400);
  const selected = await evaluate(`(() => {
    const el = document.activeElement;
    if (el?.tagName !== "INPUT") return "NOT_INPUT:" + el?.tagName;
    el.select();
    return "SELECTED";
  })()`);
  await send("Input.insertText", { text: "极光之夜" });
  await sleep(250);
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }
  await sleep(800);

  const renamed = await evaluate(`(() => {
    const h2 = document.querySelector('aside[aria-label="主题详情"] h2');
    const toast = document.body.innerText.includes("已改名");
    return (h2?.textContent ?? "") + " | toast:" + (toast ? "有" : "无");
  })()`);
  console.log("重命名:", pencilHit, selected, "→", renamed);

  const shotRename = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_renamed.png"), Buffer.from(shotRename.result.data, "base64"));

  // 6.5 导出：浏览器里应给出明确提示，而不是静默失败
  const exportState = await evaluate(`(() => {
    const btn = document.querySelector('[aria-label="导出 ZIP"]');
    if (!btn) return "NO_BTN";
    if (btn.disabled) return "DISABLED";
    btn.click();
    return "CLICKED";
  })()`);
  await sleep(600);
  const exportToast = await evaluate(
    `document.body.innerText.includes("开发模式无法导出") ? "有提示" : "无提示"`,
  );
  console.log("导出按钮:", exportState, "|", exportToast);

  // 7. 长文案：验证真实错误信息的换行与高度（模拟 Rust 返回的最长错误）
  await evaluate(`window.__toast?.close()`);
  await sleep(300);
  const longErr = await evaluate(`(() => {
    if (!window.__toast) return "NO_HOOK";
    window.__toast.error("导入失败", "光标文件名认不出来。请改用 arrow、busy、text、hand 这类标准命名后重新打包");
    return "OK";
  })()`);
  await sleep(600);
  console.log("长文案测试:", longErr);

  const shot4 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_toast_long.png"), Buffer.from(shot4.result.data, "base64"));

  // 8. 完整删除链路：在「我的主题」表格里删掉 Paper & Ink，行数应减少一项
  await switchTo("我的主题");
  const before = await evaluate(`document.querySelectorAll("[data-theme-row]").length`);
  await evaluate(`document.querySelector('[aria-label^="删除「Paper"]')?.click()`);
  await sleep(500);
  await evaluate(`[...document.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent.includes("确认删除"))?.click()`);
  await sleep(900);

  const after = await evaluate(`document.querySelectorAll("[data-theme-row]").length`);
  const delToast = await evaluate(
    `document.body.innerText.includes("已删除") ? "toast 出现" : "toast 缺失"`,
  );
  console.log(`删除链路: ${before} 行 → ${after} 行 | ${delToast}`);
  if (after !== before - 1) process.exitCode = 1;

  const shot6 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT_DIR, "design_deleted.png"), Buffer.from(shot6.result.data, "base64"));

  // 9. 外观三态：跟随系统（默认）/ 浅色 / 深色，手动覆盖优先于系统
  // 控件在「设置 → 通用 → 应用主题」（决策 14 从侧栏迁入），先切过去
  const openThemeSettings = async () => {
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().startsWith("设置"));
      btn?.click();
      return !!btn;
    })()`);
    await sleep(450);
    // 分组记忆着上次停留的位置（可能是「数据」），显式点回「通用」
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('nav[aria-label="设置导航"] button')].find((b) => b.textContent.trim().startsWith("通用"));
      btn?.click();
      return !!btn;
    })()`);
    await sleep(350);
  };
  await openThemeSettings();

  const luminance = (css) => {
    const m = /oklch\(([\d.]+)/.exec(css ?? "");
    return m ? Number(m[1]) : NaN;
  };
  const readTheme = async () =>
    JSON.parse(
      await evaluate(`(() => {
        const cs = getComputedStyle(document.body);
        const active = [...document.querySelectorAll('[aria-label="界面外观"] [role="radio"]')]
          .find((b) => b.getAttribute("aria-checked") === "true");
        return JSON.stringify({
          mode: active?.textContent.trim() ?? null,
          hasClass: document.documentElement.classList.contains("dark"),
          bg: cs.backgroundColor,
          fg: cs.color,
          scheme: getComputedStyle(document.documentElement).colorScheme,
          stored: localStorage.getItem("cursorstudio.theme-mode"),
        });
      })()`),
    );
  const clickMode = async (label) => {
    await evaluate(
      `[...document.querySelectorAll('[aria-label="界面外观"] [role="radio"]')].find((b) => b.textContent.includes("${label}"))?.click()`,
    );
    await sleep(350);
  };
  const emulate = async (value) => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await sleep(400);
  };
  const shotMode = async (file) => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT_DIR, file), Buffer.from(shot.result.data, "base64"));
  };

  // 先归一化到「跟随系统」，避免上一次跑剩下的偏好影响判断
  await clickMode("跟随系统");
  const initial = await readTheme();
  assert("默认模式是「跟随系统」", initial.mode === "跟随系统" && initial.stored === "system", initial.mode);
  assert("系统为浅色时按浅色渲染", initial.hasClass === false && luminance(initial.bg) > 0.9, `L=${luminance(initial.bg)}`);

  await emulate("dark");
  const followed = await readTheme();
  assert("跟随系统：系统转深色就跟着变", followed.hasClass === true, followed.bg);
  assert("深色背景 L < 0.3", luminance(followed.bg) < 0.3, `L=${luminance(followed.bg)}`);
  assert("深色文字 L > 0.9", luminance(followed.fg) > 0.9, `L=${luminance(followed.fg)}`);
  assert("深色下 color-scheme 为 dark（原生控件同步）", followed.scheme === "dark", followed.scheme);
  await shotMode("design_dark.png");

  await clickMode("浅色");
  const forcedLight = await readTheme();
  assert("手动选浅色：系统是深色也保持浅色", forcedLight.hasClass === false && forcedLight.stored === "light", `dark=${forcedLight.hasClass}`);

  await clickMode("深色");
  const forcedDark = await readTheme();
  assert("手动选深色：立即生效并记住", forcedDark.hasClass === true && forcedDark.stored === "dark", forcedDark.stored);
  await emulate("light");
  const stillDark = await readTheme();
  assert("手动深色不被系统浅色顶掉", stillDark.hasClass === true, `dark=${stillDark.hasClass}`);

  await clickMode("跟随系统");
  await emulate("light");
  const backToSystem = await readTheme();
  assert("回到跟随系统后随系统变浅", backToSystem.hasClass === false && backToSystem.stored === "system", `L=${luminance(backToSystem.bg)}`);

  // 持久化：刷新后应恢复上次选的模式（刷新落在图库，需再进设置读控件态）
  await clickMode("深色");
  await send("Page.reload", {});
  await sleep(2800);
  await openThemeSettings();
  const restored = await readTheme();
  assert("刷新后恢复上次选择", restored.mode === "深色" && restored.hasClass === true, `${restored.mode} / dark=${restored.hasClass}`);

  // 收尾：还原成跟随系统，避免污染下一次运行
  await clickMode("跟随系统");

  console.log("截图目录:", OUT_DIR);
  ws.close();
} finally {
  edge.kill();
}
