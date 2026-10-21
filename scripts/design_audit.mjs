// 扫描界面层实际使用的样式取值，用于反推"事实标准"与规范缺口
// 注意：text-* 同时承载字号、颜色、对齐三种语义，必须分开归类，否则统计会失真
import fs from "node:fs";
import path from "node:path";

const ROOT = "F:/forge/mouse-theme/mouseTool-theme/src";

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.includes(`${path.sep}ui${path.sep}`));

const SCALE = new Set(["3xs", "2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"]);
const ALIGN = new Set(["center", "left", "right", "justify", "start", "end", "clip", "balance", "pretty", "wrap", "nowrap", "ellipsis"]);

const out = {
  "字号 · 阶梯内": {},
  "字号 · 魔法值": {},
  "文字颜色": {},
  "背景色": {},
  "描边方式": {},
  "间距": {},
  "图标": {},
  "圆角": {},
  "阴影": {},
  "动效": {},
};

const bump = (k, v) => (out[k][v] = (out[k][v] || 0) + 1);

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");

  for (const m of src.matchAll(/\btext-(\[[^\]]+\]|[a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    const v = m[1];
    if (v.startsWith("[")) bump("字号 · 魔法值", v);
    else if (SCALE.has(v)) bump("字号 · 阶梯内", v);
    else if (ALIGN.has(v)) continue;
    else bump("文字颜色", v);
  }

  for (const m of src.matchAll(/\bbg-(\[[^\]]+\]|[a-z0-9]+(?:-[a-z0-9]+)*)/g)) bump("背景色", m[1]);

  for (const m of src.matchAll(/\b(?:ring|border)(?:-\d)?(?=-|\b)/g)) {
    const isRing = m[0].startsWith("ring");
    bump("描边方式", isRing ? "ring" : "border");
  }

  for (const m of src.matchAll(/\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-x|space-y)-(\d+(?:\.\d+)?|\[[^\]]+\])/g)) {
    bump("间距", m[1]);
  }

  for (const m of src.matchAll(/\bsize-(\d+(?:\.\d+)?)/g)) bump("图标", m[1]);

  for (const m of src.matchAll(/\brounded(?:-[trbl]{1,2})?-([a-z0-9]+)/g)) bump("圆角", m[1]);

  for (const m of src.matchAll(/\bshadow-([a-z0-9]+)/g)) bump("阴影", m[1]);

  for (const m of src.matchAll(/\btransition-([a-z]+)/g)) bump("动效", m[1]);
}

const fmt = (o) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .map(([v, c]) => `${v}×${c}`)
    .join("  ") || "—";

for (const [k, v] of Object.entries(out)) {
  console.log(`\n## ${k}  (${Object.keys(v).length} 种)`);
  console.log("   " + fmt(v));
}

// 合规判定
const spacingOffGrid = Object.keys(out["间距"]).filter((v) => {
  const n = Number(v);
  return Number.isNaN(n) || n % 0.5 !== 0;
});
const magicType = Object.keys(out["字号 · 魔法值"]);

console.log("\n## 合规判定");
console.log(`   非 2px 网格的间距：${spacingOffGrid.length ? spacingOffGrid.join(", ") : "无"}`);
console.log(`   字号魔法值：${magicType.length ? magicType.join(", ") : "无"}`);
console.log(`   transition-all：${out["动效"]["all"] ? "存在" : "无"}`);
