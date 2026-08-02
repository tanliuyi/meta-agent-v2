import type { ApplyDesktopExtensionSetResult, DesktopExtensionCapability } from "./desktop-extension-contracts.ts";

export const MARKETPLACE_PROTOCOL_VERSION = 1 as const;

export interface MarketplaceEndpointRecord {
  marketplaceId: string;
  baseUrl: string;
  apiRoot: string;
}

export interface MarketplaceEndpointSettingsSnapshot {
  revision: string;
  endpoint?: MarketplaceEndpointRecord;
}

export interface TestMarketplaceEndpointInput {
  baseUrl: string;
}

export type TestMarketplaceEndpointResult =
  | {
      status: "ready";
      endpoint: MarketplaceEndpointRecord;
    }
  | { status: "invalid"; code: string; message: string };

export interface SaveMarketplaceEndpointInput {
  requestId: string;
  expectedRevision: string;
  baseUrl: string;
}

export type SaveMarketplaceEndpointResult =
  | { status: "saved"; snapshot: MarketplaceEndpointSettingsSnapshot }
  | { status: "conflict"; current: MarketplaceEndpointSettingsSnapshot };

export interface ListMarketplacePluginsInput {
  query?: string;
  category?: string;
  cursor?: string;
  limit?: number;
}

export interface MarketplacePublisherSummary {
  id: string;
  displayName: string;
  verified: boolean;
}

export interface MarketplacePluginSummary {
  id: string;
  name: string;
  description: string;
  publisher: MarketplacePublisherSummary;
  categories: string[];
  iconAssetId?: string;
  latestVersion?: string;
  compatibleVersion?: string;
  containsNativeCode: boolean;
  capabilities?: string[];
  status: "available" | "deprecated";
  publishedAt: number;
  updatedAt: number;
}

export interface MarketplacePluginPage {
  marketplaceId: string;
  plugins: MarketplacePluginSummary[];
  nextCursor?: string;
  source: "network" | "cache";
  stale: boolean;
  fetchedAt: number;
}

export interface InstalledMarketplacePluginSummary {
  id: string;
  displayName: string;
  marketplaceId: string;
  version: string;
  artifactId: string;
  enabled: boolean;
  capabilities: DesktopExtensionCapability[];
  containsNativeCode: boolean;
  configurable: boolean;
  state: "installed" | "broken";
  installedAt: number;
}

export interface InstalledMarketplacePluginsSnapshot {
  revision: string;
  plugins: InstalledMarketplacePluginSummary[];
}

export interface ApplyMarketplaceMutationTarget {
  projectId: string;
  threadId: string;
  abortRunning?: boolean;
}

export interface InstallMarketplacePluginInput {
  requestId: string;
  expectedRevision: string;
  pluginId: string;
  version: string;
  confirmFullTrust: true;
  applyToCurrentSession?: ApplyMarketplaceMutationTarget;
}

export type InstallMarketplacePluginResult =
  | {
      status: "installed";
      snapshot: InstalledMarketplacePluginsSnapshot;
      recoveryPending?: boolean;
      application?: ApplyDesktopExtensionSetResult;
      /** 安装已提交但应用到当前会话失败；不影响插件安装结果。 */
      applicationError?: string;
    }
  | { status: "conflict"; current: InstalledMarketplacePluginsSnapshot }
  | { status: "already-installed"; snapshot: InstalledMarketplacePluginsSnapshot };

export interface UpdateMarketplacePluginInput {
  requestId: string;
  expectedRevision: string;
  pluginId: string;
  version: string;
  confirmFullTrust: true;
  applyToCurrentSession?: ApplyMarketplaceMutationTarget;
}

export type UpdateMarketplacePluginResult =
  | {
      status: "updated";
      snapshot: InstalledMarketplacePluginsSnapshot;
      reloadRequired: true;
      recoveryPending?: boolean;
      application?: ApplyDesktopExtensionSetResult;
      applicationError?: string;
    }
  | { status: "conflict"; current: InstalledMarketplacePluginsSnapshot }
  | { status: "not-installed"; snapshot: InstalledMarketplacePluginsSnapshot }
  | { status: "same-version"; snapshot: InstalledMarketplacePluginsSnapshot };

export interface UninstallMarketplacePluginInput {
  requestId: string;
  expectedRevision: string;
  pluginId: string;
  confirmRemoval: true;
  applyToCurrentSession?: ApplyMarketplaceMutationTarget;
}

export type UninstallMarketplacePluginResult =
  | {
      status: "uninstalled";
      snapshot: InstalledMarketplacePluginsSnapshot;
      reloadRequired: true;
      recoveryPending?: boolean;
      application?: ApplyDesktopExtensionSetResult;
      applicationError?: string;
    }
  | { status: "conflict"; current: InstalledMarketplacePluginsSnapshot }
  | { status: "not-installed"; snapshot: InstalledMarketplacePluginsSnapshot };
