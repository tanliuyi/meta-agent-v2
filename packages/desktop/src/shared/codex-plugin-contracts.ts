export interface CodexPluginDisplayMetadata {
  displayName: string;
  description: string;
  developerName: string;
  version: string;
  sourceVersion: string;
  updateAvailable: boolean;
  category?: string;
  capabilities: string[];
  keywords: string[];
  websiteUrl?: string;
  repositoryUrl?: string;
  license?: string;
  marketplaceCategory?: string;
  installationPolicy?: "NOT_AVAILABLE" | "AVAILABLE" | "INSTALLED_BY_DEFAULT";
  authenticationPolicy?: "ON_INSTALL" | "ON_USE";
  products: string[];
}

export interface CodexPluginSummary extends CodexPluginDisplayMetadata {
  id: string;
  marketplace: "personal" | "custom";
  source: "local";
  installed: boolean;
  enabled: boolean;
}

export interface CodexPluginDiagnostic {
  code: string;
  pluginId?: string;
  message: string;
}

export interface CodexPluginsSnapshot {
  revision: string;
  plugins: CodexPluginSummary[];
  diagnostics: CodexPluginDiagnostic[];
}

export interface CodexPluginMutationInput {
  requestId: string;
  expectedRevision: string;
  pluginId: string;
  confirmFullTrust?: true;
  confirmRemoval?: true;
}

export type CodexPluginMutationResult =
  | {
      status: "installed" | "updated" | "uninstalled" | "same-version" | "not-installed";
      snapshot: CodexPluginsSnapshot;
    }
  | { status: "already-installed"; snapshot: CodexPluginsSnapshot }
  | { status: "conflict"; current: CodexPluginsSnapshot };

export interface SetCodexPluginEnabledInput {
  requestId: string;
  expectedRevision: string;
  pluginId: string;
  enabled: boolean;
}

export type SetCodexPluginEnabledResult =
  | { status: "saved" | "not-installed"; snapshot: CodexPluginsSnapshot }
  | { status: "conflict"; current: CodexPluginsSnapshot };
