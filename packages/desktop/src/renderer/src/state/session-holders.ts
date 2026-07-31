/**
 * 会话 attachment 的多持有者注册表。
 *
 * 路由活动会话隐式持有一席（activeKey）；侧边栏等次级视图通过 retain/release
 * 显式持有，保证主工作区导航切换不会 detach 仍被其他视图使用的会话。
 */
export class SessionHolderRegistry {
  private readonly counts = new Map<string, number>();

  /** 增加一席持有。 */
  retain(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** 释放一席；返回释放后的剩余持有数（无持有者时为 0）。 */
  release(key: string): number {
    const count = this.counts.get(key) ?? 0;
    if (count <= 1) {
      this.counts.delete(key);
      return 0;
    }
    this.counts.set(key, count - 1);
    return count - 1;
  }

  /** 该 key 当前是否被次级视图持有。 */
  isHeld(key: string): boolean {
    return (this.counts.get(key) ?? 0) > 0;
  }

  /** 移除 key 的全部持有（会话被 retire 时调用）。 */
  remove(key: string): void {
    this.counts.delete(key);
  }
}
