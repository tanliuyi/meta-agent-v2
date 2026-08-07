/**
 * Desktop 内置浏览器（IAB）设置契约。
 *
 * 持久化在 userDataDir/browser-settings.json，由
 * `src/main/browser/browser-settings-service.ts` 读写（sha256 revision、
 * proper-lockfile、临时文件 rename 原子写，与 auto-title 设置服务同构）。
 */

/** 敏感操作（表单提交）确认粒度。 */
export type BrowserConfirmMode = "all" | "unlisted-sites";

/** 浏览器设置。未知字段在保存时保留，读取时缺省合并。 */
export interface BrowserSettings {
  /** 允许 Agent 直接操作的站点（host 或 host:port）；默认空 = 每次询问。 */
  allowSites: string[];
  /** 禁止站点；命中直接拒绝导航与 Agent 操作。 */
  blockSites: string[];
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
    allowSites: [],
    blockSites: [],
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
    allowSites: stringArrayOr(src.allowSites, base.allowSites),
    blockSites: stringArrayOr(src.blockSites, base.blockSites),
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
export function validateBrowserSettings(settings: BrowserSettings): string[] {
  const errors: string[] = [];
  if (settings.maxSnapshotNodes < 10 || settings.maxSnapshotNodes > 10_000) {
    errors.push("快照最大节点数必须在 10 到 10000 之间");
  }
  if (settings.cdpTimeoutMs < 1_000 || settings.cdpTimeoutMs > 120_000) {
    errors.push("CDP 超时必须在 1000 到 120000 毫秒之间");
  }
  if (settings.allowSites.some((s) => s.trim() === "")) {
    errors.push("允许站点列表不能包含空字符串");
  }
  if (settings.blockSites.some((s) => s.trim() === "")) {
    errors.push("禁止站点列表不能包含空字符串");
  }
  return errors;
}

function stringArrayOr(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : fallback;
}

function boundedIntOr(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
