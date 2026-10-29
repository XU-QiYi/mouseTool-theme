// 决策 39 真机验证：makecab.exe（微软自家 MSZIP 压缩器）打包的真实 CAB 走真实应用导入，
// 包内 .theme 映射生效、DisplayName 优先于包文件名 stem。前置与说明见同目录 README。
import { writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

// 备料：UTF-16LE .theme + 真实系统光标副本 → makecab（MSZIP）打成一个 .themepack
copyFileSync("C:\\Windows\\Cursors\\aero_arrow.cur", join(pack, "hand.cur"));
copyFileSync("C:\\Windows\\Cursors\\aero_busy.ani", join(pack, "busy.ani"));
const themeText = [
  "[Theme]",
  "DisplayName=真机夜航",
  "",
  "[Control Panel\\Cursors]",
  "Arrow=hand.cur",
  "Wait=busy.ani",
  "NWPen=",
].join("\r\n");
const buf = Buffer.alloc(2 + themeText.length * 2);
buf.writeUInt16LE(0xfeff, 0);
for (let i = 0; i < themeText.length; i += 1) {
  buf.writeUInt16LE(themeText.charCodeAt(i), 2 + i * 2);
}
writeFileSync(join(pack, "night.theme"), buf);
const ddf = [
  ".OPTION EXPLICIT",
  ".Set CabinetNameTemplate=night.themepack",
  ".Set DiskDirectoryTemplate=.",
  ".Set CompressionType=MSZIP",
  ".Set UniqueFiles=OFF",
  "night.theme",
  "hand.cur",
  "busy.ani",
].join("\r\n");
writeFileSync(join(pack, "pack.ddf"), ddf);
execFileSync("makecab", ["/F", "pack.ddf"], { cwd: pack, stdio: "pipe" });
const packPath = join(pack, "night.themepack");

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
        sourcePath: ${JSON.stringify(packPath)},
      });
      return JSON.stringify({
        name: r.theme.name,
        slots: r.theme.cursors.map(c => ({ key: c.registry_key, type: c.file_type, path: c.file_path })),
        warnings: r.warnings,
      });
    })()`),
  );
  check("主题名取包内 .theme 的 DisplayName（而非包文件名 stem）", imported.name === "真机夜航", imported.name);
  check("makecab 的 MSZIP CAB 解档成功", imported.slots.length === 2, JSON.stringify(imported.slots.map((s) => s.key)));
  check("槽位按包内 .theme 方案映射", ["Arrow", "Wait"].every((k) => imported.slots.some((s) => s.key === k)), JSON.stringify(imported.slots.map((s) => s.key)));
  check("引用无警告", imported.warnings.length === 0, JSON.stringify(imported.warnings));
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
  check("解压出的系统光标可真实解码", decoded.every((r) => r === "decoded"), JSON.stringify(decoded));

  check("运行期无 JS 异常", cdp.pageErrors.length === 0, `errors=${cdp.pageErrors.length}`);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(process.env.TEMP ?? ".", "rm_verify_themepack.png"), Buffer.from(shot.result.data, "base64"));
} finally {
  killApp();
  cleanup();
  await sleep(200);
  app.kill();
}
finish("真机验证·themepack");
