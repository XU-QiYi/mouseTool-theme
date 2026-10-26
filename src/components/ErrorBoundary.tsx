import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 顶层错误边界：渲染异常时给出可操作的出口，而不是整窗纯白
 *
 * 只兜渲染期错误；事件处理器与异步代码里的异常仍由各自的 try/catch 与
 * Toast 负责——那是用户操作失败，不该把整个界面换掉。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] 渲染失败：", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="grid h-screen place-items-center bg-background px-6 text-foreground">
        <div className="w-full max-w-md space-y-4 text-center">
          <div className="space-y-1.5">
            <h1 className="text-lg font-medium">界面出了点问题</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              这通常是一次性的渲染故障。重新加载即可；如果反复出现，请把下面的错误信息反馈给我们。
            </p>
          </div>
          <pre
            data-error-boundary
            className="scroll-thin max-h-40 overflow-auto rounded-lg bg-muted p-3 text-left font-mono text-2xs break-all whitespace-pre-wrap text-muted-foreground select-text"
          >
            {error.message || String(error)}
          </pre>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </div>
      </div>
    );
  }
}
