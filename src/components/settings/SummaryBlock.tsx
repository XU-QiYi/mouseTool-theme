/** 「设置 → 数据」子页顶部的一格统计（备份历史 / 回收站共用） */
export function SummaryBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium tabular-nums" title={value}>
        {value}
      </p>
    </div>
  );
}
