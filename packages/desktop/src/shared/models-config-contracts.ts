import type {
  ModelsChatTemplateKwarg,
  ModelsCompatWithoutFreeMaps,
  ModelsConfigMetadata,
  ModelsModelDefinition,
  ModelsModelOverride,
  ModelsProviderConfig,
} from "@earendil-works/pi-coding-agent/models-config";

export type ModelsConfigPath = readonly (string | number)[];

export interface ModelsMapEntryDraft<T> {
  key: string;
  value: T;
  origin?: { parentPath: ModelsConfigPath; key: string };
}

export interface ModelsCompatDraft {
  config: ModelsCompatWithoutFreeMaps;
  chatTemplateKwargs?: ModelsMapEntryDraft<ModelsChatTemplateKwarg>[];
}

export interface ModelsProviderDraft {
  key: string;
  origin?: { providerKey: string };
  config: Omit<ModelsProviderConfig, "models" | "modelOverrides" | "headers" | "compat">;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
  models: ModelsModelDraft[];
  modelOverrides: ModelsModelOverrideDraft[];
}

export interface ModelsModelDraft {
  origin?: { providerKey: string; modelIndex: number };
  config: Omit<ModelsModelDefinition, "headers" | "compat">;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
}

export interface ModelsModelOverrideDraft {
  modelId: string;
  origin?: { providerKey: string; modelId: string };
  config: Omit<ModelsModelOverride, "headers" | "compat">;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
}

export interface ModelsConfigDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: ModelsConfigPath;
  message: string;
}

export interface ModelsConfigSnapshot {
  path: string;
  exists: boolean;
  revision: string;
  sourceState: "missing" | "valid" | "invalid";
  providers: ModelsProviderDraft[];
  metadata: ModelsConfigMetadata;
  diagnostics: ModelsConfigDiagnostic[];
  preservedUnknownPaths: ModelsConfigPath[];
  activeSessionsRefreshed: false;
}

export interface SaveModelsConfigInput {
  expectedRevision: string;
  providers: ModelsProviderDraft[];
  confirmationToken?: string;
}

export type SaveModelsConfigResult =
  | { status: "saved"; snapshot: ModelsConfigSnapshot }
  | { status: "invalid"; diagnostics: ModelsConfigDiagnostic[] }
  | { status: "conflict"; current: ModelsConfigSnapshot }
  | {
      status: "confirmation-required";
      reason: "jsonc-comment-move";
      message: string;
      confirmationToken: string;
    };
