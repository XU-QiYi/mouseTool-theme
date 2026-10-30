// 校验文档交叉引用：`§N` 与 `决策 N` 是否还能对上目标文档的标题
// 用法：node scripts/doc_ref_check.mjs [--verbose]
//
// 背景：AGENTS.md 只留指针、不留全表，章节号一旦重排，指针会**静默指空**——
// 读的人不会发现，只会照着错的编号去翻。这个脚本把"指空"变成退出码 1。
//
// 解析口径（故意保守，宁多报不漏报）：
// - `§N` 归属**同一行里最近一次出现的文档名**；同一行没提文档时，按"当前文件自引用"处理。
// - `决策 N` 永远指向决策记录（这是全仓库唯一编号的决策表）。
// - 只认标题（`## 5. xxx` / `## 决策 5：xxx`），不认正文里出现的数字。

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, "docs");
const VERBOSE = process.argv.includes("--verbose");

if (!fs.existsSync(DOCS_DIR)) {
  console.error(`找不到 ${DOCS_DIR}——请在仓库根目录运行：node scripts/doc_ref_check.mjs`);
  process.exit(2);
}

/** 别名 → 文档。别名按长度倒序匹配，避免 `决策记录` 抢在 `mouse-theme决策记录.md` 前面 */
const TARGETS = [
  {
    file: "docs/mouse-theme决策记录.md",
    aliases: ["mouse-theme决策记录.md", "决策记录", "决策文档"],
  },
  {
    file: "docs/mouse-theme需求描述.md",
    aliases: ["mouse-theme需求描述.md", "需求描述", "需求文档", "需求基线"],
  },
  {
    file: "docs/mouse-theme架构设计.md",
    aliases: ["mouse-theme架构设计.md", "架构设计", "架构文档"],
  },
  { file: "docs/design-system.md", aliases: ["design-system.md", "design-system"] },
  { file: "docs/motion.md", aliases: ["motion.md", "motion"] },
];

const DECISION_DOC = "docs/mouse-theme决策记录.md";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 从文档标题里抽编号集合 */
function readSections(file) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return null;

  const sections = new Set();
  const decisions = new Set();
  for (const line of fs.readFileSync(abs, "utf8").split(/\r?\n/)) {
    const num = /^##\s+(\d+)\./.exec(line);
    if (num) sections.add(Number(num[1]));
    const dec = /^##\s+决策\s*(\d+)/.exec(line);
    if (dec) decisions.add(Number(dec[1]));
  }
  return { sections, decisions };
}

/** 当前行里每次"提到某文档"的位置，用于把 §N 归给它前面最近的那次提及 */
function mentionsIn(line, aliasRe) {
  const hits = [];
  aliasRe.lastIndex = 0;
  let m;
  while ((m = aliasRe.exec(line)) !== null) {
    const target = TARGETS.find((t) => t.aliases.includes(m[0]));
    if (target) hits.push({ index: m.index, file: target.file });
  }
  return hits;
}

const aliasRe = new RegExp(
  "(?<![A-Za-z0-9-])(?:" +
    TARGETS.flatMap((t) => t.aliases)
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join("|") +
    ")(?![A-Za-z0-9-])",
  "g",
);

const cache = new Map();
const info = (file) => {
  if (!cache.has(file)) cache.set(file, readSections(file));
  return cache.get(file);
};

// 1) 目标文档必须存在（重命名后别名会静默失效，这里先兜住）
const errors = [];
for (const t of TARGETS) {
  if (!fs.existsSync(path.join(ROOT, t.file))) {
    errors.push(`目标文档不存在：${t.file}（别名 ${t.aliases.join(" / ")} 会全部指空）`);
  }
}

// 2) 扫描所有需要维护的文档
const scanFiles = [
  "agents.md",
  ...fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `docs/${f}`),
].filter((f) => fs.existsSync(path.join(ROOT, f)));

let total = 0;
const okRefs = [];

