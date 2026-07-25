/**
 * Unified provider config service.
 *
 * Composes ModelsConfigService and AuthConfigService into a single merged
 * view of all providers (built-in, desktop-registered, and custom),
 * plus their credential status. Save writes to both files sequentially.
 */

import { getModelsConfigMetadata } from "@earendil-works/pi-coding-agent/models-config";
import type {
  AuthConfigDiagnostic,
  AuthConfigSnapshot,
  AuthProviderDraft,
  SaveAuthConfigResult,
} from "../../shared/auth-config-contracts.ts";
import type {
  ModelsConfigDiagnostic,
  ModelsConfigSnapshot,
  ModelsProviderDraft,
  SaveModelsConfigInput,
} from "../../shared/models-config-contracts.ts";
import type {
  ProviderCredentialDraft,
  ProviderDiagnostic,
  ProviderEntry,
  ProvidersConfigMetadata,
  ProvidersSnapshot,
  SaveProvidersInput,
  SaveProvidersResult,
} from "../../shared/providers-config-contracts.ts";
import type { AuthConfigService } from "../auth/auth-config-service.ts";
import type { ModelsConfigBackup, ModelsConfigService } from "../models/models-config-service.ts";
import { DesktopBuiltinProviderRegistry } from "../pi/desktop-builtin-provider.ts";

export class ProvidersConfigService {
  private readonly models: ModelsConfigService;
  private readonly auth: AuthConfigService;

  constructor(models: ModelsConfigService, auth: AuthConfigService) {
    this.models = models;
    this.auth = auth;
  }

  async getConfig(): Promise<ProvidersSnapshot> {
    const [modelsSnapshot, authSnapshot] = await Promise.all([this.models.getConfig(), this.auth.getConfig()]);
    return buildSnapshot(modelsSnapshot, authSnapshot);
  }

  async getExternalOpenTarget(): Promise<string> {
    const modelsTarget = await this.models.getExternalOpenTarget();
    const _authTarget = await this.auth.getExternalOpenTarget();
    // Prefer the models.json path; fall back to agent dir.
    return modelsTarget;
  }

  saveConfig(input: SaveProvidersInput): Promise<SaveProvidersResult> {
    return this.saveConfigInner(input);
  }

  private async saveConfigInner(input: SaveProvidersInput): Promise<SaveProvidersResult> {
    const [modelsBackup, baselineAuth] = await Promise.all([this.models.createBackup(), this.auth.getConfig()]);
    const baselineModels = modelsBackup.snapshot;
    if (
      baselineModels.revision !== input.expectedModelsRevision ||
      baselineAuth.revision !== input.expectedAuthRevision
    ) {
      return { status: "conflict", current: await buildSnapshot(baselineModels, baselineAuth) };
    }

    const modelsChanged = !draftsEqual(input.modelsProviders, baselineModels.providers);
    const authChanged = !draftsEqual(input.authProviders, baselineAuth.providers);
    if (!modelsChanged && !authChanged) {
      return { status: "saved", snapshot: await buildSnapshot(baselineModels, baselineAuth) };
    }

    let savedModels = baselineModels;
    if (modelsChanged) {
      const modelsInput: SaveModelsConfigInput = {
        expectedRevision: input.expectedModelsRevision,
        providers: input.modelsProviders,
        ...(input.confirmationToken ? { confirmationToken: input.confirmationToken } : {}),
      };
      const modelsResult = await this.models.saveConfig(modelsInput);
      if (modelsResult.status === "invalid") {
        return {
          status: "invalid",
          diagnostics: modelsResult.diagnostics.map((diagnostic) => ({ ...diagnostic, source: "models" as const })),
        };
      }
      if (modelsResult.status === "conflict") {
        return {
          status: "conflict",
          current: await buildSnapshot(modelsResult.current, await this.auth.getConfig()),
        };
      }
      if (modelsResult.status === "confirmation-required") {
        return {
          status: "confirmation-required",
          reason: "jsonc-comment-move",
          message: modelsResult.message,
          confirmationToken: modelsResult.confirmationToken,
          expectedModelsRevision: input.expectedModelsRevision,
          expectedAuthRevision: input.expectedAuthRevision,
          modelsProviders: input.modelsProviders,
          authProviders: input.authProviders,
        };
      }
      savedModels = modelsResult.snapshot;
    }

    if (!authChanged) return { status: "saved", snapshot: await buildSnapshot(savedModels, baselineAuth) };

    let authResult: SaveAuthConfigResult;
    try {
      authResult = await this.auth.saveConfig({
        expectedRevision: input.expectedAuthRevision,
        providers: input.authProviders,
      });
    } catch (error) {
      if (modelsChanged) await this.rollbackModels(savedModels, modelsBackup);
      throw error;
    }

    if (authResult.status !== "saved") {
      const restoredModels = modelsChanged ? await this.rollbackModels(savedModels, modelsBackup) : baselineModels;
      if (authResult.status === "invalid") {
        return {
          status: "invalid",
          diagnostics: authResult.diagnostics.map((diagnostic) => ({ ...diagnostic, source: "auth" as const })),
        };
      }
      return { status: "conflict", current: await buildSnapshot(restoredModels, authResult.current) };
    }

    return { status: "saved", snapshot: await buildSnapshot(savedModels, authResult.snapshot) };
  }

