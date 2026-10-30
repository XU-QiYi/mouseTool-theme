// 「我的主题」排序与筛选验收（决策 48，浏览器 mock 链路）
// 前置：vite 已在 1420（与 dev_bg 同一条命令里跑）。
// - 默认顺序 = 后端口径（最新导入在前），工具条出现排序 / 筛选两个下拉
// - 排序：最早导入 / 名称 / 槽位完整度各自改变行序
// - 筛选：缺文件的（配合 ?mock-broken-files=1 命中缺口主题）、
//   从未使用的（mock 里两套都用过 → 注入一套未使用的来命中）
// - 空态：无缺口库选「缺文件的」→「没有缺文件的主题」→ 显示全部恢复
// - 整理模式下排序 / 筛选让位（批量范围永远等于眼前列表）
// - 无 JS 异常
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9243;
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
  results.push(ok);
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
  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener("message", (ev) => {
    const data = JSON.parse(ev.data);
    if (data.method === "Runtime.exceptionThrown") {
      pageErrors.push(data.params?.exceptionDetails?.exception?.description ?? "?");
    }
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((ok) => {
      msgId += 1;
      pending.set(msgId, ok);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? "页面内执行失败");
    }
    return res.result?.result?.value;
  };

  await send("Page.enable", {});

  const goto = async (url) => {
    await send("Page.navigate", { url });
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      if (await evaluate(`document.body.innerText.includes("主题图库")`).catch(() => false)) break;
    }
    await evaluate(
      `[...document.querySelectorAll("button")].find(b => b.textContent.includes("我的主题"))?.click()`,
    );
    await sleep(500);
  };
  const rowNames = () =>
    evaluate(
      `[...document.querySelectorAll("[data-theme-row]")].map(r => r.querySelector(".font-medium")?.textContent)`,
    );
  const setSelect = (attr, value) =>
    evaluate(
      `(() => {
        const el = document.querySelector("[${attr}]");
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
    );

  // ---- 第一段：正常 mock ----
  await goto("http://localhost:1420/");
  check(
    "工具条出现排序与筛选下拉",
    await evaluate(
      `Boolean(document.querySelector("[data-mine-sort]") && document.querySelector("[data-mine-filter]"))`,
    ),
  );
  const defaultRows = await rowNames();
  check(
    "默认顺序 = 最新导入在前（后端口径不动）",
    defaultRows.length === 2 && defaultRows[0] === "Neon Night",
    JSON.stringify(defaultRows),
  );

  // 注入一套「从未使用」的主题：日期最早、名字最小、槽位最少，三种排序都能被它区分
  await evaluate(
    `(() => {
      const s = globalThis.__themeStore.getState();
      const nn = s.themes.find(t => t.name === "Neon Night");
      globalThis.__themeStore.setState({
        themes: [...s.themes, {
          ...nn,
          id: "unused-fixture-1",
          name: "AAA 未使用",
          cursors: nn.cursors.slice(0, 3),
          updated_at: "2026-01-01 08:00",
        }],
      });
      return true;
    })()`,
  );
  await sleep(300);
  check("注入后列表 3 行", (await rowNames()).length === 3, JSON.stringify(await rowNames()));

  await setSelect("data-mine-sort", "oldest");
  check(
    "按导入时间升序：最早在最前",
    (await rowNames())[0] === "AAA 未使用",
    JSON.stringify(await rowNames()),
  );
  await setSelect("data-mine-sort", "name");
  check(
    "按名称：AAA 在最前",
    (await rowNames())[0] === "AAA 未使用",
    JSON.stringify(await rowNames()),
  );
  await setSelect("data-mine-sort", "slots");
  check(
    "按槽位完整度：槽位最少的排最后",
    (await rowNames()).at(-1) === "AAA 未使用",
    JSON.stringify(await rowNames()),
  );
  await setSelect("data-mine-sort", "newest");

  await setSelect("data-mine-filter", "unused");
  const unusedRows = await rowNames();
  check(
    "筛选「从未使用的」只留注入的那套",
    unusedRows.length === 1 && unusedRows[0] === "AAA 未使用",
    JSON.stringify(unusedRows),
  );
  const countText = await evaluate(
    `[...document.querySelectorAll("[data-export-all-bar] p")].map(p => p.textContent).join("")`,
  );
  check("计数标注已按条件筛选", countText.includes("已按条件筛选"), countText);
  await setSelect("data-mine-filter", "all");

  // 整理模式下排序 / 筛选让位
  await evaluate(`document.querySelector("[data-batch-mode]")?.click()`);
  await sleep(300);
  check(
    "整理模式下排序 / 筛选隐藏",
    await evaluate(
      `!document.querySelector("[data-mine-sort]") && !document.querySelector("[data-mine-filter]") && Boolean(document.querySelector("[data-batch-count]"))`,
    ),
  );
  await evaluate(`document.querySelector("[data-batch-exit]")?.click()`);
  await sleep(300);

  // 空态：正常库没有缺口主题，「缺文件的」筛出空列表
  await setSelect("data-mine-filter", "gapped");
  await sleep(300);
  const emptyTitle = await evaluate(
    `document.querySelector("[data-empty-state], [class*='empty'], main")?.innerText?.includes("没有缺文件的主题") ?? document.body.innerText.includes("没有缺文件的主题")`,
  );
  check("缺口筛选空态点名「没有缺文件的主题」", emptyTitle === true);
  const restored = await evaluate(
    `(() => {
      const btn = [...document.querySelectorAll("button")].find(b => b.textContent.includes("显示全部主题"));
      btn?.click();
      return Boolean(btn);
    })()`,
  );
  await sleep(300);
  check("「显示全部主题」恢复完整列表", restored && (await rowNames()).length === 3, JSON.stringify(await rowNames()));

  // ---- 第二段：缺口 mock —— 「缺文件的」筛出带缺口的主题 ----
  await goto("http://localhost:1420/?mock-broken-files=1");
  await setSelect("data-mine-filter", "gapped");
  await sleep(300);
  const gappedRows = await rowNames();
  const gapHinted = await evaluate(
    `[...document.querySelectorAll("[data-theme-row]")].map(r => Boolean(r.querySelector("[data-gap-hint]")))`,
  );
  check(
    "缺口 mock 下「缺文件的」只留带缺口提示的行",
    gappedRows.length === 1 && gappedRows[0] === "Neon Night" && gapHinted.every(Boolean),
    JSON.stringify({ gappedRows, gapHinted }),
  );

  const errors = pageErrors.length;
  check("运行期无 JS 异常", errors === 0, `${errors} 条`);
} catch (err) {
  check("验收脚本执行", false, String(err));
} finally {
  edge.kill();
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n[我的主题排序筛选] ${results.length - failed}/${results.length} 通过`);
  process.exitCode = failed > 0 ? 1 : 0;
}
