import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appliedAtMachine,
  buildRecentItems,
  mineThemes,
  missingSlotNames,
  missingSlotsOf,
  timeOfDay,
} from "./themes.ts";
import type { CursorTheme, HistoryEntry, ThemeFileGap } from "../types/theme.ts";

function theme(overrides: Partial<CursorTheme> & { id: string; name: string }): CursorTheme {
  return {
    description: "",
    created_at: "2026-10-01 08:00",
    updated_at: "2026-10-01 08:00",
    is_built_in: false,
    cursors: [],
    ...overrides,
  };
}

const NEON = theme({
  id: "neon",
  name: "Neon Night",
  updated_at: "2026-10-30 09:00",
  cursors: [
    { registry_key: "Arrow", display_name: "正常选择", english_name: "Normal Select", file_path: "C:\\t\\neon\\arrow.cur", file_type: "cur" },
    { registry_key: "Wait", display_name: "忙", english_name: "Busy", file_path: "C:\\t\\neon\\busy.ani", file_type: "ani" },
  ],
});
const PAPER = theme({
  id: "paper",
  name: "Paper & Ink",
  updated_at: "2026-10-28 09:00",
  cursors: [
    { registry_key: "Arrow", display_name: "正常选择", english_name: "Normal Select", file_path: "C:\\t\\paper\\arrow.cur", file_type: "cur" },
  ],
});
const SYS = theme({ id: "sys", name: "Windows 默认", is_built_in: true });

const GAPS: ThemeFileGap[] = [{ theme_id: "paper", slots: ["Arrow"] }];
const RECENT: HistoryEntry[] = [
  { theme_id: "neon", name: "Neon Night", is_built_in: false, applied_at: "2026-10-30 09:12" },
];

test("mineThemes 只留我的主题并按关键词过滤", () => {
  const all = [SYS, NEON, PAPER];
  assert.deepEqual(
    mineThemes(all, "").map((t) => t.id),
    ["neon", "paper"],
    "缺省行为：后端顺序（最新在前）",
  );
  assert.deepEqual(
    mineThemes(all, "paper").map((t) => t.id),
    ["paper"],
  );
  assert.deepEqual(mineThemes(all, "没有的"), []);
});

test("mineThemes 按导入时间与名称排序", () => {
  const all = [NEON, PAPER];
  assert.deepEqual(
    mineThemes(all, "", { sort: "oldest" }).map((t) => t.id),
    ["paper", "neon"],
  );
  assert.deepEqual(
    mineThemes(all, "", { sort: "name" }).map((t) => t.id),
    ["Neon Night", "Paper & Ink"].map((_, i) => (i === 0 ? "neon" : "paper")),
    "N < P",
  );
});

test("mineThemes 按槽位完整度排序，同数保持新在前", () => {
  const wide = theme({ id: "wide", name: "Wide", updated_at: "2026-10-29 09:00", cursors: NEON.cursors.concat(NEON.cursors[0]) });
  const rows = mineThemes([PAPER, NEON, wide], "", { sort: "slots" });
  assert.deepEqual(rows.map((t) => t.id), ["wide", "neon", "paper"]);
});

test("mineThemes 筛选缺文件的与从未使用的", () => {
  const all = [NEON, PAPER];
  assert.deepEqual(
    mineThemes(all, "", { filter: "gapped", fileGaps: GAPS }).map((t) => t.id),
    ["paper"],
  );
  const used = new Set(RECENT.map((e) => e.theme_id));
  assert.deepEqual(
    mineThemes(all, "", { filter: "unused", usedIds: used }).map((t) => t.id),
    ["paper"],
  );
  assert.deepEqual(
    mineThemes(all, "", { filter: "unused", usedIds: new Set() }).map((t) => t.id),
    ["neon", "paper"],
    "没有使用记录时全都不算用过",
  );
});

test("missingSlotsOf / missingSlotNames 把键名翻成中文名", () => {
  assert.deepEqual(missingSlotsOf(GAPS, "paper"), ["Arrow"]);
  assert.deepEqual(missingSlotsOf(GAPS, "neon"), []);
  assert.deepEqual(missingSlotNames(NEON, ["Arrow", "Wait"]), ["正常选择", "忙"]);
  assert.deepEqual(missingSlotNames(NEON, ["NotAKey"]), ["NotAKey"]);
});

test("buildRecentItems 保留已删除主题的记录", () => {
  const items = buildRecentItems([NEON], [...RECENT, { theme_id: "gone", name: "旧主题", is_built_in: false, applied_at: "2026-10-29 10:00" }], "");
  assert.equal(items.length, 2);
  assert.equal(items[0].theme?.id, "neon");
  assert.equal(items[1].theme, null);
  assert.equal(items[1].entry.name, "旧主题");
  assert.deepEqual(
    buildRecentItems([NEON], RECENT, "neon").map((i) => i.entry.theme_id),
    ["neon"],
  );
});

test("timeOfDay 只取 HH:mm", () => {
  assert.equal(timeOfDay("2026-10-30 09:12"), "09:12");
  assert.equal(timeOfDay("2026-10-30 9:12"), "9:12", "一位小时数也算认识");
  assert.equal(timeOfDay("怪格式"), "怪格式", "格式不认识就原样返回");
});

test("appliedAtMachine 转成 <time> 可用的格式", () => {
  assert.equal(appliedAtMachine("2026-10-30 09:12"), "2026-10-30T09:12");
  assert.equal(appliedAtMachine("2026-10-30 09:12:30"), "2026-10-30T09:12:30");
  assert.equal(appliedAtMachine("怪格式"), "怪格式");
});
