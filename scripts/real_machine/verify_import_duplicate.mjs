// 真机验证（决策 47）：导入内容相同的包 → ImportReport.duplicate_of 点名已有主题，
// warnings 带人话版，且**不拦截**（库里两套并存）；内容不同不误报。
//
// 与浏览器 mock 不同，这条链路要验证真实指纹（stat 字节数）与逐字节比对；
// 数据根用隔离的 LOCALAPPDATA，不碰用户真实主题，也不改系统光标。
// 前置：应用未运行、vite 已在 1420（见同目录 README）。
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertNoRunningInstance,
  cleanup,
  connectCdp,
  createChecker,
  killApp,
  launchApp,
  prepareRoot,
  waitAppReady,
  waitPageTarget,
} from "./lib.mjs";

const { appdata, pack } = prepareRoot();
const checker = createChecker();
const cursorSource = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "Cursors",
  "aero_arrow.cur",
);

let app = null;
try {
  // a / b 内容完全相同（同一个源文件复制两份）；c 多一个字节（内容不同）
  for (const name of ["dup-a", "dup-b"]) {
    const dir = join(pack, name);
    mkdirSync(dir, { recursive: true });
    copyFileSync(cursorSource, join(dir, "arrow.cur"));
  }
  const diffDir = join(pack, "dup-c");
  mkdirSync(diffDir, { recursive: true });
  const bytes = readFileSync(cursorSource);
  writeFileSync(join(diffDir, "arrow.cur"), Buffer.concat([bytes, Buffer.from([0x00])]));

  assertNoRunningInstance();
  app = launchApp(appdata);
  const page = await waitPageTarget();
  const cdp = connectCdp(page);
  await cdp.opened;
  const ready = await waitAppReady(cdp.evaluate);
  checker.check("应用启动且主题列表就绪", ready);

  const invoke = (command, args) =>
    cdp.evaluate(
      `__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
    );

  const first = await invoke("import_theme", { sourcePath: join(pack, "dup-a") });
  checker.check(
    "首次导入不报重复",
    first?.theme?.id && (first.duplicate_of === null || first.duplicate_of === undefined),
    JSON.stringify(first?.duplicate_of),
  );

  const second = await invoke("import_theme", { sourcePath: join(pack, "dup-b") });
  checker.check(
    "同内容包再导入点名已有主题",
    typeof second?.duplicate_of === "string" && second.duplicate_of === first?.theme?.name,
    `duplicate_of=${JSON.stringify(second?.duplicate_of)}`,
  );
  const dupWarning = (second?.warnings ?? []).find((line) => line.includes("内容完全相同"));
  checker.check(
    "warnings 里有人话版且不拦截导入",
    Boolean(dupWarning) && dupWarning.includes(first?.theme?.name ?? "?"),
    dupWarning ?? "无",
  );

  // 第三套：多了一个字节，指纹（含字节数）与内容都不同，必须不报
  const third = await invoke("import_theme", { sourcePath: join(pack, "dup-c") });
  checker.check(
    "内容不同不误报",
    third?.theme?.id && (third.duplicate_of === null || third.duplicate_of === undefined),
    JSON.stringify(third?.duplicate_of),
  );

  const themes = await invoke("get_all_themes", {});
  const userThemes = (themes?.themes ?? []).filter((theme) => !theme.is_built_in);
  checker.check(
    "重复提示不拦截：三套都在库里",
    userThemes.length === 3,
    `${userThemes.length} 套用户主题`,
  );
  checker.finish("导入重复提示真机验证");
} catch (err) {
  console.error(err);
  checker.check("真机验证执行", false, String(err));
  checker.finish("导入重复提示真机验证");
} finally {
  if (app) {
    killApp();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  cleanup();
}
