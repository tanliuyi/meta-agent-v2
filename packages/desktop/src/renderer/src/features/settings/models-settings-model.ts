import type {
  ModelsConfigDiagnostic,
  ModelsModelDraft,
  ModelsModelOverrideDraft,
  ModelsProviderDraft,
} from "../../../../shared/models-config-contracts.ts";

export function cloneModelsProviders(providers: ModelsProviderDraft[]): ModelsProviderDraft[] {
  return structuredClone(providers);
}

export function modelsDraftsEqual(left: ModelsProviderDraft[], right: ModelsProviderDraft[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createProviderDraft(key: string): ModelsProviderDraft {
  return {
    key,
    config: {},
    headers: [],
    models: [],
    modelOverrides: [],
  };
}

export function createModelDraft(id: string): ModelsModelDraft {
  return {
    config: { id },
    headers: [],
  };
}

export function createModelOverrideDraft(modelId: string): ModelsModelOverrideDraft {
  return {
    modelId,
    config: {},
    headers: [],
  };
}

export function validateModelsDraft(providers: ModelsProviderDraft[]): ModelsConfigDiagnostic[] {
  const diagnostics: ModelsConfigDiagnostic[] = [];
  const providerKeys = new Set<string>();
  for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
    const provider = providers[providerIndex];
    const providerPath = ["providers", provider.key] as const;
    if (!provider.key.trim()) diagnostics.push(diagnostic(providerPath, "Provider ID 不能为空。"));
    else if (providerKeys.has(provider.key)) diagnostics.push(diagnostic(providerPath, "Provider ID 必须唯一。"));
    providerKeys.add(provider.key);
    validateMap(provider.headers, [...providerPath, "headers"], diagnostics);
    validateCompatMap(
      provider.compat?.chatTemplateKwargs,
      [...providerPath, "compat", "chatTemplateKwargs"],
      diagnostics,
    );

    const modelIds = new Set<string>();
    for (let modelIndex = 0; modelIndex < provider.models.length; modelIndex += 1) {
      const model = provider.models[modelIndex];
      const modelPath = [...providerPath, "models", modelIndex] as const;
      if (!model.config.id.trim()) diagnostics.push(diagnostic([...modelPath, "id"], "Model ID 不能为空。"));
      else if (modelIds.has(model.config.id)) diagnostics.push(diagnostic([...modelPath, "id"], "Model ID 必须唯一。"));
      modelIds.add(model.config.id);
      validatePositive(model.config.contextWindow, [...modelPath, "contextWindow"], diagnostics);
      validatePositive(model.config.maxTokens, [...modelPath, "maxTokens"], diagnostics);
      validateCost(model.config.cost, [...modelPath, "cost"], diagnostics);
      validateMap(model.headers, [...modelPath, "headers"], diagnostics);
      validateCompatMap(model.compat?.chatTemplateKwargs, [...modelPath, "compat", "chatTemplateKwargs"], diagnostics);
    }

    const overrideIds = new Set<string>();
    for (const override of provider.modelOverrides) {
      const overridePath = [...providerPath, "modelOverrides", override.modelId] as const;
      if (!override.modelId.trim()) diagnostics.push(diagnostic(overridePath, "覆盖的 Model ID 不能为空。"));
      else if (overrideIds.has(override.modelId))
        diagnostics.push(diagnostic(overridePath, "覆盖的 Model ID 必须唯一。"));
      overrideIds.add(override.modelId);
      validatePositive(override.config.contextWindow, [...overridePath, "contextWindow"], diagnostics);
      validatePositive(override.config.maxTokens, [...overridePath, "maxTokens"], diagnostics);
      validateCost(override.config.cost, [...overridePath, "cost"], diagnostics);
      validateMap(override.headers, [...overridePath, "headers"], diagnostics);
      validateCompatMap(
        override.compat?.chatTemplateKwargs,
        [...overridePath, "compat", "chatTemplateKwargs"],
        diagnostics,
      );
    }
  }
  return diagnostics;
}

function validateMap(
  entries: Array<{ key: string }>,
  path: readonly (string | number)[],
  diagnostics: ModelsConfigDiagnostic[],
): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!entry.key.trim()) diagnostics.push(diagnostic([...path, entry.key], "Key 不能为空。"));
    else if (keys.has(entry.key)) diagnostics.push(diagnostic([...path, entry.key], "Key 必须唯一。"));
    keys.add(entry.key);
  }
}

function validateCompatMap(
  entries: Array<{ key: string }> | undefined,
  path: readonly (string | number)[],
  diagnostics: ModelsConfigDiagnostic[],
): void {
  if (entries) validateMap(entries, path, diagnostics);
}

function validatePositive(
  value: number | undefined,
  path: readonly (string | number)[],
  diagnostics: ModelsConfigDiagnostic[],
): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    diagnostics.push(diagnostic(path, "必须是大于零的有限数值。"));
  }
}

function validateCost(
  cost:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        tiers?: Array<{
          inputTokensAbove: number;
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
        }>;
      }
    | undefined,
  path: readonly (string | number)[],
  diagnostics: ModelsConfigDiagnostic[],
): void {
  if (!cost) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = cost[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      diagnostics.push(diagnostic([...path, key], "费用必须是非负有限数值。"));
    }
  }
  const thresholds = new Set<number>();
  cost.tiers?.forEach((tier, index) => {
    if (!Number.isFinite(tier.inputTokensAbove) || tier.inputTokensAbove < 0) {
      diagnostics.push(diagnostic([...path, "tiers", index, "inputTokensAbove"], "阈值必须是非负有限数值。"));
    }
    if (thresholds.has(tier.inputTokensAbove)) {
      diagnostics.push(diagnostic([...path, "tiers", index, "inputTokensAbove"], "阈值不能重复。"));
    }
    thresholds.add(tier.inputTokensAbove);
  });
}

function diagnostic(path: readonly (string | number)[], message: string): ModelsConfigDiagnostic {
  return { severity: "error", code: "renderer.invalid", path, message };
}
