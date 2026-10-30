// 真机可行性验证（决策 51 前置）：光标大小（修复规划 G9）
//
// 与同目录其它脚本不同：这里**不启动应用**（光标大小还没有任何命令），
// 直接用 reg.exe + PowerShell 在真实注册表上验证：
//   1. `HKCU\Control Panel\Cursors\CursorBaseSize`（修复规划作者的猜测）写入
//      + SPI 后活动光标是否缩放；
//   2. `HKCU\Software\Microsoft\Accessibility\CursorSize`（辅助功能滑杆）
//      写入 + SPI 后活动光标是否缩放；
//   3. 两种值系统是否会改写，以及还原是否干净。
//
// 「缩放」的客观证据：GetCursorInfo → GetIconInfo → BITMAP 尺寸——
// 活动光标实际加载的位图宽高，不靠肉眼。
//
// 安全：开工前 `reg export` 整键备份 + 两个键逐值快照；收工恢复原值并再次
// 快照比对，残留即失败（退出码 2，提示用备份手工 `reg import`）。
// 结论是**可行性证据**，不是功能落地；视觉口径（.ani 是否跟着缩放）仍需人工看一眼。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY = "HKCU\\Control Panel\\Cursors";
const VALUE = "CursorBaseSize";
const A11Y_KEY = "HKCU\\Software\\Microsoft\\Accessibility";
const A11Y_VALUE = "CursorSize";
const TEST_SIZE = 96; // 默认约 32 的三倍
const TEST_A11Y = 7; // 辅助功能滑杆 1–15 的中段
const BACKUP = join(process.env.TEMP ?? ".", "cs-cursor-size-backup.reg");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? `  ${detail}` : ""}`);
};

const reg = (args) => execFileSync("reg", args, { encoding: "utf8" });

const ps = (script) =>
  execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" },
  ).trim();

/** 逐值快照：名字 / 类型 / 数据（恢复比对用） */
function snapshot(key) {
  const out = reg(["query", key]);
  const values = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s{4}(\S+)\s+(REG_\S+)\s+(.*)$/.exec(line);
    if (m) values[m[1]] = `${m[2]} ${m[3]}`;
  }
  return values;
}

/** 实际加载中的光标位图尺寸（缩放与否的客观证据） */
function cursorBitmapSize() {
  return ps(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CursorProbe {
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public IntPtr ptScreenPos; }
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAP { public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes; public short bmPlanes; public short bmBitsPixel; public IntPtr bmBits; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO info);
  [DllImport("gdi32.dll")] public static extern int GetObject(IntPtr h, int c, ref BITMAP b);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
}
"@
$ci = New-Object CursorProbe+CURSORINFO
$ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ci)
[void][CursorProbe]::GetCursorInfo([ref]$ci)
$ii = New-Object CursorProbe+ICONINFO
[void][CursorProbe]::GetIconInfo($ci.hCursor, [ref]$ii)
$bm = New-Object CursorProbe+BITMAP
[void][CursorProbe]::GetObject($ii.hbmColor, [System.Runtime.InteropServices.Marshal]::SizeOf($bm), [ref]$bm)
if ($ii.hbmColor -ne [IntPtr]::Zero) { [void][CursorProbe]::DeleteObject($ii.hbmColor) }
if ($ii.hbmMask -ne [IntPtr]::Zero) { [void][CursorProbe]::DeleteObject($ii.hbmMask) }
Write-Output "$($bm.bmWidth)x$($bm.bmHeight)"
`);
}

