/**
 * 品牌标记：应用图标里的白色指针，单色版
 *
 * 为什么不直接用完整应用图标：那个图标有四个形状（底板 + 两张卡片 + 指针），
 * 缩到侧栏的 20px 时指针和青蓝卡片会糊成一团蓝色斑块，认不出是什么。
 *
 * 为什么不带石墨底板：深色模式下底板会和背景糊在一起，只剩一个悬空的箭头。
 *
 * 所以这里只取指针的轮廓，用 currentColor 跟随主题 —— 明暗两套都不用额外适配，
 * 形状又和任务栏、开始菜单里的应用图标同源。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="currentColor"
      role="img"
      aria-label="鼠标主题工具"
      className={className}
    >
      <polygon points="188.8,134.4 835.2,437.8 565.1,519.7 699.5,826.9 554.8,889.6 421.7,585 209.2,793.6" />
    </svg>
  );
}