  private rollbackModels(savedModels: ModelsConfigSnapshot, backup: ModelsConfigBackup): Promise<ModelsConfigSnapshot> {
    return this.models.restoreBackup(backup, savedModels.revision);
  }
}

// =============================================================================
// Snapshot builder
// =============================================================================

function buildSnapshot(modelsSnapshot: ModelsConfigSnapshot, authSnapshot: AuthConfigSnapshot): ProvidersSnapshot {
  const coreMetadata = getModelsConfigMetadata() as ProvidersConfigMetadata;
  const desktopInfos = DesktopBuiltinProviderRegistry.getProviderInfos();
  const desktopProviders = desktopInfos.filter(
    (desktop) => !coreMetadata.builtInProviders.some((builtIn) => builtIn.id === desktop.id),
  );
  const metadata = {
    knownApis: [
      ...new Set([
        ...coreMetadata.knownApis,
        ...desktopProviders.flatMap((provider) => provider.models.map((model) => model.api)),
      ]),
    ].sort(),
    builtInProviders: [
      ...coreMetadata.builtInProviders,
      ...desktopProviders.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        defaultConfig: provider.defaultConfig,
        models: provider.models,
      })),
    ],
  };

  // Auth owns environment mappings and OAuth registration metadata.
  const knownProviders = authSnapshot.knownProviders;

  const allKeys = new Set<string>();
  const entries: ProviderEntry[] = [];

  // 1. AI built-in providers
  for (const bp of coreMetadata.builtInProviders) {
    allKeys.add(bp.id);
    entries.push(
      makeEntry(
        bp.id,
        bp.displayName,
        "ai-builtin",
        bp.models.length,
        modelsSnapshot,
        authSnapshot,
        desktopInfos,
        bp.defaultConfig,
      ),
    );
  }

  // 2. Desktop built-in providers
  for (const dp of desktopInfos) {
    if (allKeys.has(dp.id)) continue;
    allKeys.add(dp.id);
    entries.push(
      makeEntry(dp.id, dp.displayName, "desktop-builtin", dp.models.length, modelsSnapshot, authSnapshot, desktopInfos),
    );
  }

  // 3. Custom providers from either models.json or auth.json.
  for (const mp of modelsSnapshot.providers) {
    if (allKeys.has(mp.key)) continue;
    allKeys.add(mp.key);
    entries.push(makeEntry(mp.key, mp.config.name || mp.key, "custom", 0, modelsSnapshot, authSnapshot, desktopInfos));
  }
  for (const ap of authSnapshot.providers) {
    if (allKeys.has(ap.key)) continue;
    allKeys.add(ap.key);
    const known = knownProviders.find((provider) => provider.id === ap.key);
    entries.push(
      makeEntry(ap.key, known?.displayName ?? ap.key, "custom", 0, modelsSnapshot, authSnapshot, desktopInfos),
    );
  }

  // Merge diagnostics from both sources
  const diagnostics: ProviderDiagnostic[] = [
    ...modelsSnapshot.diagnostics.map(marshalModelsDiagnostic),
    ...authSnapshot.diagnostics.map(marshalAuthDiagnostic),
  ];

  return {
    providers: entries,
    metadata,
    knownProviders,
    modelsProviders: modelsSnapshot.providers,
    authProviders: authSnapshot.providers,
    modelsRevision: modelsSnapshot.revision,
    authRevision: authSnapshot.revision,
    diagnostics,
    preservedUnknownPaths: modelsSnapshot.preservedUnknownPaths,
    modelsSourceState: modelsSnapshot.sourceState,
    authSourceState: authSnapshot.sourceState,
  };
}

