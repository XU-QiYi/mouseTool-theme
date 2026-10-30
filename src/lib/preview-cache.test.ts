import assert from "node:assert/strict";
import { test } from "node:test";

import { PreviewCache } from "./preview-cache.ts";

test("容量封顶：超出淘汰最久未放入的", () => {
  const cache = new PreviewCache<number>(3);
  cache.put("a", 1);
  cache.put("b", 2);
  cache.put("c", 3);
  cache.put("d", 4);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("d"), 4);
});

test("命中刷新新近度：没摸过的先被淘汰", () => {
  const cache = new PreviewCache<number>(3);
  cache.put("a", 1);
  cache.put("b", 2);
  cache.put("c", 3);
  assert.equal(cache.get("a"), 1, "摸 a 一次");
  cache.put("d", 4);
  assert.equal(cache.get("b"), undefined, "b 最久未用，先淘汰");
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("d"), 4);
});

test("重复 put 同一个键不重复计数，且移到最新端", () => {
  const cache = new PreviewCache<number>(2);
  cache.put("x", 1);
  cache.put("y", 2);
  cache.put("x", 10);
  assert.equal(cache.size, 2);
  cache.put("z", 3);
  assert.equal(cache.get("x"), 10);
  assert.equal(cache.get("y"), undefined);
});

test("前缀失效只清命中条目", () => {
  const cache = new PreviewCache<number>(10);
  cache.put("C:\\themes\\a\\arrow.cur", 1);
  cache.put("C:\\themes\\a\\wait.ani", 2);
  cache.put("C:\\themes\\b\\arrow.cur", 3);
  cache.invalidate("C:\\themes\\a\\");
  assert.equal(cache.get("C:\\themes\\a\\arrow.cur"), undefined);
  assert.equal(cache.get("C:\\themes\\b\\arrow.cur"), 3);
});

test("不带前缀全清", () => {
  const cache = new PreviewCache<number>(10);
  cache.put("a", 1);
  cache.put("b", 2);
  cache.invalidate();
  assert.equal(cache.size, 0);
});
