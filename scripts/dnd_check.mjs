// 验证拖拽导入：遮罩显隐 / 合法 zip 走通成功链路 / 类型与数量校验 / 非文件静默
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。走浏览器 mock 通路（HTML5 DnD）。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9229;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_headless_profile",
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

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:1420" });
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    if (await evaluate(`Boolean(window.__toast)`).catch(() => false)) break;
  }

  // 合成拖拽事件：related 传 "body" 表示窗口内元素间切换，withFile=false 模拟非文件拖入
  const drag = (type, names, related = null, withFile = true) =>
    evaluate(`(() => {
      const dt = new DataTransfer();
      for (const name of ${JSON.stringify(names)}) {
        if (${withFile}) dt.items.add(new File(["x"], name, { type: "application/zip" }));
      }
      window.dispatchEvent(new DragEvent(${JSON.stringify(type)}, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        relatedTarget: ${related === "body" ? "document.body" : "null"},
      }));
      return "OK";
    })()`);

  const overlayOpacity = () =>
    evaluate(`(() => {
      const el = document.querySelector("[data-drop-overlay]");
      return el ? Number(getComputedStyle(el).opacity) : -1;
    })()`);
  const waitOpacity = async (expected) => {
    for (let i = 0; i < 20; i++) {
      if ((await overlayOpacity()) === expected) return true;
      await sleep(100);
    }
    return (await overlayOpacity()) === expected;
  };

  // base-ui 把新 toast 前插到栈顶：DOM 里第一条就是最新的
  const firstToast = () => evaluate(`document.querySelector('[data-slot="toast"]')?.innerText ?? ""`);
  const waitToast = async (needle) => {
    for (let i = 0; i < 30; i++) {
      const text = await firstToast();
      if (text.includes(needle)) return text;
      await sleep(100);
    }
    return await firstToast();
  };
  const themeCount = () => evaluate(`window.__themeStore.getState().themes.length`);
  const screenshot = async (name) => {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const out = join(process.env.TEMP ?? ".", name);
    writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    console.log("screenshot:", out);
  };

  // 1. 遮罩显隐
  check("初始遮罩不可见", (await overlayOpacity()) === 0);

  await drag("dragenter", []);
  check("拖入窗口遮罩亮起", await waitOpacity(1));

  await screenshot("dnd_overlay.png");

  await drag("dragleave", [], "body");
  await sleep(150);
  check("窗口内移动不收遮罩", (await overlayOpacity()) === 1);

  await drag("dragleave", []);
  check("拖出窗口遮罩收起", await waitOpacity(0));

  // 2. 合法 zip：成功提示 + 列表新增 + 检查器选中
  const before = await themeCount();
  await drag("drop", ["我的新主题.zip"]);
  const okText = await waitToast("已导入");
  check("合法 zip 出现成功提示", okText.includes("已导入") && okText.includes("我的新主题"), okText);
  check("主题列表新增一条", (await themeCount()) === before + 1, `${before} -> ${await themeCount()}`);
  check(
    "新主题在检查器中选中",
    await evaluate(`Boolean(window.__themeStore.getState().selection.gallery && window.__themeStore.getState().selection.mine)`),
  );

  // 3. 类型校验
  await drag("drop", ["arrow.cur"]);
  const curText = await waitToast("只支持");
  check("白名单外文件被拒绝", curText.includes("只支持 .zip 主题包或 .theme 光标方案"), curText);

  // 文件夹导入（决策 16）与 .theme 方案（决策 36）：完整路径不再按扩展名拦，
  // 交给后端 `import_theme` 权威校验，各自给出精准文案。
  // 浏览器 mock 拿不到路径、File.name 里也塞不进反斜杠，这里直接问校验函数，
  // 否则会把「浏览器通路只收白名单」误当成「文件夹不支持」。
  const verdicts = await evaluate(`import('/src/hooks/useDragDropImport.ts').then((m) => ({
    folder: m.validateDrop([{ name: "光标合集", path: "D:\\\\Themes\\\\光标合集" }]),
    zip: m.validateDrop([{ name: "主题.zip", path: "D:\\\\Themes\\\\主题.zip" }]),
    theme: m.validateDrop([{ name: "方案.theme", path: "D:\\\\Themes\\\\方案.theme" }]),
    browser: m.validateDrop([{ name: "arrow.cur", path: "arrow.cur" }]),
  }))`);
  check("完整路径的文件夹放行（后端校验）", verdicts.folder === null, String(verdicts.folder));
  check("完整路径的 zip 放行", verdicts.zip === null, String(verdicts.zip));
  check("完整路径的 .theme 放行（后端校验）", verdicts.theme === null, String(verdicts.theme));
  check("浏览器文件名通路白名单外拒绝", verdicts.browser === "只支持 .zip 主题包或 .theme 光标方案", String(verdicts.browser));

  // 4. 多文件：不再报「一次只能导入一个」，而是进导入中心队列
  await drag("drop", ["a.zip", "b.zip"]);
  const queued = await evaluate(`(() => {
    const store = window.__importStore?.getState();
    return JSON.stringify({
      open: store?.open ?? null,
      count: store?.jobs.length ?? 0,
      names: (store?.jobs ?? []).map((job) => job.name).join("/"),
      running: store?.running ?? null,
    });
  })()`);
  const queueState = JSON.parse(queued);
  check(
    "多文件打开导入中心且队列为 2",
    queueState.open === true && queueState.count === 2 && queueState.names === "a.zip/b.zip",
    queued,
  );
  check("多文件不自动开始（等用户点「开始导入」）", queueState.running === false, String(queueState.running));
  const queueToast = await firstToast();
  check("多文件提示已加入队列", queueToast.includes("已加入导入队列"), queueToast);

  // 5. 非文件拖入（文本、网页元素）：静默忽略，不弹错、不动队列
  const beforeCount = await evaluate(`window.__importStore.getState().jobs.length`);
  await drag("drop", [], null, false);
  await sleep(500);
  const silentText = await firstToast();
  const afterCount = await evaluate(`window.__importStore.getState().jobs.length`);
  check(
    "非文件拖入静默忽略",
    silentText.includes("已加入导入队列") && afterCount === beforeCount,
    `最新一条仍是上一条提示，队列 ${beforeCount} -> ${afterCount}`,
  );

  // 收尾：关掉导入中心（未运行可以直接关），别让弹窗挡住后面的截图
  await evaluate(`window.__importStore?.getState().closeCenter()`);
  await sleep(300);

  await screenshot("dnd_final.png");
  check("运行期无 JS 异常", pageErrors.length === 0, pageErrors.join(" | "));

  ws.close();
} finally {
  edge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[拖拽导入] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
