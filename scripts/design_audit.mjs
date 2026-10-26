// 扫描界面层实际使用的样式取值，用于反推"事实标准"与规范缺口
// 注意：text-* 同时承载字号、颜色、对齐三种语义，必须分开归类，否则统计会失真
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 相对脚本定位：CI 与本地都在仓库任意位置可跑，不绑定某台机器的绝对路径
const ROOT = fileURLToPath(new URL("../src", import.meta.url));
const REPO_ROOT = path.dirname(ROOT);

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
  "动效时长 · token": {},
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
  for (const m of src.matchAll(/\bduration-(\(--motion-[a-z]+\))/g)) bump("动效时长 · token", m[1]);
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

// 动效规则对 components/ui 同样适用：上面按约定跳过了 ui，这里单独再扫全量
const bareDurations = new Set();
const transitionAllFiles = [];
for (const f of walk(ROOT)) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bduration-(\(--motion-[a-z]+\)|\d+|\[[^\]]+\])/g)) {
    if (!m[1].startsWith("(--motion-")) bareDurations.add(m[1]);
  }
  if (/\btransition-all\b/.test(src)) transitionAllFiles.push(path.relative(REPO_ROOT, f));
}

console.log("\n## 合规判定");
console.log(`   非 2px 网格的间距：${spacingOffGrid.length ? spacingOffGrid.join(", ") : "无"}`);
console.log(`   字号魔法值：${magicType.length ? magicType.join(", ") : "无"}`);
console.log(`   裸写时长（应用 --motion-*）：${bareDurations.size ? [...bareDurations].join(", ") : "无"}`);
console.log(`   transition-all：${transitionAllFiles.length ? transitionAllFiles.join(", ") : "无"}`);

// 规范项一旦违规就以非零退出，CI 才能真的拦住回潮；没有违规时保持安静
if (spacingOffGrid.length || magicType.length || bareDurations.size || transitionAllFiles.length) {
  console.error("\n设计审计未通过：请按上方「合规判定」修正后再提交。");
  process.exitCode = 1;
}
