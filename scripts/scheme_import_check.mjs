// .theme 光标方案导入验收（决策 36）：store 直导 / 拖拽白名单放行 / 白名单外拒绝 /
// 批量队列收 .theme。浏览器全走 mock（无文件系统），真文件解析由 Rust 单测覆盖。
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9241;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_scheme_profile",
  "about:blank",
]);

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? `  ${detail}` : ""}`);
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

  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.method === "Runtime.exceptionThrown") {
      pageErrors.push(data.params?.exceptionDetails?.exception?.description ?? data.params?.exceptionDetails?.text);
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
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? "页面内执行失败");
    }
    return res.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:1420" });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    if (await evaluate(`Boolean(window.__themeStore && window.__toast)`).catch(() => false)) break;
  }

  const themeCount = () => evaluate(`window.__themeStore.getState().themes.length`);
  const firstToast = () => evaluate(`document.querySelector('[data-slot="toast"]')?.innerText ?? ""`);
  const waitToast = async (needle) => {
    for (let i = 0; i < 30; i++) {
      const text = await firstToast();
      if (text.includes(needle)) return text;
      await sleep(100);
    }
    return await firstToast();
  };
  const waitThemeCount = async (expected) => {
    for (let i = 0; i < 30; i++) {
      if ((await themeCount()) === expected) return true;
      await sleep(100);
    }
    return (await themeCount()) === expected;
  };
  const drop = (names) =>
    evaluate(`(() => {
      const dt = new DataTransfer();
      for (const name of ${JSON.stringify(names)}) {
        dt.items.add(new File(["x"], name, { type: "application/octet-stream" }));
      }
      window.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return "OK";
    })()`);

  // ---- 1. store 直导 .theme：mock 取 stem 当主题名，检查器选中 ----
  const before = await themeCount();
  await evaluate(
    `window.__themeStore.getState().importTheme("C:\\\\Users\\\\someone\\\\Downloads\\\\夜航.theme")`,
  );
  const okText = await waitToast("已导入");
  check("store 导入 .theme 出现成功提示", okText.includes("已导入") && okText.includes("夜航"), okText);
  check("主题列表新增一条", await waitThemeCount(before + 1), `${before} -> ${await themeCount()}`);
  const selected = await evaluate(
    `(() => {
      const s = window.__themeStore.getState();
      const added = s.themes.find(t => t.name === "夜航");
      return Boolean(added && s.selection.gallery === added.id && s.selection.mine === added.id);
    })()`,
  );
  check("新主题在检查器中选中", selected);
  const added = JSON.parse(
    await evaluate(
      `JSON.stringify((() => {
        const s = window.__themeStore.getState();
        const theme = s.themes.find(t => t.name === "夜航");
        return theme ? { name: theme.name, description: theme.description } : null;
      })())`,
    ),
  );
  check(
    "mock 主题名取自文件名 stem（不带 .theme）",
    added !== null && added.name === "夜航" && added.description.includes("夜航.theme"),
    JSON.stringify(added),
  );

  // ---- 2. 浏览器拖拽：.theme 进白名单，单项走原导入链路 ----
  await drop(["手工方案.theme"]);
  const dropText = await waitToast("已导入");
  check("拖入 .theme 走通导入", dropText.includes("已导入") && dropText.includes("手工方案"), dropText);
  check("拖入后主题列表新增一条", await waitThemeCount(before + 2));

  // ---- 3. 白名单外仍拒绝（新文案）----
  await drop(["arrow.png"]);
  const rejectText = await waitToast("只支持");
  check(
    "浏览器通路白名单外拒绝",
    rejectText.includes("只支持 .zip 主题包或 .theme 光标方案"),
    rejectText,
  );
  // 校验函数直接断言：.theme 放行、完整路径照旧交给后端
  const verdicts = await evaluate(
    `import('/src/hooks/useDragDropImport.ts').then((m) => ({
      themeName: m.validateDrop([{ name: "夜航.theme", path: "夜航.theme" }]),
      themePath: m.validateDrop([{ name: "夜航.theme", path: "D:\\\\Themes\\\\夜航.theme" }]),
      png: m.validateDrop([{ name: "arrow.png", path: "arrow.png" }]),
    }))`,
  );
  check("validateDrop 放行 .theme 文件名", verdicts.themeName === null, String(verdicts.themeName));
  check("validateDrop 放行 .theme 完整路径", verdicts.themePath === null, String(verdicts.themePath));
  check(
    "validateDrop 拒绝白名单外文件",
    verdicts.png === "只支持 .zip 主题包或 .theme 光标方案",
    String(verdicts.png),
  );

  // ---- 4. 批量：.theme 与 .zip 混拖进导入中心，串行成功 ----
  await evaluate(
    `window.__importStore.getState().enqueue(["方案甲.theme", "方案乙.zip"])`,
  );
  await sleep(400);
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "开始导入");
    btn?.click();
    return Boolean(btn);
  })()`);
  const queueDone = async () =>
    evaluate(
      `(() => {
        const s = window.__importStore.getState();
        return !s.running && s.jobs.length === 2 && s.jobs.every(j => j.status === "success" || j.status === "failed");
      })()`,
    );
  let done = false;
  for (let i = 0; i < 40 && !done; i++) {
    await sleep(250);
    done = await queueDone();
  }
  const jobs = JSON.parse(
    await evaluate(
      `JSON.stringify(window.__importStore.getState().jobs.map(j => ({ name: j.name, status: j.status })))`,
    ),
  );
  check(
    "混拖 .theme/.zip 都进队列并成功",
    done && jobs.every(j => j.status === "success"),
    JSON.stringify(jobs),
  );
  check("批量导入后主题数 +2", await waitThemeCount(before + 4), `${before + 2} -> ${await themeCount()}`);
  await evaluate(`window.__importStore.getState().closeCenter()`);

  // ---- 5. 运行期无 JS 异常 ----
  check("运行期无 JS 异常", pageErrors.length === 0, `errors=${pageErrors.length}`);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const out = join(process.env.TEMP ?? ".", "scheme_import_page.png");
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n[方案导入] ${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed > 0 ? 1 : 0;
} finally {
  edge.kill();
}
