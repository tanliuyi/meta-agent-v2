/**
 * pi-browser 工具侧的站点访问控制（spec §10.5）。
 *
 * 流程：open/navigate 前读取浏览器设置（RPC getSettings）→ blockSites 命中
 * 直接拒绝；allowSites 命中放行；未列入时经用户确认，确认结果在会话内
 * 按 host 记忆（同 host 后续操作不再询问）。
 *
 * 确认通道异常时 fail-closed：拒绝操作。
 */

import {
  checkSiteAccess,
  normalizeSitePattern,
  type SitePolicySettings,
} from "../../../../../shared/browser-site-policy.ts";

export type SiteAccessError =
  | { kind: "blocked"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unavailable"; message: string };

export type SiteAccessOutcome = { allowed: true } | { allowed: false; error: SiteAccessError };

/** 站点确认回调；返回 true 表示用户允许。 */
export type SiteConfirm = (url: string, host: string) => Promise<boolean>;

/** 会话内站点访问控制器（一个 extension 生命周期一个实例）。 */
export class SiteAccessController {
  private readonly confirmedHosts = new Set<string>();

  /** 检查并（需要时）确认对 url 的访问；失败原因经 error 返回。 */
  async check(settings: SitePolicySettings | undefined, url: string, confirm: SiteConfirm): Promise<SiteAccessOutcome> {
    if (settings === undefined) {
      return {
        allowed: false,
        error: { kind: "unavailable", message: "无法读取浏览器访问策略，请确认浏览器服务正常后重试" },
      };
    }
    const access = checkSiteAccess(settings, url);
    if (access === "blocked") {
      return {
        allowed: false,
        error: { kind: "blocked", message: `站点 ${displayHost(url)} 已列入禁止访问列表，无法操作` },
      };
    }
    if (access === "allowed") return { allowed: true };

    const host = displayHost(url);
    if (this.confirmedHosts.has(host)) return { allowed: true };
    let allowed: boolean;
    try {
      allowed = await confirm(url, host);
    } catch {
      // fail-closed：确认通道异常时拒绝。
      return {
        allowed: false,
        error: { kind: "denied", message: "无法完成访问确认，已拒绝操作" },
      };
    }
    if (!allowed) {
      return {
        allowed: false,
        error: { kind: "denied", message: "用户未允许访问该站点，已取消操作" },
      };
    }
    this.confirmedHosts.add(host);
    return { allowed: true };
  }

  /** 测试辅助：清空会话内已确认的 host。 */
  reset(): void {
    this.confirmedHosts.clear();
  }
}

/** 展示用 host（host:port）；解析失败时原样返回。 */
export function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 站点条目标签规范化（供错误文案展示已匹配到的条目）。 */
export function normalizeHostForDisplay(url: string): string {
  return normalizeSitePattern(url) ?? url;
}
