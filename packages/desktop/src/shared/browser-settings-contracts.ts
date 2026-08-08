/**
 * Desktop 内置浏览器（IAB）设置契约。
 *
 * 持久化在 userDataDir/browser-settings.json，由
 * `src/main/browser/browser-settings-service.ts` 读写（sha256 revision、
 * proper-lockfile、临时文件 rename 原子写，与 auto-title 设置服务同构）。
 */

import { isSitePatternValid, normalizeSitePattern } from "./browser-site-policy.ts";

/** 敏感操作（表单提交）确认粒度。 */
export type BrowserConfirmMode = "all" | "unlisted-sites";

/** Agent 打开和操作未列入网站时的默认审批策略。 */
export type BrowserSiteApprovalMode = "always-allow" | "always-ask" | "always-deny";

/** Agent 读取内置浏览器历史的默认策略。 */
export type BrowserHistoryAccessMode = "always-allow" | "always-ask" | "always-deny";

/** 摄像头/麦克风等媒体权限的持久化决定。 */
export type BrowserMediaPermissionMode = "allow" | "deny";

export interface BrowserMediaPermission {
  site: string;
  camera: BrowserMediaPermissionMode;
  microphone: BrowserMediaPermissionMode;
}

/** 浏览器设置。未知字段在保存时保留，读取时缺省合并。 */
export interface BrowserSettings {
  /** 是否允许 Agent 使用内置浏览器。 */
  enabled: boolean;
  /** 允许 Agent 直接操作的站点（host 或 host:port）。 */
  allowSites: string[];
  /** 禁止站点；命中直接拒绝导航与 Agent 操作。 */
  blockSites: string[];
  /** 未列入网站的默认审批方式。 */
  siteApproval: BrowserSiteApprovalMode;
  /** Agent 读取内置浏览器历史的默认审批方式。 */
  historyAccess: BrowserHistoryAccessMode;
  /** 没有网站专属覆盖时的摄像头/麦克风默认权限。 */
  mediaDefault: BrowserMediaPermissionMode;
  /** 按 host 覆盖摄像头/麦克风权限。 */
  mediaPermissions: BrowserMediaPermission[];
  /** Agent 请求快照截图时是否包含截图。 */
  includeScreenshots: boolean;
  /** 下载目录；null = 系统下载目录。 */
  downloadDirectory: string | null;
  /** DOM 快照最大节点数。 */
  maxSnapshotNodes: number;
  /** CDP 命令超时毫秒。 */
  cdpTimeoutMs: number;
  /** 启动时恢复上次 tab 列表。 */
  restoreTabsOnLaunch: boolean;
  /** 敏感操作确认粒度：all = 每次表单提交都确认；unlisted-sites = 仅未允许站点确认。 */
  confirmSensitiveActions: BrowserConfirmMode;
}

export interface BrowserSettingsSnapshot {
  path: string;
  exists: boolean;
  revision: string;
  settings: BrowserSettings;
}

export interface SaveBrowserSettingsInput {
  expectedRevision: string;
  settings: BrowserSettings;
}

export type SaveBrowserSettingsResult =
  | { status: "saved"; snapshot: BrowserSettingsSnapshot }
  | { status: "conflict"; current: BrowserSettingsSnapshot };

export function defaultBrowserSettings(): BrowserSettings {
  return {
    enabled: true,
    allowSites: [],
    blockSites: [],
    siteApproval: "always-ask",
    historyAccess: "always-ask",
    mediaDefault: "deny",
    mediaPermissions: [],
    includeScreenshots: true,
    downloadDirectory: null,
    maxSnapshotNodes: 200,
    cdpTimeoutMs: 10_000,
    restoreTabsOnLaunch: true,
    confirmSensitiveActions: "all",
  };
}

/** 从任意 JSON 数据合并出合法设置：布尔/数字/字符串数组逐字段校验，未知字段保留。 */
export function normalizeBrowserSettings(data: unknown): BrowserSettings {
  const base = defaultBrowserSettings();
  if (typeof data !== "object" || data === null) return base;
  const src = data as Record<string, unknown>;
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : base.enabled,
    allowSites: stringArrayOr(src.allowSites, base.allowSites),
    blockSites: stringArrayOr(src.blockSites, base.blockSites),
    siteApproval: browserSiteApprovalOr(src.siteApproval, base.siteApproval),
    historyAccess: browserHistoryAccessOr(src.historyAccess, base.historyAccess),
    mediaDefault: src.mediaDefault === "allow" ? "allow" : base.mediaDefault,
    mediaPermissions: normalizeMediaPermissions(src.mediaPermissions),
    includeScreenshots: typeof src.includeScreenshots === "boolean" ? src.includeScreenshots : base.includeScreenshots,
    downloadDirectory:
      typeof src.downloadDirectory === "string" && src.downloadDirectory.length > 0 ? src.downloadDirectory : null,
    maxSnapshotNodes: boundedIntOr(src.maxSnapshotNodes, base.maxSnapshotNodes, 10, 10_000),
    cdpTimeoutMs: boundedIntOr(src.cdpTimeoutMs, base.cdpTimeoutMs, 1_000, 120_000),
    restoreTabsOnLaunch:
      typeof src.restoreTabsOnLaunch === "boolean" ? src.restoreTabsOnLaunch : base.restoreTabsOnLaunch,
    confirmSensitiveActions: src.confirmSensitiveActions === "unlisted-sites" ? "unlisted-sites" : "all",
  };
}

