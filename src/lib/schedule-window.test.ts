import assert from "node:assert/strict";
import { test } from "node:test";

import { isInWindow, minutesOfDay, msToNextBoundary, parseHHMM } from "./schedule-window.ts";

const at = (h: number, m: number) => new Date(2026, 9, 31, h, m, 0, 0);

test("parseHHMM 只认两位两位的 HH:MM", () => {
  assert.equal(parseHHMM("00:00"), 0);
  assert.equal(parseHHMM("09:30"), 570);
  assert.equal(parseHHMM("23:59"), 1439);
  assert.equal(parseHHMM("7:30"), null, "一位小时数不合法");
  assert.equal(parseHHMM("24:00"), null);
  assert.equal(parseHHMM("12:60"), null);
  assert.equal(parseHHMM("九点半"), null);
  assert.equal(parseHHMM(""), null);
});

test("minutesOfDay 取本地时区的当天分钟数", () => {
  assert.equal(minutesOfDay(at(0, 0)), 0);
  assert.equal(minutesOfDay(at(23, 59)), 1439);
});

test("普通窗口半开 [start, end)", () => {
  const start = "09:00";
  const end = "18:00";
  assert.equal(isInWindow(start, end, at(8, 59)), false);
  assert.equal(isInWindow(start, end, at(9, 0)), true);
  assert.equal(isInWindow(start, end, at(12, 0)), true);
  assert.equal(isInWindow(start, end, at(17, 59)), true);
  assert.equal(isInWindow(start, end, at(18, 0)), false, "end 是排他的");
});

test("跨零点窗口按两段取并集", () => {
  const start = "22:00";
  const end = "06:00";
  assert.equal(isInWindow(start, end, at(21, 59)), false);
  assert.equal(isInWindow(start, end, at(22, 0)), true);
  assert.equal(isInWindow(start, end, at(23, 30)), true);
  assert.equal(isInWindow(start, end, at(0, 0)), true);
  assert.equal(isInWindow(start, end, at(5, 59)), true);
  assert.equal(isInWindow(start, end, at(6, 0)), false);
});

test("start === end 是空窗口", () => {
  assert.equal(isInWindow("09:00", "09:00", at(9, 0)), false);
});

test("格式不合法的窗口恒为否", () => {
  assert.equal(isInWindow("25:00", "18:00", at(10, 0)), false);
  assert.equal(isInWindow("09:00", "", at(10, 0)), false);
});

test("msToNextBoundary 取两个边界中较近的一个", () => {
  const hour = 60 * 60 * 1000;
  // 10:00 在 09:00–18:00 内：下一个边界是 end（18:00）
  assert.equal(msToNextBoundary("09:00", "18:00", at(10, 0)), 8 * hour);
  // 19:00 在窗口外：下一个边界是明天的 start（09:00）
  assert.equal(msToNextBoundary("09:00", "18:00", at(19, 0)), 14 * hour);
  // 跨零点 22:00–06:00，23:00 在窗口内：下一个边界是明天的 end（06:00）
  assert.equal(msToNextBoundary("22:00", "06:00", at(23, 0)), 7 * hour);
  // 正好压在边界上：该边界算「已过」，取下一个
  assert.equal(msToNextBoundary("09:00", "18:00", at(18, 0)), 15 * hour);
});

test("msToNextBoundary 格式不合法返回 null", () => {
  assert.equal(msToNextBoundary("bad", "18:00", at(10, 0)), null);
});
