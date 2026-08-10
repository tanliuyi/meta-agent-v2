/**
 * 内置浏览器用户数据（浏览历史 / 下载历史 / 联系信息 / 保存的密码 / 网站设置）共享契约。
 *
 * 这些数据用于桌面端用户 UI（面板内部页），Agent 工具不可见。
 */

import type { BrowserSessionIdentity } from "./browser-contracts.ts";

/** 全局持久化浏览历史上限（超出丢弃最旧条目）。 */
export const MAX_PERSISTED_HISTORY = 5000;
/** 全局持久化下载历史上限。 */
export const MAX_PERSISTED_DOWNLOADS = 500;

export interface PersistedHistoryEntry {
  url: string;
  title: string;
  timestamp: number;
}

export type BrowserDownloadState = "completed" | "interrupted" | "cancelled";

export interface PersistedDownload {
  id: string;
  url: string;
  filename: string;
  /** 保存路径（取消时可能为空）。 */
  path: string | null;
  totalBytes: number;
  receivedBytes: number;
  state: BrowserDownloadState;
  startedAt: number;
  /** 结束时间（进行中为 null）。 */
  endedAt: number | null;
}

export interface ContactProfile {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  company: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  createdAt: number;
  updatedAt: number;
}

export type BrowserContactInput = Omit<ContactProfile, "id" | "createdAt" | "updatedAt">;

export interface SavedPassword {
  id: string;
  /** 规范化后的站点源（协议 + host[:port]，如 https://example.com）。 */
  origin: string;
  username: string;
  password: string;
  createdAt: number;
  updatedAt: number;
}

export type BrowserPasswordInput = Omit<SavedPassword, "id" | "createdAt" | "updatedAt">;

export type BrowserPermissionKind =
  | "camera"
  | "microphone"
  | "notifications"
  | "geolocation"
  | "clipboard"
  | "fullscreen";

export const BROWSER_PERMISSION_KINDS: readonly BrowserPermissionKind[] = [
  "camera",
  "microphone",
  "notifications",
  "geolocation",
  "clipboard",
  "fullscreen",
];

export type BrowserPermissionValue = "allow" | "deny";

export interface BrowserSitePermission {
  id: string;
  /** 规范化站点模式（不含协议；host 含端口）。 */
  site: string;
  kind: BrowserPermissionKind;
  value: BrowserPermissionValue;
  updatedAt: number;
}

export type BrowserSitePermissionInput = Omit<BrowserSitePermission, "id" | "updatedAt">;

export interface BrowserDataSnapshot {
  history: PersistedHistoryEntry[];
  downloads: PersistedDownload[];
  contacts: ContactProfile[];
  passwords: SavedPassword[];
  sitePermissions: BrowserSitePermission[];
}

/** 主进程检测到登录表单提交后向 renderer 发出的保存请求。 */
export interface BrowserPasswordOffer {
  id: string;
  /** 表单所在页面 URL。 */
  url: string;
  origin: string;
  username: string;
  /** 会话身份（回调时验证 offer 归属）。 */
  identity: BrowserSessionIdentity;
}

export type BrowserPasswordOfferResolveResult = { ok: true } | { ok: false; error: string };

export type BrowserDataMutateResult = { ok: true; snapshot: BrowserDataSnapshot } | { ok: false; error: string };

/** 从任意 JSON 值恢复历史条目；非法返回 null（丢弃）。 */
export function normalizePersistedHistoryEntry(value: unknown): PersistedHistoryEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.url !== "string" || entry.url.length === 0) return null;
  if (typeof entry.title !== "string") return null;
  if (typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp)) return null;
  return { url: entry.url, title: entry.title, timestamp: entry.timestamp };
}

