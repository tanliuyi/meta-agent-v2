import type { BrowserSessionIdentity } from "../../shared/browser-contracts.ts";

/** BrowserManager 暴露给 session worker 的最小 capability 接口。 */
export interface BrowserCapabilityTarget {
  registerSession(identity: BrowserSessionIdentity): string | undefined;
  revokeSessionCapability(token: string): void;
}

/** Session worker 到 BrowserManager 的一次性可绑定 capability 端口。 */
export class BrowserCapabilityPort {
  private target: BrowserCapabilityTarget | undefined;
  private bound = false;
  private retired = false;

  /** 绑定唯一目标；端口生命周期内不允许重复绑定。 */
  bind(target: BrowserCapabilityTarget): void {
    if (this.bound) throw new Error("Browser capability port is already bound");
    this.bound = true;
    this.target = target;
  }

  /** 撤销当前目标，使退出中的 worker 后续调用安全降级。 */
  unbind(target: BrowserCapabilityTarget): void {
    if (this.target !== target) throw new Error("Browser capability port target does not match");
    this.target = undefined;
    this.retired = true;
  }

  /** 为指定 session 创建浏览器 capability token。 */
  register(identity: BrowserSessionIdentity): string | undefined {
    if (this.retired) return undefined;
    if (!this.target) throw new Error("Browser capability port is not bound");
    return this.target.registerSession(identity);
  }

  /** 撤销 worker 持有的浏览器 capability token。 */
  revoke(_identity: BrowserSessionIdentity, token: string): void {
    if (this.retired) return;
    if (!this.target) throw new Error("Browser capability port is not bound");
    this.target.revokeSessionCapability(token);
  }
}