function makeEntry(
  key: string,
  displayName: string,
  source: ProviderEntry["source"],
  builtInModelCount: number,
  modelsSnapshot: ModelsConfigSnapshot,
  authSnapshot: AuthConfigSnapshot,
  desktopInfos: Array<{
    id: string;
    displayName: string;
    envKeys: string[];
    defaultConfig: ProviderEntry["defaultConfig"];
  }>,
  builtInDefaultConfig?: ProviderEntry["defaultConfig"],
): ProviderEntry {
  const modelsCfg = modelsSnapshot.providers.find((p) => p.key === key);
  const authCfg = authSnapshot.providers.find((p) => p.key === key);
  const desktopInfo = desktopInfos.find((d) => d.id === key);

  const credentialStatus = computeCredentialStatus(modelsCfg, authCfg, key, desktopInfo?.envKeys);

  return {
    key,
    displayName,
    source,
    builtInModelCount,
    credentialStatus,
    defaultConfig: builtInDefaultConfig ?? desktopInfo?.defaultConfig,
    providerConfig: modelsCfg
      ? {
          name: modelsCfg.config.name,
          baseUrl: modelsCfg.config.baseUrl,
          api: modelsCfg.config.api,
          apiKey: modelsCfg.config.apiKey,
          oauth: modelsCfg.config.oauth,
          authHeader: modelsCfg.config.authHeader,
          headers: modelsCfg.headers.map((h) => ({
            key: h.key,
            value: typeof h.value === "string" ? h.value : String(h.value ?? ""),
          })),
          compat: modelsCfg.compat,
        }
      : undefined,
    models: modelsCfg?.models ?? [],
    modelOverrides: modelsCfg?.modelOverrides ?? [],
    credential: toCredentialDraft(authCfg),
  };
}

function computeCredentialStatus(
  modelsCfg: ModelsProviderDraft | undefined,
  authCfg: AuthProviderDraft | undefined,
  _providerKey: string,
  envKeys?: string[],
): ProviderEntry["credentialStatus"] {
  if (authCfg?.apiKey?.key || authCfg?.oauth) return "configured";
  if (modelsCfg?.config.apiKey) return "configured";
  if (envKeys && envKeys.length > 0) return "env-available";
  return "missing";
}

function toCredentialDraft(authCfg: AuthProviderDraft | undefined): ProviderCredentialDraft | undefined {
  if (!authCfg) return undefined;
  if (authCfg.apiKey) {
    return {
      type: "api_key",
      apiKey: authCfg.apiKey.key,
      env: authCfg.apiKey.env,
    };
  }
  if (authCfg.oauth) {
    return {
      type: "oauth",
      oauthInfo: {
        providerName: authCfg.oauth.providerName,
        expires: authCfg.oauth.expires,
        expired: authCfg.oauth.expired,
      },
    };
  }
  return undefined;
}

function draftsEqual<T>(left: T[], right: T[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function marshalModelsDiagnostic(d: ModelsConfigDiagnostic): ProviderDiagnostic {
  return { ...d, source: "models" as const };
}

function marshalAuthDiagnostic(d: AuthConfigDiagnostic): ProviderDiagnostic {
  return { ...d, source: "auth" as const };
}
