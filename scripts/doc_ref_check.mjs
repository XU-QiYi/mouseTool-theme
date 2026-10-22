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
  "AGENTS.md",
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
