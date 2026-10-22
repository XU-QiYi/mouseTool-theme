import { useEffect } from "react";
import type { ReactNode } from "react";
import { Copy, FolderOpen, Mouse } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDiagnostics } from "@/hooks/useDiagnostics";
import { toast } from "@/lib/toast";
import { useThemeStore } from "@/stores/themeStore";

/**
 * 设置：应用数据与系统集成的维护入口（决策 11/12）
 *
 * 每一块都是可生长的锚点：新增锚点时在对应区块加一张卡片即可，不动布局骨架。
 * 这一页不依赖主题列表——加载失败时它反而更要可用。
 */
export function SettingsView() {
  const dataDir = useThemeStore((s) => s.dataDir);
  const loadDataDir = useThemeStore((s) => s.loadDataDir);
  const openDataDir = useThemeStore((s) => s.openDataDir);
  const zipMenu = useThemeStore((s) => s.zipMenu);
  const zipMenuError = useThemeStore((s) => s.zipMenuError);
  const loadZipMenuStatus = useThemeStore((s) => s.loadZipMenuStatus);
  const toggleZipMenu = useThemeStore((s) => s.toggleZipMenu);
  const openMousePanel = useThemeStore((s) => s.openMousePanel);

  const diagnostics = useDiagnostics();

  useEffect(() => {
    loadDataDir();
    loadZipMenuStatus();
  }, [loadDataDir, loadZipMenuStatus]);

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics);
      toast.success("已复制诊断信息", "报障时直接粘贴即可");
    } catch {
      // WebView 的剪贴板可能被策略挡住：文本始终可见，手动选中也能用
      toast.error("复制失败", "请手动选中下方文本复制");
    }
  };

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <Section title="数据">
        <div className="rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">数据目录</p>
              <p className="mt-1 text-xs text-muted-foreground">
                存放导入的主题（themes\）与最近使用记录（history.json）；卸载应用不会删除这里。
              </p>
            </div>
            <Button size="sm" className="shrink-0" onClick={openDataDir}>
              <FolderOpen data-icon="inline-start" />
              打开数据目录
            </Button>
          </div>

          {/* 路径可选中复制：报障时用户要能把路径贴给别人 */}
          <p
            data-data-dir
            className="mt-3 break-all font-mono text-2xs text-muted-foreground select-text"
          >
            {dataDir ?? "…"}
          </p>
        </div>

        <div className="rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">诊断信息</p>
              <p className="mt-1 text-xs text-muted-foreground">
                报障时复制这段文本，省得来回描述环境
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={copyDiagnostics}
              disabled={!diagnostics}
            >
              <Copy data-icon="inline-start" />
              复制
            </Button>
          </div>

          <pre
            data-diagnostics
            className="mt-3 font-mono text-2xs break-all whitespace-pre-wrap text-muted-foreground select-text"
          >
            {diagnostics || "…"}
          </pre>
        </div>
      </Section>

      <Section title="系统集成">
        <div className="rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">快捷入口</p>
              <p className="mt-1 text-xs text-muted-foreground">
                指针方案、双击、滚轮速度都在 Windows 的鼠标属性面板里，这里直达（当前定位在「指针」选项卡）
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={openMousePanel}
            >
              <Mouse data-icon="inline-start" />
              鼠标属性面板
            </Button>
          </div>
        </div>

        <div className="rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">右键菜单导入</p>
              <p className="mt-1 text-xs text-muted-foreground">
                第一步点右侧按钮注册；之后在任意 .zip 文件上点右键，菜单里选「用鼠标主题工具导入」，应用会自动导入这份主题包
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={toggleZipMenu}
              disabled={!zipMenu}
            >
              {zipMenu?.registered ? "移除注册" : "注册到右键菜单"}
            </Button>
          </div>

          <p
            data-zip-menu-status
            className="mt-3 break-all text-2xs text-muted-foreground"
          >
            {zipMenuError
              ? "状态读取失败：应用可能是旧版本，重启应用后重试"
              : zipMenu
                ? zipMenu.registered
                  ? `已注册 · 命令指向 ${zipMenu.exe_path}`
                  : "尚未注册，注册后 .zip 右键菜单才会出现导入项"
                : "读取中…"}
          </p>
          <p className="mt-1 text-2xs text-muted-foreground">
            试点功能（先看效果再定去留）：注册的是当前程序位置，移动安装目录后需重新注册
          </p>
        </div>
      </Section>
    </div>
  );
}

/** 区块头：标题 + 撑满的分隔线，口径与图库的分组一致 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-xs font-medium">{title}</h2>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      <div className="max-w-xl space-y-3">{children}</div>
    </section>
  );
}