for (const file of scanFiles) {
  const self = info(file);
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/);

  lines.forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    const mentions = mentionsIn(line, aliasRe);

    // §N
    const secRe = /§\s*(\d+)/g;
    let m;
    while ((m = secRe.exec(line)) !== null) {
      total++;
      const n = Number(m[1]);
      const before = mentions.filter((h) => h.index < m.index).at(-1);
      const targetFile = before ? before.file : file;
      const target = info(targetFile);

      if (!target) {
        errors.push(`${where}  §${n} → ${targetFile} 不存在`);
        continue;
      }
      if (target.sections.size === 0) {
        errors.push(
          `${where}  §${n} 无法定位：${before ? targetFile : "当前文件"} 没有「## N.」形式的章节标题（写成「架构设计 §5」或改用决策编号）`,
        );
        continue;
      }
      if (!target.sections.has(n)) {
        const have = [...target.sections].sort((a, b) => a - b).join(", ");
        errors.push(`${where}  §${n} → ${targetFile} 没有第 ${n} 节（现有：${have}）`);
        continue;
      }
      okRefs.push(`${where}  §${n} → ${targetFile}`);
    }

    // 决策 N
    const decRe = /决策\s*(\d+)/g;
    while ((m = decRe.exec(line)) !== null) {
      total++;
      const n = Number(m[1]);
      const target = info(DECISION_DOC);
      if (!target) {
        errors.push(`${where}  决策 ${n} → ${DECISION_DOC} 不存在`);
      } else if (!target.decisions.has(n)) {
        const have = [...target.decisions].sort((a, b) => a - b).join(", ");
        errors.push(`${where}  决策 ${n} → 决策记录里没有这一条（现有：${have}）`);
      } else {
        okRefs.push(`${where}  决策 ${n} → ${DECISION_DOC}`);
      }
    }
  });
}

// 2.5) 相对链接目标必须出现在 git 跟踪清单（区分大小写）
// 开发机（Windows）与 CI（windows-latest）的文件系统都不区分大小写，
// `[AGENTS.md](AGENTS.md)` 指到小写 `agents.md` 这种断链在哪儿都不报，
// 只在 Linux 上才会炸。这里按 `git ls-files` 的原始大小写核对，把断链提前到本地拦下。
const linkFiles = ["README.md", ...scanFiles];
let tracked = null;
try {
  tracked = new Set(
    execSync("git -c core.quotepath=false ls-files", { cwd: ROOT, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean),
  );
} catch {
  console.log("相对链接检查：拿不到 git 跟踪清单，跳过");
}
if (tracked) {
  const isTracked = (rel) => {
    const p = rel.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p === "" || tracked.has(p)) return true;
    const prefix = `${p}/`;
    for (const entry of tracked) {
      if (entry.startsWith(prefix)) return true; // 目录目标：下面有被跟踪的文件就算存在
    }
    return false;
  };
  let linkTotal = 0;
  for (const file of linkFiles) {
    const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/);
    let inFence = false;
    lines.forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return;
      const linkRe = /\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
      let m;
      while ((m = linkRe.exec(line)) !== null) {
        let target = m[1];
        if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
        // 锚点与外链（http(s):、mailto: 等带协议前缀的）不归本检查管
        if (!target || target.startsWith("#")) continue;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
        try {
          target = decodeURIComponent(target);
        } catch {
          // 解不开的编码按原文核对
        }
        target = target.split("#")[0];
        if (!target) continue;
        linkTotal++;
        const resolved = path.relative(
          ROOT,
          path.resolve(path.dirname(path.join(ROOT, file)), target),
        );
        if (!isTracked(resolved)) {
          errors.push(`${file}:${i + 1}  相对链接目标不在 git 跟踪清单（区分大小写）：${m[1]}`);
        }
      }
    });
  }
  console.log(`相对链接：${linkTotal} 处，全部可解析`);
}

// 3) 派生事实一致性：命令数 / 决策总览 / CI 门闸 / 版本位置
// 这些数字在多份文档里手抄，最容易在加功能后只改一处；断言失败时打印实际值。

const read = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    errors.push(`一致性检查缺少文件：${rel}`);
    return "";
  }
  return fs.readFileSync(abs, "utf8");
};

// 3.1 命令总数：Rust 实现 vs 架构 §5 标题与表格 vs AGENTS 速查
let commandCount = 0;
const countCommands = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) countCommands(abs);
    else if (ent.name.endsWith(".rs")) {
      commandCount += (fs.readFileSync(abs, "utf8").match(/#\[tauri::command\]/g) ?? []).length;
    }
  }
};
countCommands(path.join(ROOT, "src-tauri", "src"));

