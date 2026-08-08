/**
 * 内置浏览器（IAB）站点访问策略（spec §10.5）。
 *
 * allowSites/blockSites 以 host（或 host:port）为粒度，支持子域匹配：
 * `example.com` 命中 `example.com`、`www.example.com`、`a.b.example.com`；
 * `example.com:8080` 只命中带该端口的 host。blockSites 优先于 allowSites。
 *
 * 纯函数，main / sidecar extension 两侧复用；UI 输入（设置页）也经同一
 * 规范化逻辑处理。
 */

export type SiteAccess = "allowed" | "blocked" | "unlisted";
export type SiteApprovalMode = "always-allow" | "always-ask" | "always-deny";

export interface SitePolicySettings {
  allowSites: string[];
  blockSites: string[];
  siteApproval?: SiteApprovalMode;
  enabled?: boolean;
}

/** pattern 是否为合法站点条目（非空、无协议、无路径/查询/哈希、host 可解析）。 */
export function isSitePatternValid(pattern: string): boolean {
  const normalized = normalizeSitePattern(pattern);
  if (normalized === null) return false;
  if (normalized.includes("/") || normalized.includes(" ")) return false;
  try {
    const parsed = new URL(`http://${normalized}`);
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 判断 pattern 是否匹配 url（子域/端口语义见文件头注释）。 */
export function siteMatches(pattern: string, url: string): boolean {
  const normalizedPattern = normalizeSitePattern(pattern);
  if (normalizedPattern === null) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const host = parsed.host.toLowerCase();
  if (normalizedPattern === host) return true;
  // 带端口 pattern 只精确匹配 host（含端口），不做子域展开。
  if (normalizedPattern.includes(":")) return false;
  if (hostname === normalizedPattern) return true;
  return hostname.endsWith(`.${normalizedPattern}`);
}

/** 检查 url 的访问级别：blocked 优先，其次 allowed，未列入为 unlisted。 */
export function checkSiteAccess(settings: SitePolicySettings, url: string): SiteAccess {
  for (const pattern of settings.blockSites) {
    if (siteMatches(pattern, url)) return "blocked";
  }
  for (const pattern of settings.allowSites) {
    if (siteMatches(pattern, url)) return "allowed";
  }
  return "unlisted";
}

/** 应用未列入站点的默认策略；旧快照缺少该字段时保持原来的询问行为。 */
export function defaultSiteApproval(settings: SitePolicySettings): SiteApprovalMode {
  return settings.siteApproval ?? "always-ask";
}

/** 规范化站点条目：去协议/空白/尾部斜杠，小写；非法输入返回 null。 */
export function normalizeSitePattern(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  if (value.length === 0) return null;
  // 容忍用户粘贴完整 URL：只取 host（含端口）。
  if (value.includes("://")) {
    try {
      value = new URL(value).host.toLowerCase();
    } catch {
      return null;
    }
  }
  value = value.replace(/\/+$/, "");
  if (value.length === 0) return null;
  return value;
}

/** 把多行/逗号分隔的输入拆成规范化站点列表（去空、去重、过滤非法）。 */
export function parseSiteListInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const normalized = normalizeSitePattern(part);
    if (normalized === null || !isSitePatternValid(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
