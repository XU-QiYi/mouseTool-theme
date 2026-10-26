import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Copy, RefreshCw, Stethoscope, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { SettingCard } from "@/components/settings/SettingCard";
import { useAppVersion } from "@/hooks/use-app-version";
import { toast } from "@/lib/toast";
import { appliedAtMachine } from "@/lib/themes";
import { getWindowsVersion } from "@/services/system";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThemeStore } from "@/stores/themeStore";
import { cn } from "@/lib/utils";

/** 严重度：ok < warning < error，整体取四项最大值 */
type Severity = "ok" | "warning" | "error";

const SEVERITY_ORDER: Record<Severity, number> = { ok: 0, warning: 1, error: 2 };

const SEVERITY_BADGE: Record<Severity, ReactNode> = {
  ok: (
    <StatusBadge tone="success" dot>
      正常
    </StatusBadge>
  ),
  warning: (
    <StatusBadge tone="warning" dot>
      注意
    </StatusBadge>
  ),
  error: (
    <StatusBadge tone="warning" dot>
      异常
    </StatusBadge>
  ),
};

const SEVERITY_ICON: Record<Severity, ReactNode> = {
  ok: <CircleCheck className="size-4 text-success" />,
  warning: <TriangleAlert className="size-4 text-warning" />,
  error: <CircleAlert className="size-4 text-warning" />,
};

const SEVERITY_LABEL: Record<Severity, string> = { ok: "正常", warning: "注意", error: "异常" };

interface DiagnosticCheck {
  id: string;
  title: string;
  severity: Severity;
  /** 一行结论（状态块与详情页头部共用） */
  summary: string;
  /** 证据：路径 / 错误原文 / 统计口径 */
  evidence: string[];
  /** 建议（没有可建议的就 null） */
  advice: string | null;
  action?: { label: string; run: () => void };
}

interface DiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function localStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * 诊断中心：只读体检报告
 *
 * 检查数据全部从现有 store 派生（`useMemo` 组装，不写 selector），
 * 不新增命令、不做任何写操作。严重度只用结构化状态判定
 * （loadError / dataDirError / autostartError / warnings），不从错误文本猜分类。
 */