/** SPI_SETCURSORS：只带 SPIF_SENDCHANGE（本机带 SPIF_UPDATEINIFILE 会失败，硬约束 2） */
function refreshCursors() {
  return ps(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SpiProbe {
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, IntPtr vparam, uint init);
}
"@
if ([SpiProbe]::SystemParametersInfo(0x57, 0, [IntPtr]::Zero, 0x2)) { Write-Output "ok" } else { Write-Output "failed" }
`);
}

/** 写一个 DWORD 值 */
function setDword(key, name, value) {
  reg(["add", key, "/v", name, "/t", "REG_DWORD", "/d", String(value), "/f"]);
}

/** 还原一个值：原来没有就删除 */
function restoreValue(key, name, original) {
  if (original === null) {
    reg(["delete", key, "/v", name, "/f"]);
  } else {
    const type = original.startsWith("REG_DWORD") ? "REG_DWORD" : "REG_SZ";
    const data = original.replace(/^\S+\s+/, "");
    reg(["add", key, "/v", name, "/t", type, "/d", data, "/f"]);
  }
}

/** 残留比对：两个键的值名单向快照看齐 */
function residue(beforeMaps, afterMaps) {
  const diffs = [];
  for (const [key, before] of beforeMaps) {
    const after = afterMaps.get(key);
    const extra = Object.keys(after).filter((name) => !(name in before));
    const lost = Object.keys(before).filter((name) => !(name in after));
    const changed = Object.keys(before).filter(
      (name) => name in after && before[name] !== after[name],
    );
    if (extra.length || lost.length || changed.length) {
      diffs.push(`${key}：多出 ${extra.join(", ") || "无"}；丢失 ${lost.join(", ") || "无"}；变化 ${changed.join(", ") || "无"}`);
    }
  }
  return diffs;
}

let beforeCursors = null;
let beforeA11y = null;
let exitCode = 0;
try {
  beforeCursors = snapshot(KEY);
  let a11yExists = true;
  try {
    beforeA11y = snapshot(A11Y_KEY);
  } catch {
    a11yExists = false; // 辅助功能键可能整个不存在
    beforeA11y = {};
  }
  const originalBase = Object.hasOwn(beforeCursors, VALUE) ? beforeCursors[VALUE] : null;
  const originalA11y = a11yExists && Object.hasOwn(beforeA11y, A11Y_VALUE) ? beforeA11y[A11Y_VALUE] : null;
  console.log(
    `开工：Cursors 键 ${Object.keys(beforeCursors).length} 个值（CursorBaseSize ${originalBase ?? "无"}）；Accessibility\\CursorSize ${originalA11y ?? "无"}`,
  );
  reg(["export", KEY, BACKUP, "/y"]);
  console.log(`Cursors 整键已备份到 ${BACKUP}`);

  const baseline = cursorBitmapSize();
  check("能读到当前光标位图尺寸", /^\d+x\d+$/.test(baseline), baseline);

  // 实验一：修复规划猜测的 CursorBaseSize
  setDword(KEY, VALUE, TEST_SIZE);
  const refresh1 = refreshCursors();
  const scaled1 = cursorBitmapSize();
  check("实验一 SPI 刷新成功", refresh1 === "ok");
  check(
    `实验一 CursorBaseSize=${TEST_SIZE} 后光标缩放`,
    scaled1 !== baseline,
    `${baseline} → ${scaled1}（无变化 = 该键不驱动当前会话的指针大小）`,
  );

  // 实验二：辅助功能滑杆键
  setDword(A11Y_KEY, A11Y_VALUE, TEST_A11Y);
  const refresh2 = refreshCursors();
  const scaled2 = cursorBitmapSize();
  check("实验二 SPI 刷新成功", refresh2 === "ok");
  check(
    `实验二 Accessibility\\CursorSize=${TEST_A11Y} 后光标缩放`,
    scaled2 !== baseline,
    `${baseline} → ${scaled2}`,
  );

  // 系统会不会改写这些值
  const midCursors = snapshot(KEY);
  const midA11y = a11yExists ? snapshot(A11Y_KEY) : {};
  check(
    "写入值保持原样（系统不改写）",
    midCursors[VALUE]?.startsWith("REG_DWORD") &&
      (a11yExists ? midA11y[A11Y_VALUE]?.startsWith("REG_DWORD") : true),
    `${midCursors[VALUE] ?? "缺"} / ${midA11y[A11Y_VALUE] ?? "缺"}`,
  );

  // 还原 + 复测
  restoreValue(KEY, VALUE, originalBase);
  restoreValue(A11Y_KEY, A11Y_VALUE, originalA11y);
  check("还原后 SPI 刷新成功", refreshCursors() === "ok");
  const restored = cursorBitmapSize();
  check("还原后位图回原", restored === baseline, `${scaled2} → ${restored}`);

  const finalCursors = snapshot(KEY);
  const finalA11y = a11yExists ? snapshot(A11Y_KEY) : {};
  const diffs = residue(
    new Map([
      [KEY, beforeCursors],
      [A11Y_KEY, beforeA11y],
    ]),
    new Map([
      [KEY, finalCursors],
      [A11Y_KEY, finalA11y],
    ]),
  );
  check("注册表无残留（两键逐值比对）", diffs.length === 0, diffs.join("；") || "干净");

  writeFileSync(
    join(process.env.TEMP ?? ".", "cs-cursor-size-evidence.json"),
    JSON.stringify({ baseline, scaled1, scaled2, restored, beforeCursors, finalCursors }, null, 2),
  );
} catch (err) {
  check("真机验证执行", false, String(err));
  exitCode = 2;
} finally {
  // 兜底还原：哪怕中途抛错也要把两个键恢复掉
  if (beforeCursors) {
    try {
      restoreValue(KEY, VALUE, Object.hasOwn(beforeCursors, VALUE) ? beforeCursors[VALUE] : null);
      if (beforeA11y) {
        restoreValue(
          A11Y_KEY,
          A11Y_VALUE,
          Object.hasOwn(beforeA11y, A11Y_VALUE) ? beforeA11y[A11Y_VALUE] : null,
        );
      }
      refreshCursors();
      const done = snapshot(KEY);
      const extra = Object.keys(done).filter((name) => !(name in beforeCursors));
      if (extra.length > 0) {
        console.error(`还原后仍有残留值，请手工检查并用备份恢复：${extra.join(", ")}`);
        exitCode = 2;
      }
    } catch (restoreErr) {
      console.error(`自动还原失败（${restoreErr}）；请用 ${BACKUP} 手工 reg import`);
      exitCode = 2;
    }
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n[光标大小真机验证] ${results.length - failed}/${results.length} 通过`);
  process.exitCode = exitCode !== 0 ? 2 : failed > 0 ? 1 : 0;
}
