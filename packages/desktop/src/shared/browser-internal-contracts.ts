import type {
  BrowserContactInput,
  BrowserDataMutateResult,
  BrowserDataSnapshot,
  BrowserPasswordInput,
  BrowserSitePermissionInput,
} from "./browser-data-contracts.ts";

export const BROWSER_INTERNAL_SCHEME = "browser";
export const BROWSER_INTERNAL_HOST_CHANNEL = "browser-internal-host";
export const BROWSER_INTERNAL_PAGE_IDS = ["history", "downloads", "passwords", "contacts", "site-settings"] as const;

export type BrowserInternalPageId = (typeof BROWSER_INTERNAL_PAGE_IDS)[number];

export function browserInternalUrl(page: BrowserInternalPageId): string {
  return `${BROWSER_INTERNAL_SCHEME}://${page}`;
}

export function parseBrowserInternalPage(raw: string | undefined): BrowserInternalPageId | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== `${BROWSER_INTERNAL_SCHEME}:`) return null;
    if (url.pathname !== "" && url.pathname !== "/") return null;
    return BROWSER_INTERNAL_PAGE_IDS.find((page) => page === url.hostname) ?? null;
  } catch {
    return null;
  }
}

/** 只暴露给受信 browser:// WebUI 的最小主进程桥接。 */
export interface BrowserInternalApi {
  dataGet(includePasswords?: boolean): Promise<BrowserDataSnapshot>;
  historyDelete(url: string, timestamp: number): Promise<BrowserDataMutateResult>;
  historyClear(): Promise<BrowserDataMutateResult>;
  downloadsClear(): Promise<BrowserDataMutateResult>;
  openDownloads(): Promise<{ ok: true } | { ok: false; error: string }>;
  downloadReveal(path: string): Promise<void>;
  downloadOpen(path: string): Promise<{ ok: true } | { ok: false; error: string }>;
  contactSave(input: { contactId: string | null; contact: BrowserContactInput }): Promise<BrowserDataMutateResult>;
  contactDelete(id: string): Promise<BrowserDataMutateResult>;
  passwordSave(input: { passwordId: string | null; password: BrowserPasswordInput }): Promise<BrowserDataMutateResult>;
  passwordDelete(id: string): Promise<BrowserDataMutateResult>;
  sitePermissionSave(input: BrowserSitePermissionInput): Promise<BrowserDataMutateResult>;
  sitePermissionDelete(id: string): Promise<BrowserDataMutateResult>;
  openUrl(url: string): void;
}
