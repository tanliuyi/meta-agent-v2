/**
 * Desktop auth config IPC contracts.
 *
 * Types are defined locally because @earendil-works/pi-coding-agent does not
 * export them as a subpath. They mirror the same JSON structure used by
 * AuthStorage / FileAuthStorageBackend in the coding-agent package.
 */

// Mirror of @earendil-works/pi-coding-agent's ApiKeyCredential (from auth-storage.ts)
export interface AuthApiKeyCredential {
  type: "api_key";
  key: string;
  env?: Record<string, string>;
}

// Mirror of @earendil-works/pi-coding-agent's OAuthCredential
export interface AuthOAuthCredential {
  type: "oauth";
  accessToken: string;
  refreshToken?: string;
  expires?: number;
}

export type AuthCredential = AuthApiKeyCredential | AuthOAuthCredential;

export type AuthProviderDraft = {
  /** Provider key (object key in auth.json). Required; must be non-empty. */
  key: string;
  /** Origin provider key if this draft was loaded from disk (for rename detection). */
  origin?: string;
  /** API key credential draft (only one of apiKey/oauth present at a time). */
  apiKey?: {
    key: string;
    env?: AuthEnvEntry[];
  };
  /** OAuth credential (read-only from Desktop perspective). */
  oauth?: {
    /** Display name of the OAuth provider (from Pi OAuth registry). */
    providerName: string;
    /** ISO string of token expiry. */
    expires: string;
    /** Whether the token is currently expired. */
    expired: boolean;
  };
};

export type AuthEnvEntry = {
  key: string;
  value: string;
  origin?: string;
};

export interface AuthConfigDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: readonly (string | number)[];
  message: string;
}

export interface AuthProviderInfo {
  /** Provider key used in auth.json. */
  id: string;
  /** Display name (from built-in catalog or custom). */
  displayName: string;
  /** Environment variable names that can supply this provider's API key. */
  envKeys: string[];
}

export interface AuthConfigSnapshot {
  path: string;
  exists: boolean;
  revision: string;
  sourceState: "missing" | "valid" | "invalid";
  providers: AuthProviderDraft[];
  diagnostics: AuthConfigDiagnostic[];
  /** List of known providers with their env var mappings for UI suggestions. */
  knownProviders: AuthProviderInfo[];
}

export interface SaveAuthConfigInput {
  expectedRevision: string;
  providers: AuthProviderDraft[];
}

export type SaveAuthConfigResult =
  | { status: "saved"; snapshot: AuthConfigSnapshot }
  | { status: "invalid"; diagnostics: AuthConfigDiagnostic[] }
  | { status: "conflict"; current: AuthConfigSnapshot };
