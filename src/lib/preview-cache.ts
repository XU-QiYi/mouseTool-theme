/**
 * 预览缓存：有界 LRU + 按前缀失效（决策 45）
 *
 * 应用常驻托盘，会话可以很长；每条预览是 base64 帧（动态光标最多 32 帧、
 * 最长边 128px），不设上限会无界增长。超限淘汰最久未用——手写 LRU（Map
 * 迭代按插入序），与后端 `utils/cursor.rs` 的预览 LRU 同思路，不为此引
 * 依赖（决策 27）。纯数据结构、零依赖，可被单测直接导入。
 */
export class PreviewCache<T> {
  private map = new Map<string, T>();
  /** 不用构造器参数属性：Node 类型剥离模式不支持，会挡住 lib 层单测 */
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** 命中并移到最新端；最旧的始终在迭代首位，超限先淘汰 */
  get(key: string): T | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  put(key: string, value: T): void {
    // 先删再插 = 移到最新端
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** 失效：传路径前缀只清命中条目，不传全清 */
  invalidate(prefix?: string): void {
    if (prefix === undefined) {
      this.map.clear();
      return;
    }
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
