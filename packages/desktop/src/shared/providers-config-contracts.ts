/**
 * Unified provider config IPC contracts.
 *
 * Merges data from models.json and auth.json into a single view of all
 * providers (built-in, desktop-registered, and custom), plus their
 * credential status.
 */

import type { AuthProviderDraft, AuthProviderInfo } from "./auth-config-contracts.ts";
import type {
  ModelsBuiltInModelMetadata,
  ModelsCompatDraft,
  ModelsConfigPath,
  ModelsModelDraft,
  ModelsModelOverrideDraft,
  ModelsProviderDraft,
} from "./models-config-contracts.ts";

export type ProviderBuiltInModelMetadata = ModelsBuiltInModelMetadata;

export interface ProvidersConfigMetadata {
  knownApis: string[];
  builtInProviders: Array<{
    id: string;
    displayName: string;
    defaultConfig?: ProviderConnectionDefaults;
    models: ProviderBuiltInModelMetadata[];
  }>;
}

/** A single provider entry in the unified provider list. */
export interface ProviderEntry {
  /** Provider key (ID). */
  key: string;
  /** Display name (from built-in catalog, desktop registry, or custom config). */
  displayName: string;
  /** Where this provider comes from. */
  source: "ai-builtin" | "desktop-builtin" | "custom";

  // ---------------------------------------------------------------------------
  // Computed display info
  // ---------------------------------------------------------------------------
  /** Number of built-in models registered for this provider. */
  builtInModelCount: number;
  /** Summarised credential availability for the list view. */
  credentialStatus: "configured" | "missing" | "env-available";
  /** Read-only connection defaults supplied by a built-in provider registration. */
  defaultConfig?: ProviderConnectionDefaults;

  // ---------------------------------------------------------------------------
  // Editable config from models.json (undefined when the user has not
  // configured this provider yet).
  // ---------------------------------------------------------------------------
  providerConfig?: ProviderConfigDraft;
  models: ModelsModelDraft[];
  modelOverrides: ModelsModelOverrideDraft[];

  // ---------------------------------------------------------------------------
  // Editable credential from auth.json (undefined when no stored credential).
  // ---------------------------------------------------------------------------
  credential?: ProviderCredentialDraft;
}

export interface ProviderConnectionDefaults {
  name?: string;
  baseUrl?: string;
  api?: string;
  authHeader?: boolean;
}

/** Subset of ModelsProviderDraft.config exposed in the unified editor. */
export interface ProviderConfigDraft {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  oauth?: string;
  authHeader?: boolean;
  headers: Array<{ key: string; value: string }>;
  compat?: ModelsCompatDraft;
}

/** Credential draft shown in the unified editor. */
export interface ProviderCredentialDraft {
  type: "api_key" | "oauth";
  /** API key value (masked in display). */
  apiKey?: string;
  /** Environment variable overrides. */
  env?: Array<{ key: string; value: string }>;
  /** OAuth display info (read-only). */
  oauthInfo?: {
    providerName: string;
    expires: string;
    expired: boolean;
  };
}

export type ProviderDiagnosticSeverity = "error" | "warning";

export interface ProviderDiagnostic {
  severity: ProviderDiagnosticSeverity;
  code: string;
  path: readonly (string | number)[];
  message: string;
  /** "models" or "auth" — which source file the diagnostic belongs to. */
  source: "models" | "auth";
}

/** Unified snapshot returned by the main process. */
export interface ProvidersSnapshot {
  /** Merged provider list (built-in + desktop + custom). */
  providers: ProviderEntry[];
  /** Metadata for form suggestions. */
  metadata: ProvidersConfigMetadata;
  /** Known providers for credential suggestions. */
  knownProviders: AuthProviderInfo[];
  // ---------------------------------------------------------------------------
  // Raw data for editing (the controller mutates these, then sends them back
  // on save).
  // ---------------------------------------------------------------------------
  modelsProviders: ModelsProviderDraft[];
  authProviders: AuthProviderDraft[];
  // ---------------------------------------------------------------------------
  // Revisions for dirty tracking and conflict detection.
  // ---------------------------------------------------------------------------
  modelsRevision: string;
  authRevision: string;
  // ---------------------------------------------------------------------------
  // Diagnostics from both files.
  // ---------------------------------------------------------------------------
  diagnostics: ProviderDiagnostic[];
  /** Unknown JSONC paths preserved for roundtrip fidelity. */
  preservedUnknownPaths: ModelsConfigPath[];
  /** Source-state flags for the error / fallback UI. */
  modelsSourceState: "missing" | "valid" | "invalid";
  authSourceState: "missing" | "valid" | "invalid";
}

export interface SaveProvidersInput {
  expectedModelsRevision: string;
  expectedAuthRevision: string;
  modelsProviders: ModelsProviderDraft[];
  authProviders: AuthProviderDraft[];
  /** Token forwarded when the user confirms a JSONC-comment-move warning. */
  confirmationToken?: string;
}

export type SaveProvidersResult =
  | { status: "saved"; snapshot: ProvidersSnapshot }
  | { status: "invalid"; diagnostics: ProviderDiagnostic[] }
  | { status: "conflict"; current: ProvidersSnapshot }
  | {
      status: "confirmation-required";
      reason: "jsonc-comment-move";
      message: string;
      confirmationToken: string;
      expectedModelsRevision: string;
      expectedAuthRevision: string;
      modelsProviders: ModelsProviderDraft[];
      authProviders: AuthProviderDraft[];
    };
