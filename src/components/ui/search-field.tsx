import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** 占位符，同时作为无障碍名称 */
  placeholder: string;
  className?: string;
}

/**
 * 页头搜索框：受控、可一键清除
 *
 * `data-search-input` 是 Ctrl+F 的聚焦锚点（`lib/shortcuts.ts`），
 * 也是验收脚本识别搜索框的钩子。原生清除按钮在 App.css 里统一藏掉，
 * 用自己的清除按钮才能做到「清空后焦点留在框里继续输」。
 */
export function SearchField({ value, onChange, placeholder, className }: SearchFieldProps) {
  return (
    <div className={cn("relative w-56", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        data-search-input
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value !== "") {
            event.preventDefault();
            onChange("");
          }
        }}
        className="focus-ring h-8 w-full rounded-lg border border-input bg-transparent pr-7 pl-7.5 text-xs outline-none placeholder:text-muted-foreground"
      />
      {value !== "" && (
        <button
          type="button"
          aria-label="清除搜索"
          onClick={() => {
            onChange("");
            document.querySelector<HTMLInputElement>("[data-search-input]")?.focus();
          }}
          className="focus-ring absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
