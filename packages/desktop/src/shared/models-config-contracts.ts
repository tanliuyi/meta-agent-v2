/**
 * Desktop IPC types for models.json editing.
 *
 * All types are owned by Desktop. The actual schema validation lives in
 * src/main/models/models-config-schema.ts and is tested against the
 * system Pi model loader.
 */

export type ModelsChatTemplateKwargScalar = string | number | boolean | null;
export type ModelsChatTemplateKwargVariable = { $var: "thinking.enabled" | "thinking.effort"; omitWhenOff?: boolean };
export type ModelsChatTemplateKwarg = ModelsChatTemplateKwargScalar | ModelsChatTemplateKwargVariable;

export interface ModelsCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelsCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: ModelsCostTier[];
}

export interface ModelsThinkingLevelMap {
  off?: string | null;
  minimal?: string | null;
  low?: string | null;
  medium?: string | null;
  high?: string | null;
  xhigh?: string | null;
  max?: string | null;
}

export interface ModelsPercentileCutoffs {
  p50?: number;
  p75?: number;
  p90?: number;
  p99?: number;
}

export interface ModelsOpenRouterRouting {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "deny" | "allow";
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?: string | { by?: string; partition?: string | null };
  max_price?: {
    prompt?: number | string;
    completion?: number | string;
    image?: number | string;
    audio?: number | string;
    request?: number | string;
  };
  preferred_min_throughput?: number | ModelsPercentileCutoffs;
  preferred_max_latency?: number | ModelsPercentileCutoffs;
}

export interface ModelsVercelGatewayRouting {
  only?: string[];
  order?: string[];
}

export interface ModelsCompatConfig {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?:
    | "openai"
    | "openrouter"
    | "together"
    | "deepseek"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template"
    | "string-thinking"
    | "ant-ling";
  cacheControlFormat?: "anthropic";
  openRouterRouting?: ModelsOpenRouterRouting;
  vercelGatewayRouting?: ModelsVercelGatewayRouting;
  supportsOpenAIGrammarTools?: boolean;
  supportsStrictMode?: boolean;
  sendSessionAffinityHeaders?: boolean;
  deferredToolsMode?: "kimi";
  sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
  supportsLongCacheRetention?: boolean;
  supportsToolSearch?: boolean;
  supportsEagerToolInputStreaming?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsTemperature?: boolean;
  forceAdaptiveThinking?: boolean;
  allowEmptySignature?: boolean;
  supportsStrictTools?: boolean;
  supportsToolReferences?: boolean;
}

export interface ModelsModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ModelsThinkingLevelMap;
  input?: ("text" | "image")[];
  cost?: ModelsCost;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: ModelsCompatConfig;
}

export interface ModelsProviderConfigDraft {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  oauth?: "radius";
  authHeader?: boolean;
}

export type ModelsModelConfigDraft = Omit<ModelsModelDefinition, "headers" | "compat">;
export type ModelsModelOverrideConfigDraft = Partial<
  Pick<ModelsModelDefinition, "name" | "reasoning" | "thinkingLevelMap" | "input" | "contextWindow" | "maxTokens">
> & {
  cost?: Partial<Omit<ModelsCost, "tiers">> & { tiers?: ModelsCostTier[] };
};

export type ModelsConfigPath = readonly (string | number)[];

export interface ModelsMapEntryDraft<T> {
  key: string;
  value: T;
  origin?: { parentPath: ModelsConfigPath; key: string };
}

export interface ModelsCompatDraft {
  config: ModelsCompatConfig;
  chatTemplateKwargs?: ModelsMapEntryDraft<ModelsChatTemplateKwarg>[];
}

export interface ModelsProviderDraft {
  key: string;
  origin?: { providerKey: string };
  config: ModelsProviderConfigDraft;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
  models: ModelsModelDraft[];
  modelOverrides: ModelsModelOverrideDraft[];
}

export interface ModelsModelDraft {
  origin?: { providerKey: string; modelIndex: number };
  config: ModelsModelConfigDraft;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
}

export interface ModelsModelOverrideDraft {
  modelId: string;
  origin?: { providerKey: string; modelId: string };
  config: ModelsModelOverrideConfigDraft;
  headers: ModelsMapEntryDraft<string>[];
  compat?: ModelsCompatDraft;
}

export interface ModelsConfigDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: ModelsConfigPath;
  message: string;
}

export interface ModelsBuiltInModelMetadata extends ModelsModelDefinition {
  name: string;
  api: string;
}

export interface ModelsConfigMetadata {
  knownApis: string[];
  builtInProviders: Array<{
    id: string;
    displayName: string;
    defaultConfig?: {
      name?: string;
      baseUrl?: string;
      api?: string;
    };
    models: ModelsBuiltInModelMetadata[];
  }>;
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
  activeSessionsRefreshed: boolean;
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
