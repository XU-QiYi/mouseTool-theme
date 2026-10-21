/** 与 Rust 端 `models::CursorPreview` 字段一一对应 */
export interface CursorPreview {
  /** 是否为多帧动态光标 */
  is_animated: boolean;
  /** 首帧 PNG base64，解析失败为空字符串 */
  image: string;
  /** 全部帧 PNG base64 */
  frames: string[];
  /** 动画帧间隔（毫秒），静态光标为 0 */
  rate_ms: number;
  /** 热点坐标 [x, y] */
  hotspot: [number, number];
}
