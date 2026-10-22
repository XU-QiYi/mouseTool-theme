// 三页差异化验收：逐个点击导航，检查中间区域的结构签名是否真的换了，并截图
// 用法：node scripts/dev_bg.mjs start; node scripts/nav_check.mjs; node scripts/dev_bg.mjs stop
//      （必须与 dev server 写在同一条命令里，跨命令的 vite 会被回收）
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9226;
const SHOT_DIR = join(process.cwd(), "docs", "screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + join(process.env.TEMP ?? ".", "edge_nav_profile"),
  "about:blank",
]);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? `  ${detail}` : ""}`);
};

try {
  let page = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      page = targets.find((t) => t.type === "page");
      if (page) break;
    } catch {
      /* wait */
    }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, err) => {
    ws.onopen = ok;
    ws.onerror = err;
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
      return;
    }
    if (d.method === "Runtime.exceptionThrown") {
      const desc =
        d.params?.exceptionDetails?.exception?.description ?? d.params?.exceptionDetails?.text;
      console.log("  ✗ 页面异常:", String(desc).split("\n").slice(0, 6).join("\n     "));
    }
    if (d.method === "Runtime.consoleAPICalled" && d.params?.type === "error") {
      const text = (d.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      console.log("  ✗ console.error:", String(text).slice(0, 300));
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok) => {
      const n = ++id;
      pending.set(n, ok);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.result?.exceptionDetails) {
      return "ERR: " + (r.result.exceptionDetails.exception?.description ?? "unknown");
    }
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:1420" });
  await sleep(3000);
  mkdirSync(SHOT_DIR, { recursive: true });

  // 每页的结构签名：标题、中间区域长什么样、右侧有没有检查器
  const signature = () =>
    evaluate(`(() => {
      const view = document.querySelector("[data-view]");
      return JSON.stringify({
        view: view?.getAttribute("data-view") ?? null,
        title: document.querySelector("h1")?.textContent?.trim() ?? "",
        hint: document.querySelector("h1 + p")?.textContent?.trim() ?? "",
        inspector: !!document.querySelector('aside[aria-label="主题详情"]'),
        galleryCards: document.querySelectorAll("[data-theme-card]").length,
        table: !!document.querySelector("table"),
        tableRows: document.querySelectorAll("[data-theme-row]").length,
        timelineRows: document.querySelectorAll("[data-recent-row]").length,
        search: !!document.querySelector('input[type="search"], input[placeholder^="搜索"]'),
      });
    })()`);

  const clickNav = async (label) => {
    const r = await evaluate(`(() => {
      const btn = [...document.querySelectorAll("nav button")].find(b => b.textContent.trim().startsWith("${label}"));
      if (!btn) return "NOT_FOUND";
      btn.click();
      return "OK";
    })()`);
    await sleep(500);
    return r;
  };

  const shots = [];
  const signs = [];
  const plan = [
    { label: "主题图库", key: "gallery", pick: "Neon Night" },
    { label: "我的主题", key: "mine", pick: "Paper & Ink" },
    { label: "最近使用", key: "recent", pick: null },
  ];

  for (const { label, key, pick } of plan) {
    const ok = await clickNav(label);
    check(`导航「${label}」可点击`, ok === "OK", ok);

    if (pick) {
      // 选一个方案，让检查器有内容可看（截图用它当默认形态）
      await evaluate(`(() => {
        const target = [...document.querySelectorAll("[data-theme-card],[data-theme-row] button")]
          .find(el => el.textContent.includes("${pick}"));
        target?.click();
        return !!target;
      })()`);
      await sleep(400);
    }

    const sigRaw = await signature();
    let sig = {};
    try {
      sig = JSON.parse(sigRaw);
    } catch {
      console.log("  ✗ 读取结构失败:", sigRaw);
    }
    signs.push({ key, ...sig });
    console.log(
      `  ${key}: 标题=${sig.title} 画廊卡=${sig.galleryCards} 表格=${sig.table ? sig.tableRows + " 行" : "无"} 时间轴=${sig.timelineRows} 检查器=${sig.inspector} 搜索框=${sig.search}`,
    );

    const shot = await send("Page.captureScreenshot", { format: "png" });
    const out = join(SHOT_DIR, `${key}.png`);
    writeFileSync(out, Buffer.from(shot.result.data, "base64"));
    shots.push(out);
  }

  // 核心断言：三页的「中间区域」必须是三种不同结构，而不是同一张列表换个过滤条件
  const [g, m, r] = signs;
  check("图库是卡片网格", g.view === "gallery" && g.galleryCards > 0 && !g.table, `${g.galleryCards} 张卡`);
  check("我的主题是表格", m.view === "mine" && m.table && m.tableRows > 0 && m.galleryCards === 0, `${m.tableRows} 行`);
  check("最近使用是时间轴且不挂检查器", r.view === "recent" && r.timelineRows > 0 && r.inspector === false, `${r.timelineRows} 条`);
  check("三页标题互不相同", new Set([g.title, m.title, r.title]).size === 3, [g.title, m.title, r.title].join(" / "));
  check("三页说明互不相同", new Set([g.hint, m.hint, r.hint]).size === 3);
  check("图库与我的主题各有检查器", g.inspector && m.inspector);
  check("图库/我的主题有搜索，最近使用没有", g.search && m.search && !r.search);

  console.log("\n截图:");
  for (const s of shots) console.log("  " + s);

  ws.close();
  if (results.some((r) => !r.ok)) process.exitCode = 1;
} finally {
  edge.kill();
}