const archText = read("docs/mouse-theme架构设计.md");
const archHeading = /##\s*5\.\s*命令契约（当前共\s*(\d+)\s*个）/.exec(archText);
const archSection = archText.split(/^##\s*5\./m)[1]?.split(/^##\s*6\./m)[0] ?? "";
const archRows = (archSection.match(/^\|\s*`/gm) ?? []).length;
const agentsText = read("agents.md");
const agentsCount = /(\d+)\s*个 Tauri 命令/.exec(agentsText);

for (const [label, value] of [
  ["架构 §5 标题", archHeading ? Number(archHeading[1]) : null],
  ["架构 §5 表格", archRows],
  ["AGENTS 速查", agentsCount ? Number(agentsCount[1]) : null],
]) {
  if (value !== commandCount) {
    errors.push(`命令数不一致：代码 ${commandCount} 个，${label} ${value ?? "未找到"} 个`);
  }
}
console.log(
  `命令数：代码 ${commandCount} / 架构标题 ${archHeading ? archHeading[1] : "?"} / 架构表格 ${archRows} / AGENTS ${agentsCount ? agentsCount[1] : "?"}`,
);

// 3.2 决策总览：正文每一条都必须有一行，反之亦然
const decisionText = read(DECISION_DOC);
const decisionNums = new Set(
  [...decisionText.matchAll(/^##\s*决策\s*(\d+)/gm)].map((m) => Number(m[1])),
);
const overviewNums = new Set();
let inOverview = false;
for (const line of decisionText.split(/\r?\n/)) {
  if (/^##\s*决策总览/.test(line)) {
    inOverview = true;
    continue;
  }
  if (inOverview && /^##\s/.test(line)) break;
  if (!inOverview) continue;
  const row = /^\|\s*(\d+)\s*\|/.exec(line);
  if (row) overviewNums.add(Number(row[1]));
}
const missingRows = [...decisionNums].filter((n) => !overviewNums.has(n)).sort((a, b) => a - b);
const extraRows = [...overviewNums].filter((n) => !decisionNums.has(n)).sort((a, b) => a - b);
if (missingRows.length) errors.push(`决策总览缺少：${missingRows.join(", ")}`);
if (extraRows.length) errors.push(`决策总览多出无正文的编号：${extraRows.join(", ")}`);
console.log(`决策总览：正文 ${decisionNums.size} 条 / 总览 ${overviewNums.size} 行`);

// 3.3 CI 门闸：ci.yml 有 clippy 时，当前口径文档必须都提到
const ci = read(".github/workflows/ci.yml");
if (/\bcargo\s+clippy\b/.test(ci)) {
  for (const file of [
    "agents.md",
    DECISION_DOC,
    "docs/mouse-theme需求描述.md",
    "docs/mouse-theme架构设计.md",
  ]) {
    if (!/clippy/i.test(read(file))) {
      errors.push(`${file} 未提 clippy：CI 已有该门闸，口径过期`);
    }
  }
}

// 3.4 发布指南 §1.2 的版本位置：文件必须存在，且仍是 5 个
const releaseText = read("docs/mouse-theme发布指南.md");
const versionFiles = [];
let inVersionTable = false;
for (const line of releaseText.split(/\r?\n/)) {
  if (/^###\s*1\.2\s*版本号五处一致/.test(line)) {
    inVersionTable = true;
    continue;
  }
  if (inVersionTable && /^###\s/.test(line)) break;
  if (!inVersionTable) continue;
  const row = /^\|\s*`([^`]+)`\s*\|/.exec(line);
  if (row) versionFiles.push(row[1]);
}
for (const file of versionFiles) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    errors.push(`发布指南 §1.2 的版本位置不存在：${file}`);
  }
}
if (versionFiles.length !== 5) {
  errors.push(
    `发布指南 §1.2 版本位置应为 5 个，实际 ${versionFiles.length} 个：${versionFiles.join(", ") || "未解析到"}`,
  );
}
for (const stale of ["三处版本号", "四处一起改"]) {
  if (releaseText.includes(stale)) {
    errors.push(`发布指南仍有过期版本口径：「${stale}」`);
  }
}
console.log(`发布指南版本位置：${versionFiles.length} 个（${versionFiles.join(", ")}）`);

if (VERBOSE) {
  for (const ref of okRefs) console.log("  ok  " + ref);
}

console.log(`扫描 ${scanFiles.length} 个文档，${total} 处引用，${errors.length} 处对不上`);

if (errors.length > 0) {
  console.error("");
  for (const err of errors) console.error("  ✗ " + err);
  console.error("\n修法：改引用编号，或改标题编号——两边总有一边过期了。");
  process.exit(1);
}