/** 校验设置，返回中文错误串列表；空数组表示合法。 */
export function validateBrowserSettings(settings: unknown): string[] {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return ["浏览器设置必须是对象"];
  }
  const source = settings as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof source.enabled !== "boolean") errors.push("浏览器启用开关无效");
  if (!isSiteList(source.allowSites)) errors.push("允许站点列表无效");
  else if (source.allowSites.some((site) => !isSitePatternValid(site))) errors.push("允许站点列表包含无效站点");
  if (!isSiteList(source.blockSites)) errors.push("禁止站点列表无效");
  else if (source.blockSites.some((site) => !isSitePatternValid(site))) errors.push("禁止站点列表包含无效站点");
  if (!isSiteApprovalMode(source.siteApproval)) errors.push("网站审批策略无效");
  if (!isHistoryAccessMode(source.historyAccess)) errors.push("历史记录访问策略无效");
  if (source.mediaDefault !== "allow" && source.mediaDefault !== "deny") errors.push("默认媒体权限无效");
  if (!Array.isArray(source.mediaPermissions)) {
    errors.push("媒体权限列表无效");
  } else {
    const sites: string[] = [];
    for (const item of source.mediaPermissions) {
      if (!isMediaPermission(item)) {
        errors.push("媒体权限列表包含无效记录");
        continue;
      }
      if (!isSitePatternValid(item.site)) errors.push("媒体权限列表包含无效站点");
      sites.push(item.site.toLowerCase());
    }
    if (new Set(sites).size !== sites.length) errors.push("媒体权限列表不能包含重复站点");
  }
  if (typeof source.includeScreenshots !== "boolean") errors.push("截图策略无效");
  if (typeof source.maxSnapshotNodes !== "number" || !Number.isInteger(source.maxSnapshotNodes)) {
    errors.push("快照最大节点数无效");
  } else if (source.maxSnapshotNodes < 10 || source.maxSnapshotNodes > 10_000) {
    errors.push("快照最大节点数必须在 10 到 10000 之间");
  }
  if (typeof source.cdpTimeoutMs !== "number" || !Number.isInteger(source.cdpTimeoutMs)) {
    errors.push("CDP 超时无效");
  } else if (source.cdpTimeoutMs < 1_000 || source.cdpTimeoutMs > 120_000) {
    errors.push("CDP 超时必须在 1000 到 120000 毫秒之间");
  }
  if (typeof source.downloadDirectory !== "string" && source.downloadDirectory !== null) {
    errors.push("下载目录无效");
  }
  if (typeof source.restoreTabsOnLaunch !== "boolean") errors.push("标签页恢复开关无效");
  if (source.confirmSensitiveActions !== "all" && source.confirmSensitiveActions !== "unlisted-sites") {
    errors.push("敏感操作确认策略无效");
  }
  return errors;
}

function isSiteList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSiteApprovalMode(value: unknown): value is BrowserSiteApprovalMode {
  return value === "always-allow" || value === "always-ask" || value === "always-deny";
}

function isHistoryAccessMode(value: unknown): value is BrowserHistoryAccessMode {
  return value === "always-allow" || value === "always-ask" || value === "always-deny";
}

function isMediaPermission(value: unknown): value is BrowserMediaPermission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.site === "string" &&
    (source.camera === "allow" || source.camera === "deny") &&
    (source.microphone === "allow" || source.microphone === "deny")
  );
}

function stringArrayOr(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : fallback;
}

function normalizeMediaPermissions(value: unknown): BrowserMediaPermission[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const permissions: BrowserMediaPermission[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const source = item as Record<string, unknown>;
    const site = typeof source.site === "string" ? normalizeSitePattern(source.site) : null;
    if (site === null || !isSitePatternValid(site) || seen.has(site)) continue;
    seen.add(site);
    permissions.push({
      site,
      camera: source.camera === "allow" ? "allow" : "deny",
      microphone: source.microphone === "allow" ? "allow" : "deny",
    });
  }
  return permissions;
}

function browserSiteApprovalOr(value: unknown, fallback: BrowserSiteApprovalMode): BrowserSiteApprovalMode {
  return value === "always-allow" || value === "always-deny" || value === "always-ask" ? value : fallback;
}

function browserHistoryAccessOr(value: unknown, fallback: BrowserHistoryAccessMode): BrowserHistoryAccessMode {
  return value === "always-allow" || value === "always-deny" || value === "always-ask" ? value : fallback;
}

function boundedIntOr(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
