/**
 * 版本号三段解析与比较（决策 49）
 *
 * 从 `update-check.ts` 抽出的纯函数：模块本身带运行时依赖（Tauri API、
 * fetch），没法用 `node --test` 直接跑；比较逻辑单独成文件后零依赖可单测。
 */

export type VersionTriple = [number, number, number];

/** `v0.2.0` / `0.2.0` → 三段数字；前缀不合法返回 null（后缀如 `-beta` 忽略） */
export function parseVersion(raw: string): VersionTriple | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 三段逐位比较：a 大返回 1，b 大返回 -1，相等返回 0 */
export function compareVersions(a: VersionTriple, b: VersionTriple): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}
