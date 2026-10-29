// 决策 36 真机验证：UTF-16LE .theme 解析、%SystemRoot% 展开到真实系统光标、
// 同目录相对路径收编、真机查重成组。前置与说明见同目录 README。
import { writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  prepareRoot,
  assertNoRunningInstance,
  launchApp,
  waitPageTarget,
  connectCdp,
  waitAppReady,
  killApp,
  cleanup,
  sleep,
  createChecker,
} from "./lib.mjs";

const { appdata, pack } = prepareRoot();
assertNoRunningInstance();

// 备料：.theme（UTF-16LE + BOM）混合三种引用形态；相对路径用真实系统光标的副本
copyFileSync("C:\\Windows\\Cursors\\aero_arrow.cur", join(pack, "arrow_local.cur"));
const themeText = [
  "[Theme]",
  "DisplayName=真机夜航",
  "",
  "; 混合 %SystemRoot% 绝对引用与主题包内相对引用",
  "[Control Panel\\Cursors]",
  "Arrow=%SystemRoot%\\Cursors\\aero_arrow.cur",
  "Wait=%SystemRoot%\\Cursors\\aero_busy.ani",
  "Hand=arrow_local.cur",
  "NWPen=",
  "DefaultValue=Windows Aero",
  "Link=",
].join("\r\n");
const buf = Buffer.alloc(2 + themeText.length * 2);
buf.writeUInt16LE(0xfeff, 0);
for (let i = 0; i < themeText.length; i += 1) {
  buf.writeUInt16LE(themeText.charCodeAt(i), 2 + i * 2);
}
const schemePath = join(pack, "夜航.theme");
writeFileSync(schemePath, buf);

const app = launchApp(appdata);
const { check, finish } = createChecker();
try {
  const page = await waitPageTarget();
  const cdp = connectCdp(page);
  await cdp.opened;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  check("应用窗口就绪", await waitAppReady(cdp.evaluate));

  const imported = JSON.parse(
    await cdp.evaluate(`(async () => {
      const r = await window.__TAURI_INTERNALS__.invoke("import_theme", {
        sourcePath: ${JSON.stringify(schemePath)},
      });
      return JSON.stringify({
        name: r.theme.name,
        slots: r.theme.cursors.map(c => ({ key: c.registry_key, type: c.file_type, path: c.file_path })),
        warnings: r.warnings,
      });
    })()`),
  );
  check("主题名取自 DisplayName", imported.name === "真机夜航", imported.name);
  check("三个槽位全部收编", imported.slots.length === 3, JSON.stringify(imported.slots.map((s) => s.key)));
  check(
    "槽位键正确且扩展名归类正确",
    ["Arrow:cur", "Wait:ani", "Hand:cur"].every((want) =>
      imported.slots.some((s) => `${s.key}:${s.type}` === want),
    ),
    JSON.stringify(imported.slots.map((s) => `${s.key}:${s.type}`)),
  );
  check("引用无警告（空值槽位不算）", imported.warnings.length === 0, JSON.stringify(imported.warnings));
  check(
    "复制文件落在隔离数据根",
    imported.slots.every((s) => s.path.includes("cs-rm-verify\\appdata")),
    imported.slots.map((s) => s.path).join(" | ").slice(0, 140),
  );

  const decoded = JSON.parse(
    await cdp.evaluate(`(async () => {
      const out = [];
      for (const p of ${JSON.stringify(imported.slots.map((s) => s.path))}) {
        try {
          const meta = await window.__TAURI_INTERNALS__.invoke("get_cursor_preview", { filePath: p });
          out.push(meta ? "decoded" : "null");
        } catch (e) { out.push("error:" + String(e).slice(0, 40)); }
      }
      return JSON.stringify(out);
    })()`),
  );
  check("复制出的光标可真实解码", decoded.every((r) => r === "decoded"), JSON.stringify(decoded));

  // 同一方案再导一份 → 真机查重成组
  await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke("import_theme", { sourcePath: ${JSON.stringify(schemePath)} })`);
  const dup = JSON.parse(await cdp.evaluate(`(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke("find_duplicate_themes")))()`));
  check("导入两份后真机查重报 1 组", dup.groups.length === 1, `groups=${dup.groups.length} scanned=${dup.scanned}`);
  check(
    "组内两套、可省字节等于单套体积",
    dup.groups[0]?.theme_ids.length === 2 && dup.wasted_bytes === dup.groups[0]?.bytes,
    JSON.stringify(dup.groups[0]),
  );

  check("运行期无 JS 异常", cdp.pageErrors.length === 0, `errors=${cdp.pageErrors.length}`);
  await sleep(300);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(process.env.TEMP ?? ".", "rm_verify_theme.png"), Buffer.from(shot.result.data, "base64"));
} finally {
  killApp();
  cleanup();
  await sleep(200);
  app.kill();
}
finish("真机验证·theme 方案");