export function DiagnosticsDialog({ open, onOpenChange }: DiagnosticsDialogProps) {
  const version = useAppVersion();
  const themes = useThemeStore((s) => s.themes);
  const loadError = useThemeStore((s) => s.loadError);
  const warnings = useThemeStore((s) => s.warnings);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const activeExternal = useThemeStore((s) => s.activeExternal);
  const currentSlotsFilled = useThemeStore((s) => s.currentSlotsFilled);
  const dataDir = useThemeStore((s) => s.dataDir);
  const dataDirError = useThemeStore((s) => s.dataDirError);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadAutostart = useSettingsStore((s) => s.loadAutostart);
  const settings = useSettingsStore((s) => s.settings);
  const settingsError = useSettingsStore((s) => s.settingsError);
  const autostart = useSettingsStore((s) => s.autostart);
  const autostartError = useSettingsStore((s) => s.autostartError);

  const [selectedId, setSelectedId] = useState<string>("data-dir");
  const [scannedAt, setScannedAt] = useState<string>(localStamp);
  const [scanning, setScanning] = useState(false);
  const [windows, setWindows] = useState<string>("…");

  // 打开时刷新一次系统版本（只读静态信息，失败保留「未知」）
  useEffect(() => {
    if (!open) return;
    void getWindowsVersion()
      .then(setWindows)
      .catch(() => setWindows("未知"));
  }, [open]);

  const checks = useMemo<DiagnosticCheck[]>(() => {
    const builtIn = themes.filter((theme) => theme.is_built_in).length;
    const mine = themes.length - builtIn;
    const activeTheme = themes.find((theme) => theme.id === activeThemeId) ?? null;
    const activeMissing = Boolean(activeThemeId) && !activeTheme;

    return [
      {
        id: "data-dir",
        title: "数据目录",
        severity: dataDirError ? "error" : dataDir ? "ok" : "warning",
        summary: dataDirError ? "读取失败" : (dataDir ?? "还没有读到路径"),
        evidence: [dataDirError ?? dataDir ?? "路径尚未读取（点「重新扫描」会重试）"],
        advice: dataDirError ? "重试读取；仍失败时检查数据目录是否被占用或权限受限" : null,
        action: { label: "打开数据目录", run: () => void useThemeStore.getState().openDataDir() },
      },
      {
        id: "themes",
        title: "主题数据",
        severity: loadError ? "error" : warnings.length > 0 ? "warning" : "ok",
        summary: loadError ? "读取失败" : `系统 ${builtIn} 套 · 我的 ${mine} 套`,
        evidence: loadError
          ? [loadError]
          : warnings.length === 0
            ? [`共 ${themes.length} 套主题，全部数据源读取正常`]
            : [
                ...warnings.slice(0, 6),
                ...(warnings.length > 6 ? [`还有 ${warnings.length - 6} 条提示`] : []),
              ],
        advice: loadError
          ? "重试读取；「打开数据目录」可以核对文件是否还在"
          : warnings.length > 0
            ? "按提示处理；被跳过的数据源不影响其余主题"
            : null,
        action: loadError
          ? { label: "重试读取", run: () => void useThemeStore.getState().loadThemes() }
          : {
              label: "去「我的主题」",
              run: () => {
                onOpenChange(false);
                useThemeStore.getState().setCurrentPage("mine");
              },
            },
      },
      {
        id: "active",
        title: "当前使用",
        severity: loadError ? "error" : activeExternal || activeMissing ? "warning" : "ok",
        summary: loadError
          ? "读取失败"
          : activeTheme
            ? `正在使用「${activeTheme.name}」`
            : activeExternal
              ? "已被系统设置改写"
              : "系统默认光标",
        evidence: [
          activeExternal
            ? `注册表有 ${currentSlotsFilled} 个非空槽位，但不匹配任何已加载主题（常见于在系统设置里改过指针样式，或用过其它光标工具）`
            : activeMissing
              ? `注册表指向的主题（${activeThemeId}）已不在列表里，可能是目录被手动删除`
              : (activeTheme?.name ?? "系统默认"),
          "当前使用由注册表反推，窗口聚焦时会自动重查",
        ],
        advice: activeExternal
          ? "重新应用任意主题即可夺回，或「还原系统默认」清空被占用的槽位"
          : activeMissing
            ? "重新应用任意主题，或还原系统默认，注册表会重新指向有效文件"
            : null,
        action: {
          label: "打开鼠标属性面板",
          run: () => void useThemeStore.getState().openMousePanel(),
        },
      },
      {
        id: "settings",
        title: "应用设置",
        severity: settingsError ? "error" : autostartError || !autostart ? "warning" : "ok",
        summary: settingsError
          ? "读取失败"
          : `关闭行为：${settings?.close_behavior === "tray" ? "最小化到托盘" : "直接退出"} · 自启动：${
              autostart ? (autostart.enabled ? "已开启" : "未开启") : "未读到"
            }`,
        evidence: [settingsError ?? autostartError ?? "settings.json 与自启动注册表读取正常"],
        advice: settingsError
          ? "重启应用通常可以恢复（典型原因：前端新、Rust 旧）"
          : autostartError || !autostart
            ? "到「设置 → 通用」重试读取自启动状态"
            : null,
        action: {
          label: "去「设置 → 通用」",
          run: () => useThemeStore.getState().setSettingsSection("general"),
        },
      },
    ];
  }, [themes, loadError, warnings, activeThemeId, dataDir, dataDirError, settings, settingsError, autostart, autostartError, onOpenChange]);

  const overall = checks.reduce<Severity>(
    (worst, check) =>
      SEVERITY_ORDER[check.severity] > SEVERITY_ORDER[worst] ? check.severity : worst,
    "ok",
  );
  const selected = checks.find((check) => check.id === selectedId) ?? checks[0];

  const rescan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      // 只读重扫：四个来源并行重读，完成后更新扫描时间
      await Promise.all([
        useThemeStore.getState().loadThemes(),
        useThemeStore.getState().loadDataDir(),
        loadSettings(),
        loadAutostart(),
      ]);
      setScannedAt(localStamp());
    } finally {
      setScanning(false);
    }
  };

  const copyReport = async () => {
    const lines = [
      `鼠标主题工具 v${version}`,
      `系统：${windows}`,
      `扫描时间：${scannedAt}`,
      "",
      ...checks.flatMap((check) => [
        `[${SEVERITY_LABEL[check.severity]}] ${check.title}：${check.summary}`,
        ...check.evidence.map((line) => `  ${line}`),
      ]),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success("已复制诊断报告", "报障时直接粘贴即可");
    } catch {
      // WebView 的剪贴板可能被策略挡住：给出可手动复制的兜底
      toast.error("复制失败", "请展开各项检查，手动选中文字复制");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          data-diagnostics-dialog
          className="flex max-h-[70vh] w-[48rem] max-w-3xl flex-col"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle>诊断中心</DialogTitle>
              <DialogDescription>
                检查数据目录、主题、当前使用与设置；只读，不修改任何文件
              </DialogDescription>
            </div>
            <span className="pt-1 shrink-0">
              <StatusBadge tone={overall === "ok" ? "success" : "warning"} dot>
                {overall === "ok" ? "一切正常" : `有${overall === "warning" ? "需要注意" : "读取失败"}的项`}
              </StatusBadge>
            </span>
          </div>

          {/* 顶部摘要：四项各一块，严重度图标 + 标题 + 一行结论 */}
          <div className="mt-4 grid grid-cols-4 gap-2">
            {checks.map((check) => (
              <button
                key={check.id}
                type="button"
                data-diagnostic-check={check.id}
                data-diagnostic-severity={check.severity}
                onClick={() => setSelectedId(check.id)}
                aria-pressed={selectedId === check.id}
                className={cn(
                  "focus-ring rounded-lg p-2.5 text-left ring-1 transition-[background-color,box-shadow] duration-(--motion-fast) ease-standard",
                  selectedId === check.id
                    ? "bg-accent ring-2 ring-primary"
                    : "ring-foreground/10 hover:bg-muted/50",
                )}
              >
                <span className="flex items-center gap-1.5">
                  {SEVERITY_ICON[check.severity]}
                  <span className="text-xs font-medium">{check.title}</span>
                </span>
                <span
                  className="mt-1 block truncate text-2xs text-muted-foreground"
                  title={check.summary}
                >
                  {check.summary}
                </span>
              </button>
            ))}
          </div>

          {/* 主体两栏：左检查项列表，右详情 */}
          <div className="mt-4 flex min-h-0 flex-1 gap-4">
            <div className="scroll-thin w-60 shrink-0 overflow-y-auto pr-1">
              <ul className="space-y-1">
                {checks.map((check) => (
                  <li key={check.id}>
                    <button
                      type="button"
                      data-diagnostic-check={check.id}
                      data-diagnostic-severity={check.severity}
                      onClick={() => setSelectedId(check.id)}
                      aria-pressed={selectedId === check.id}
                      className={cn(
                        "focus-ring flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-[background-color] duration-(--motion-fast) ease-standard",
                        selectedId === check.id ? "bg-accent font-medium" : "hover:bg-muted/50",
                      )}
                    >
                      <span className="truncate">{check.title}</span>
                      {SEVERITY_BADGE[check.severity]}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="scroll-thin min-w-0 flex-1 overflow-y-auto pl-1">
              <p className="text-sm font-medium">{selected.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{selected.summary}</p>

              <p className="mt-3 text-2xs font-medium text-muted-foreground">证据</p>
              <ul className="mt-1 space-y-1">
                {selected.evidence.map((line, index) => (
                  <li
                    key={index}
                    className="break-all font-mono text-2xs leading-relaxed text-muted-foreground select-text"
                  >
                    {line}
                  </li>
                ))}
              </ul>

              {selected.advice && (
                <>
                  <p className="mt-3 text-2xs font-medium text-muted-foreground">建议</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {selected.advice}
                  </p>
                </>
              )}

              {selected.action && (
                <Button size="sm" variant="outline" className="mt-4" onClick={selected.action.run}>
                  {selected.action.label}
                </Button>
              )}
            </div>
          </div>

          {/* 页脚：扫描时间 + 动作。扫描时间是客户端时钟，不代表文件修改时间 */}
          <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
            <time
              dateTime={appliedAtMachine(scannedAt)}
              className="text-2xs text-muted-foreground tabular-nums"
            >
              本次扫描：{scannedAt}
            </time>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void rescan()} disabled={scanning}>
                <RefreshCw data-icon="inline-start" />
                {scanning ? "扫描中…" : "重新扫描"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copyReport()}>
                <Copy data-icon="inline-start" />
                复制报告
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** 「设置 → 数据」里的入口卡：打开诊断中心（替代原先整段 <pre> 诊断文本） */
export function DiagnosticsCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingCard
        title="诊断中心"
        description="检查数据目录、主题数据、当前使用与应用设置；只读，不修改任何文件"
        action={
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Stethoscope data-icon="inline-start" />
            运行诊断
          </Button>
        }
      />
      <DiagnosticsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