/** 从任意 JSON 值恢复下载记录；非法返回 null（丢弃）。 */
export function normalizePersistedDownload(value: unknown): PersistedDownload | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;
  if (typeof entry.url !== "string" || entry.url.length === 0) return null;
  if (typeof entry.filename !== "string" || entry.filename.length === 0) return null;
  const state =
    entry.state === "completed" || entry.state === "cancelled" || entry.state === "interrupted"
      ? entry.state
      : "interrupted";
  const startedAt = typeof entry.startedAt === "number" ? entry.startedAt : Date.now();
  return {
    id: entry.id,
    url: entry.url,
    filename: entry.filename,
    path: typeof entry.path === "string" ? entry.path : null,
    totalBytes: typeof entry.totalBytes === "number" ? entry.totalBytes : 0,
    receivedBytes: typeof entry.receivedBytes === "number" ? entry.receivedBytes : 0,
    state,
    startedAt,
    endedAt: typeof entry.endedAt === "number" ? entry.endedAt : null,
  };
}

/** 从任意 JSON 值恢复联系信息；非法返回 null（丢弃）。 */
export function normalizeContactProfile(value: unknown): ContactProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;
  if (typeof entry.fullName !== "string") return null;
  return {
    id: entry.id,
    fullName: entry.fullName,
    email: typeof entry.email === "string" ? entry.email : "",
    phone: typeof entry.phone === "string" ? entry.phone : "",
    company: typeof entry.company === "string" ? entry.company : "",
    addressLine1: typeof entry.addressLine1 === "string" ? entry.addressLine1 : "",
    addressLine2: typeof entry.addressLine2 === "string" ? entry.addressLine2 : "",
    city: typeof entry.city === "string" ? entry.city : "",
    region: typeof entry.region === "string" ? entry.region : "",
    postalCode: typeof entry.postalCode === "string" ? entry.postalCode : "",
    country: typeof entry.country === "string" ? entry.country : "",
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
  };
}

/** 从任意 JSON 值恢复保存的密码；非法返回 null（丢弃）。 */
export function normalizeSavedPassword(value: unknown): SavedPassword | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;
  if (typeof entry.origin !== "string" || entry.origin.length === 0) return null;
  if (typeof entry.username !== "string") return null;
  if (typeof entry.password !== "string") return null;
  return {
    id: entry.id,
    origin: entry.origin,
    username: entry.username,
    password: entry.password,
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
  };
}

/** 从任意 JSON 值恢复网站设置条目；非法返回 null（丢弃）。 */
export function normalizeBrowserSitePermission(value: unknown): BrowserSitePermission | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;
  if (typeof entry.site !== "string" || entry.site.length === 0) return null;
  if (!BROWSER_PERMISSION_KINDS.includes(entry.kind as BrowserPermissionKind)) return null;
  if (entry.value !== "allow" && entry.value !== "deny") return null;
  return {
    id: entry.id,
    site: entry.site,
    kind: entry.kind as BrowserPermissionKind,
    value: entry.value,
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
  };
}

/** 从任意 JSON 值恢复浏览器数据快照；非法字段丢弃，永不抛错。 */
export function normalizeBrowserDataSnapshot(value: unknown): BrowserDataSnapshot {
  const root = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    history: Array.isArray(root.history)
      ? root.history
          .map(normalizePersistedHistoryEntry)
          .filter((entry): entry is PersistedHistoryEntry => entry !== null)
      : [],
    downloads: Array.isArray(root.downloads)
      ? root.downloads.map(normalizePersistedDownload).filter((entry): entry is PersistedDownload => entry !== null)
      : [],
    contacts: Array.isArray(root.contacts)
      ? root.contacts.map(normalizeContactProfile).filter((entry): entry is ContactProfile => entry !== null)
      : [],
    passwords: Array.isArray(root.passwords)
      ? root.passwords.map(normalizeSavedPassword).filter((entry): entry is SavedPassword => entry !== null)
      : [],
    sitePermissions: Array.isArray(root.sitePermissions)
      ? root.sitePermissions
          .map(normalizeBrowserSitePermission)
          .filter((entry): entry is BrowserSitePermission => entry !== null)
      : [],
  };
}
