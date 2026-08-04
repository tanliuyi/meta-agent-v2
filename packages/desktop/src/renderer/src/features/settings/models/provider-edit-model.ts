import type { AuthProviderDraft } from "../../../../../shared/auth-config-contracts.ts";
import type { ModelsProviderDraft } from "../../../../../shared/models-config-contracts.ts";
import type { ProviderConnectionDefaults } from "../../../../../shared/providers-config-contracts.ts";

interface ProviderEditorDrafts {
  modelsProviders: ModelsProviderDraft[];
  authProviders: AuthProviderDraft[];
}

interface ProviderEditorCommit {
  entryKey: string;
  sourceModelsOriginProviderKey?: string;
  modelsProvider?: ModelsProviderDraft;
  authProvider?: AuthProviderDraft;
}

export function normalizeProviderModelsDraft(
  provider: ModelsProviderDraft | undefined,
  defaults: ProviderConnectionDefaults | undefined,
): ModelsProviderDraft | undefined {
  if (!provider) return undefined;
  const config = { ...provider.config };
  for (const field of ["name", "baseUrl", "api", "authHeader"] as const) {
    if (config[field] === defaults?.[field]) delete config[field];
  }
  if (
    Object.keys(config).length === 0 &&
    provider.headers.length === 0 &&
    provider.models.length === 0 &&
    provider.modelOverrides.length === 0 &&
    provider.compat === undefined
  ) {
    return undefined;
  }
  return { ...provider, config };
}

export function providerEditorDraftsChanged(
  sourceModelsProvider: ModelsProviderDraft | undefined,
  sourceAuthProvider: AuthProviderDraft | undefined,
  nextModelsProvider: ModelsProviderDraft | undefined,
  nextAuthProvider: AuthProviderDraft | undefined,
): boolean {
  return (
    JSON.stringify(sourceModelsProvider) !== JSON.stringify(nextModelsProvider) ||
    JSON.stringify(sourceAuthProvider) !== JSON.stringify(nextAuthProvider)
  );
}

/** Apply one dialog-local provider transaction to the page-level drafts. */
export function commitProviderEditorDrafts(drafts: ProviderEditorDrafts, commit: ProviderEditorCommit): void {
  const modelIndex = drafts.modelsProviders.findIndex(
    (provider) =>
      provider.key === commit.entryKey ||
      (commit.sourceModelsOriginProviderKey !== undefined &&
        provider.origin?.providerKey === commit.sourceModelsOriginProviderKey),
  );
  if (commit.modelsProvider) {
    if (modelIndex >= 0) drafts.modelsProviders[modelIndex] = commit.modelsProvider;
    else drafts.modelsProviders.push(commit.modelsProvider);
  } else if (modelIndex >= 0) {
    drafts.modelsProviders.splice(modelIndex, 1);
  }

  const authIndex = drafts.authProviders.findIndex((provider) => provider.key === commit.entryKey);
  if (commit.authProvider) {
    if (authIndex >= 0) drafts.authProviders[authIndex] = commit.authProvider;
    else drafts.authProviders.push(commit.authProvider);
  } else if (authIndex >= 0) {
    drafts.authProviders.splice(authIndex, 1);
  }
}
