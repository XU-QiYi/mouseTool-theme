import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, parseVersion } from "./semver.ts";

test("parseVersion 认 v 前缀与裸三段", () => {
  assert.deepEqual(parseVersion("v0.2.0"), [0, 2, 0]);
  assert.deepEqual(parseVersion("0.2.0"), [0, 2, 0]);
  assert.deepEqual(parseVersion("v10.20.30"), [10, 20, 30]);
});

test("parseVersion 忽略前后空白与预发布后缀", () => {
  assert.deepEqual(parseVersion("  v1.2.3-beta.1 "), [1, 2, 3]);
  assert.deepEqual(parseVersion("v1.2.3+build"), [1, 2, 3]);
});

test("parseVersion 拒绝不合法前缀", () => {
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("abc"), null);
  assert.equal(parseVersion("v1"), null);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("版本 1.2.3"), null);
});

test("compareVersions 逐位比较", () => {
  assert.equal(compareVersions([0, 3, 0], [0, 2, 9]), 1);
  assert.equal(compareVersions([0, 2, 9], [0, 3, 0]), -1);
  assert.equal(compareVersions([1, 0, 0], [0, 99, 99]), 1);
  assert.equal(compareVersions([0, 2, 0], [0, 2, 0]), 0);
});
