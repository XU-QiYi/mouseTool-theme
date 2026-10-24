// 动效验收：无头 Edge + CDP，逐帧采样真实的 opacity / translate / scale 与运行中的 transition
// 用法：node scripts/motion_check.mjs [URL]
// 依赖：vite 在 1420 运行；与 dev:bg 必须写在同一条命令里，否则服务会被回收
import { spawn } from "node:child_process";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] ?? "http://localhost:1420";
const PORT = 9224;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 断言框架 ──
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? `  ${detail}` : ""}`);
}
const near = (actual, expected, tol = 0.02) => Math.abs(actual - expected) <= tol;
const isMid = (opacity) => opacity > 0.01 && opacity < 0.99;

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  "--window-size=1200,800",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=" + (process.env.TEMP ?? ".") + "\\edge_headless_profile",
  "about:blank",
]);

try {
  let targets = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === "page")) break;
    } catch {
      /* 端口未就绪，继续等 */
    }
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error("找不到页面调试目标");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, err) => {
    ws.onopen = ok;
    ws.onerror = err;
  });

  let msgId = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.method === "Runtime.exceptionThrown") {
      const d = data.params?.exceptionDetails;
      pageErrors.push(d?.exception?.description ?? d?.text ?? "unknown");
    }
    if (data.method === "Runtime.consoleAPICalled" && data.params?.type === "error") {
      pageErrors.push(data.params.args.map((a) => a.description ?? a.value).join(" "));
    }
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok) => {
      const id = ++msgId;
      pending.set(id, ok);
      ws.send(JSON.stringify({ id, method, params }));
    });

  async function evaluate(expression) {
    const res = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? "页面内执行失败");
    }
    return res.result?.result?.value;
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: URL_TO_OPEN });

  // 首次加载要等 vite 转换模块，固定 sleep 会假失败 —— 轮询到真正就绪为止
  let ready = false;
  for (let i = 0; i < 80; i++) {
    await sleep(300);
    try {
      if (await evaluate(`document.readyState === "complete" && Boolean(window.__toast)`)) {
        ready = true;
        break;
      }
    } catch {
      /* 导航中执行上下文可能被销毁，重试 */
    }
  }
  if (!ready) {
    const diag = await evaluate(
      `JSON.stringify({ url: location.href, title: document.title, root: document.getElementById("root")?.innerHTML.slice(0, 120) })`,
    ).catch(() => "无法读取页面状态");
    check("页面就绪（开发模式 toast 通道可用）", false, String(diag));
    console.log("页面错误：" + (pageErrors.join("\n") || "无"));
    throw new Error("页面未就绪，检查 vite 是否在 1420 运行");
  }
  check("页面就绪（开发模式 toast 通道可用）", true);

  // ── 页面内采样工具：逐帧记录，避免单点采样碰上"过渡还没开始"的假失败 ──
  const WATCH = `
    const readFrame = (el) => {
      const cs = getComputedStyle(el);
      return {
        opacity: Number(cs.opacity),
        translate: cs.translate,
        scale: cs.scale,
        duration: parseFloat(cs.transitionDuration) || 0,
        property: cs.transitionProperty,
        running: el.getAnimations().filter((a) => a.playState === 'running')
          .map((a) => a.transitionProperty || a.animationName),
        starting: el.hasAttribute('data-starting-style'),
        ending: el.hasAttribute('data-ending-style'),
      };
    };
    const watch = async (getEl, ms) => {
      const frames = [];
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        await new Promise((r) => requestAnimationFrame(r));
        const el = getEl();
        frames.push(el ? readFrame(el) : null);
      }
      return frames;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  `;

  // ── 1. Toast 入场 / 退场 ──
  const toast = JSON.parse(
    await evaluate(`(async () => {
      ${WATCH}
      const q = () => document.querySelector('[data-slot="toast"]');
      const out = {};
      const t = window.__toast.success('动效检查', '入场应淡入、上移并轻微放大');
      out.enterFrames = await watch(q, 320);
      await sleep(120);
      out.settled = readFrame(q());
      window.__toast.close(t && t.id ? t.id : t);
      out.exitFrames = await watch(q, 260);
      await sleep(160);
      out.removed = !q();
      return JSON.stringify(out);
    })()`),
  );

  const enter = toast.enterFrames.filter(Boolean);
  const exit = toast.exitFrames.filter(Boolean);
  const enterMid = enter.find((f) => isMid(f.opacity));
  const exitEnding = exit.find((f) => f.ending);
  const exitMid = exit.find((f) => isMid(f.opacity) && f.ending);

  check(
    "toast 入场有进行中的过渡（opacity + 位移）",
    enter.some((f) => f.running.includes("opacity")) && enter.some((f) => f.running.some((p) => p === "translate" || p === "scale")),
    enter.flatMap((f) => f.running).join(",") || "无",
  );
  check("toast 入场时长 240ms", near(enter[0]?.duration ?? 0, 0.24), `${enter[0]?.duration}s`);
  check("toast 入场经历中间态（不是瞬间出现）", Boolean(enterMid), enterMid ? `opacity=${enterMid.opacity.toFixed(3)}` : "未采到");
  check(
    "toast 入场有位移与缩放",
    enter.some((f) => f.translate !== "none" && f.translate !== "0px") && enter.some((f) => f.scale !== "none" && f.scale !== "1"),
    enter.find((f) => f.translate !== "none" && f.translate !== "0px")?.translate ?? "无位移",
  );
  check(
    "toast 落位后不残留位移",
    toast.settled.opacity === 1 && (toast.settled.translate === "none" || toast.settled.translate === "0px"),
    `opacity=${toast.settled.opacity} translate=${toast.settled.translate}`,
  );
  check("toast 退场时长 160ms（比入场快）", near(exitEnding?.duration ?? 0, 0.16), `${exitEnding?.duration}s`);
  check("toast 退场有中间态且带 ending 标记", Boolean(exitMid), exitMid ? `opacity=${exitMid.opacity.toFixed(3)}` : "未采到");
  check("toast 退场结束后从 DOM 移除", toast.removed === true);

  // ── 2. Dialog 入场 / 退场 ──
  const dialog = JSON.parse(
    await evaluate(`(async () => {
      ${WATCH}
      const popup = () => document.querySelector('[data-slot="alert-dialog-popup"]');
      const backdrop = () => document.querySelector('[data-slot="alert-dialog-backdrop"]');
      const byText = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text));
      const out = {};

      const card = byText('Neon Night');
      if (!card) return JSON.stringify({ error: '找不到可删除的示例主题' });
      card.click();
      await sleep(200);

      const del = document.querySelector('[aria-label="删除此主题"]');
      out.deleteEnabled = Boolean(del) && !del.disabled;
      del.click();
      out.enterFrames = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 320) {
        await new Promise((r) => requestAnimationFrame(r));
        const p = popup();
        const b = backdrop();
        out.enterFrames.push(p && b ? { popup: readFrame(p), backdrop: readFrame(b) } : null);
      }
      await sleep(220);
      out.settled = readFrame(popup());

      byText('取消').click();
      out.exitFrames = await watch(popup, 260);
      await sleep(160);
      out.removed = !popup() && !backdrop();
      return JSON.stringify(out);
    })()`),
  );

  const dEnter = (dialog.enterFrames ?? []).filter(Boolean).map((f) => f.popup);
  const bEnter = (dialog.enterFrames ?? []).filter(Boolean).map((f) => f.backdrop);
  const dExit = (dialog.exitFrames ?? []).filter(Boolean);
  const dEnterMid = dEnter.find((f) => isMid(f.opacity));
  const dExitEnding = dExit.find((f) => f.ending);
  const dExitMid = dExit.find((f) => isMid(f.opacity) && f.ending);

  check("删除确认框可打开（用于验证）", dialog.deleteEnabled === true, String(dialog.deleteEnabled));
  check(
    "dialog 入场有 opacity + scale 过渡",
    dEnter.some((f) => f.running.includes("opacity")) && dEnter.some((f) => f.running.includes("scale")),
    [...new Set(dEnter.flatMap((f) => f.running))].join(",") || "无",
  );
  check("dialog 入场时长 240ms", near(dEnter[0]?.duration ?? 0, 0.24), `${dEnter[0]?.duration}s`);
  check(
    "dialog 入场经历中间态（缩放 + 淡入）",
    Boolean(dEnterMid) && dEnter.some((f) => f.scale !== "none" && f.scale !== "1"),
    dEnterMid ? `opacity=${dEnterMid.opacity.toFixed(3)} scale=${dEnterMid.scale}` : "未采到",
  );
  check(
    "遮罩淡入更短（180ms）且也有中间态",
    near(bEnter[0]?.duration ?? 0, 0.18) && bEnter.some((f) => isMid(f.opacity)),
    `${bEnter[0]?.duration}s`,
  );
  check(
    "dialog 落位到最终态",
    dialog.settled?.opacity === 1 && (dialog.settled?.scale === "1" || dialog.settled?.scale === "none"),
    `opacity=${dialog.settled?.opacity} scale=${dialog.settled?.scale}`,
  );
  check("dialog 退场时长 160ms", near(dExitEnding?.duration ?? 0, 0.16), `${dExitEnding?.duration}s`);
  check("dialog 退场是渐隐而不是瞬间消失", Boolean(dExitMid), dExitMid ? `opacity=${dExitMid.opacity.toFixed(3)}` : "未采到");
  check("dialog 退场结束后从 DOM 移除", dialog.removed === true);

  // ── 3. Toast 堆叠让位（FLIP）──
  // 事实：新 toast 前插到栈顶，新增不会推动已有项；移除最旧一条才会让上面的整体落回。
  const flip = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = [];
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        calls.push({
          slot: this.getAttribute('data-slot'),
          frames: JSON.stringify(frames),
          duration: options && options.duration,
        });
        return orig.apply(this, arguments);
      };
      const a = window.__toast.success('最早一条');
      await sleep(450);
      const b = window.__toast.info('较新一条');
      await sleep(450);
      calls.length = 0;
      window.__toast.close(a && a.id ? a.id : a);   // 移除最旧一条：上面的项应平滑落回
      await sleep(500);
      const onRemove = calls.slice();
      Element.prototype.animate = orig;
      window.__toast.close(b && b.id ? b.id : b);
      await sleep(350);
      return JSON.stringify({ onRemove });
    })()`),
  );
  const shift = flip.onRemove.find((c) => c.slot === "toast" && c.frames.includes("translateY"));
  check("移除最旧 toast 时，上方项平滑落回（FLIP）", Boolean(shift), shift ? `${shift.frames.slice(0, 40)}…` : `animate 调用=${flip.onRemove.length}`);
  check("让位时长 180ms", shift?.duration === 180, `${shift?.duration ?? "-"}ms`);

  // ── 3.5 Toast 倒计时条 ──
  // 事实：条长 = 剩余寿命（时长=toast 超时、linear、随时间缩短），挂起与计时器同进退
  const countdown = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = {};
      const t = window.__toast.success('倒计时检查', '条应随剩余时间缩短');
      await sleep(150);
      const bar = document.querySelector('[data-slot="toast-progress"]');
      out.present = Boolean(bar);
      if (!bar) return JSON.stringify(out);
      const anim = bar.getAnimations().find((a) => a.animationName === 'toast-countdown');
      out.duration = anim ? anim.effect.getTiming().duration : 0;
      out.fill = getComputedStyle(bar).animationFillMode;
      const sx = () => {
        const tr = getComputedStyle(bar).transform;
        const m = /matrix\\(([-\\d.eE]+)/.exec(tr);
        return m ? Number(m[1]) : 1;
      };
      out.s1 = sx();
      await sleep(600);
      out.s2 = sx();
      const r = document.querySelector('[data-slot="toast"]').getBoundingClientRect();
      out.point = [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
      return JSON.stringify(out);
    })()`,
    ),
  );
  check(
    "toast 带倒计时条，时长 = toast 超时（success 3200ms）",
    countdown.present === true && countdown.duration === 3200,
    `duration=${countdown.duration}ms fill=${countdown.fill}`,
  );
  check(
    "倒计时条随剩余时间缩短（scaleX 递减）",
    countdown.present && countdown.s2 < countdown.s1,
    `scaleX ${countdown.s1?.toFixed(3)} → ${countdown.s2?.toFixed(3)}`,
  );

  // 悬停走真实指针：mouseenter → base-ui 打 data-expanded → 条挂起；移开后继续走
  let hover = { expanded: false, paused: "", frozen: true, running: "" };
  if (countdown.point) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: countdown.point[0], y: countdown.point[1] });
    await sleep(200);
    hover = JSON.parse(
      await evaluate(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const bar = document.querySelector('[data-slot="toast-progress"]');
        const root = document.querySelector('[data-slot="toast"]');
        const sx = () => {
          const tr = getComputedStyle(bar).transform;
          const m = /matrix\\(([-\\d.eE]+)/.exec(tr);
          return m ? Number(m[1]) : 1;
        };
        const out = { expanded: root.hasAttribute('data-expanded'), paused: getComputedStyle(bar).animationPlayState };
        const a = sx();
        await sleep(400);
        out.frozen = Math.abs(sx() - a) < 1e-6;
        return JSON.stringify(out);
      })()`,
      ),
    );
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
    await sleep(200);
    hover.running = await evaluate(
      `getComputedStyle(document.querySelector('[data-slot="toast-progress"]')).animationPlayState`,
    );
    await evaluate(`window.__toast.close()`);
    await sleep(300);
  }
  check(
    "悬停时倒计时条挂起（data-expanded → paused）且真冻结",
    hover.expanded === true && hover.paused === "paused" && hover.frozen === true,
    `expanded=${hover.expanded} play=${hover.paused} frozen=${hover.frozen}`,
  );
  check("移开后倒计时条继续走", hover.running === "running", `play=${hover.running}`);

  // ── 4. 减少动态偏好 ──
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reduced = JSON.parse(
    await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let animateCalls = 0;
      const orig = Element.prototype.animate;
      Element.prototype.animate = function () { animateCalls += 1; return orig.apply(this, arguments); };
      const t = window.__toast.success('减弱动态');
      await sleep(45);
      const el = document.querySelector('[data-slot="toast"]');
      const cs = getComputedStyle(el);
      const bar = document.querySelector('[data-slot="toast-progress"]');
      const out = {
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        duration: parseFloat(cs.transitionDuration) || 0,
        opacity: Number(cs.opacity),
        // 倒计时条的存在意义就是"看着它缩短"，减少动态下应整体不显示
        barDisplay: bar ? getComputedStyle(bar).display : 'absent',
      };
      await sleep(300);
      window.__toast.close(t && t.id ? t.id : t);
      await sleep(300);
      Element.prototype.animate = orig;
      out.animateCalls = animateCalls;
      return JSON.stringify(out);
    })()`),
  );
  check("reduced-motion 生效", reduced.reduced === true);
  check("reduced-motion 下过渡时长被压到近似 0", reduced.duration < 0.001, `${reduced.duration}s`);
  check("reduced-motion 下 toast 立即到位", reduced.opacity === 1, `opacity=${reduced.opacity}`);
  check("reduced-motion 下不跑 FLIP 动画", reduced.animateCalls === 0, `animate 调用 ${reduced.animateCalls} 次`);
  check("reduced-motion 下倒计时条不显示", reduced.barDisplay === "none", `display=${reduced.barDisplay}`);
  await send("Emulation.setEmulatedMedia", { media: "", features: [] });

  // ── 5. 控件状态过渡 ──
  const controls = JSON.parse(
    await evaluate(`(() => {
      const nav = document.querySelector('nav button');
      const card = [...document.querySelectorAll('button')].find((b) => b.className.includes('rounded-xl'));
      const read = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          property: cs.transitionProperty,
          duration: parseFloat(cs.transitionDuration) || 0,
          easing: cs.transitionTimingFunction,
        };
      };
      return JSON.stringify({ nav: read(nav), card: read(card) });
    })()`),
  );
  check("导航/按钮悬停 120ms", near(controls.nav?.duration ?? 0, 0.12), `${controls.nav?.duration}s ${controls.nav?.easing}`);
  check(
    "主题卡描边变化走 box-shadow（ring 宽度可插值）",
    Boolean(controls.card?.property.includes("box-shadow")) && near(controls.card?.duration ?? 0, 0.18),
    `${controls.card?.duration}s ${controls.card?.property}`,
  );
  check("主题卡过渡用的是标准曲线", (controls.card?.easing ?? "").includes("cubic-bezier(0.2, 0, 0, 1)"), controls.card?.easing);

  check("运行期无 JS 异常", pageErrors.length === 0, pageErrors.join(" | "));

  ws.close();
} finally {
  edge.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[动效验收] ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：" + failed.map((f) => f.name).join("、"));
  process.exitCode = 1;
}
