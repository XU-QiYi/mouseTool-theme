// 统计界面层 JSX 元素构成：shadcn UI 组件 / 业务组件 / 原生 HTML / 图标
// 口径：只统计"使用方"文件（App + components/{layout,theme,cursor}），不含 components/ui 本体
import fs from "node:fs";
import path from "node:path";

const ROOT = "F:/forge/mouse-theme/mouseTool-theme/src";

const FILES = [
  "App.tsx",
  "components/layout/Sidebar.tsx",
  "components/theme/ThemeList.tsx",
  "components/theme/ThemeCard.tsx",
  "components/theme/ThemeDetail.tsx",
  "components/theme/CursorGrid.tsx",
  "components/cursor/CursorSlotCard.tsx",
  "components/cursor/CursorPreviewImage.tsx",
  "components/cursor/AniPlayer.tsx",
];

const HTML_TAGS = new Set([
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "section", "aside", "nav", "main", "header", "footer", "article",
  "ul", "ol", "li", "dl", "dt", "dd",
  "button", "input", "textarea", "select", "option", "label", "form",
  "img", "canvas", "svg", "path", "circle", "rect", "line",
  "a", "hr", "br", "table", "thead", "tbody", "tr", "td", "th",
  "figure", "figcaption", "code", "pre", "strong", "em", "small",
]);

/** 解析单行 import，返回 { localName: module } */
function parseImports(src) {
  const map = {};
  const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const [, isType, clause, mod] = m;
    if (isType) continue;
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) map[name] = mod;
      }
    }
    const dflt = clause.match(/^\s*([A-Za-z_$][\w$]*)\s*(,|$)/);
    if (dflt) map[dflt[1]] = mod;
  }
  return map;
}

const rows = [];
const tally = {
  shadcn: {}, biz: {}, html: {}, icon: {}, unknown: {},
};

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const raw = fs.readFileSync(abs, "utf8");
  const imports = parseImports(raw);
  // 去掉 import 块，避免正则误扫模块名
  const body = raw.replace(/import\s+[\s\S]*?\s+from\s+["'][^"']+["'];?/g, "");

  const local = { shadcn: 0, biz: 0, html: 0, icon: 0, unknown: 0 };
  const detail = { shadcn: {}, biz: {}, html: {}, icon: {}, unknown: {} };

  const tagRe = /<([A-Za-z][\w.]*)(?=[\s/>])/g;
  let t;
  while ((t = tagRe.exec(body))) {
    const name = t[1];
    const isUpper = /^[A-Z]/.test(name);
    let bucket;
    if (!isUpper) {
      if (!HTML_TAGS.has(name)) continue; // 片段/文本里的 < 不算
      bucket = "html";
    } else {
      const mod = imports[name];
      if (!mod) continue; // TS 泛型等噪声
      if (mod.startsWith("@/components/ui")) bucket = "shadcn";
      else if (mod.startsWith("@/components/")) bucket = "biz";
      else if (mod === "lucide-react") bucket = "icon";
      else bucket = "unknown";
    }
    local[bucket] += 1;
    detail[bucket][name] = (detail[bucket][name] || 0) + 1;
    tally[bucket][name] = (tally[bucket][name] || 0) + 1;
  }

  rows.push({ file: rel, local, detail });
}

// 输出
const sum = (k) => rows.reduce((a, r) => a + r.local[k], 0);
const total = sum("shadcn") + sum("biz") + sum("html") + sum("icon") + sum("unknown");

console.log("文件 | shadcn | 业务组件 | 原生HTML | 图标 | 小计");
console.log("-".repeat(72));
for (const r of rows) {
  const l = r.local;
  const sub = l.shadcn + l.biz + l.html + l.icon + l.unknown;
  console.log(
    `${r.file.padEnd(42)} | ${String(l.shadcn).padStart(3)} | ${String(l.biz).padStart(3)} | ${String(l.html).padStart(3)} | ${String(l.icon).padStart(3)} | ${String(sub).padStart(3)}`
  );
}
console.log("-".repeat(72));
console.log(
  `合计: shadcn=${sum("shadcn")} biz=${sum("biz")} html=${sum("html")} icon=${sum("icon")} unknown=${sum("unknown")} total=${total}`
);

const uiTotal = sum("shadcn") + sum("html"); // 只比较"界面基础件"两类
console.log(
  `\n[界面基础件口径] shadcn ${sum("shadcn")} : 原生 ${sum("html")} = ${((sum("shadcn") / uiTotal) * 100).toFixed(1)}% : ${((sum("html") / uiTotal) * 100).toFixed(1)}%`
);

console.log("\n=== 逐文件明细 ===");
for (const r of rows) {
  const parts = [];
  for (const k of ["shadcn", "biz", "html", "icon"]) {
    const e = Object.entries(r.detail[k]);
    if (e.length) parts.push(`${k}[${e.map(([n, c]) => (c > 1 ? `${n}x${c}` : n)).join(",")}]`);
  }
  console.log(`  ${r.file}\n    ${parts.join(" ")}`);
}

console.log("\n=== shadcn 组件明细 ===");
for (const [k, v] of Object.entries(tally.shadcn).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log("\n=== 业务组件明细 ===");
for (const [k, v] of Object.entries(tally.biz).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log("\n=== 原生标签明细 ===");
for (const [k, v] of Object.entries(tally.html).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log("\n=== unknown ===", tally.unknown);
