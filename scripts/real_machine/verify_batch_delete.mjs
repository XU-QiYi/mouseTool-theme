// 真机验证（决策 43）：批量删除命令在真实 Tauri 窗口 / 真实主题目录 / 真实回收站下可用。
//
// 与浏览器 mock 不同，这条链路要验证 IPC 参数名、命令注册与 trash 落盘；
// 数据根用隔离的 LOCALAPPDATA，不碰用户真实主题，也不改系统光标。
// 前置：应用未运行、vite 已在 1420（见同目录 README）。
import { copyFileSync, mkdirSync } from "node:fs";
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
  for (const name of ["batch-a", "batch-b"]) {
    const dir = join(pack, name);
    mkdirSync(dir, { recursive: true });
    copyFileSync(cursorSource, join(dir, "arrow.cur"));
  }

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

  const first = await invoke("import_theme", { sourcePath: join(pack, "batch-a") });
  const second = await invoke("import_theme", { sourcePath: join(pack, "batch-b") });
  const firstId = first?.theme?.id;
  const secondId = second?.theme?.id;
  checker.check(
    "两套主题都能导入",
    Boolean(firstId && secondId && firstId !== secondId),
    `${firstId} / ${secondId}`,
  );

  // 重复 ID 只处理一次；非法 ID 只记失败，合法主题照常移走。
  const outcome = await invoke("delete_themes", {
    themeIds: [firstId, secondId, firstId, "not-a-uuid"],
  });
  checker.check(
    "批量删除返回两套成功并去重",
    Array.isArray(outcome?.deleted) &&
      outcome.deleted.length === 2 &&
      outcome.deleted.includes(firstId) &&
      outcome.deleted.includes(secondId),
    JSON.stringify(outcome?.deleted),
  );
  checker.check(
    "非法 ID 只进失败列表",
    Array.isArray(outcome?.failed) &&
      outcome.failed.length === 1 &&
      outcome.failed[0].theme_id === "not-a-uuid" &&
      outcome.failed[0].error.includes("非法"),
    JSON.stringify(outcome?.failed),
  );

  const themes = await invoke("get_all_themes", {});
  const userThemes = (themes?.themes ?? []).filter((theme) => !theme.is_built_in);
  checker.check(
    "删除后主题库只剩系统方案",
    userThemes.length === 0,
    `${userThemes.length} 套用户主题`,
  );

  const trash = await invoke("list_trash", {});
  const entries = trash?.entries ?? [];
  checker.check(
    "两套主题都进入真实回收站",
    entries.length === 2 &&
      entries.some((entry) => entry.theme_id === firstId) &&
      entries.some((entry) => entry.theme_id === secondId),
    `${entries.length} 条`,
  );
  checker.check("回收站条目状态正常", entries.every((entry) => entry.status === "ok"));
  checker.finish("批量删除真机验证");
} catch (err) {
  console.error(err);
  checker.check("真机验证执行", false, String(err));
  checker.finish("批量删除真机验证");
} finally {
  if (app) {
    killApp();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  cleanup();
}
