import { describe, expect, test, vi } from "vitest";
import { ProvidersConfigService } from "../src/main/providers/providers-config-service.ts";
import type { AuthConfigSnapshot, AuthProviderDraft } from "../src/shared/auth-config-contracts.ts";
import type { ModelsConfigSnapshot, ModelsProviderDraft } from "../src/shared/models-config-contracts.ts";

function modelProvider(name = "Original"): ModelsProviderDraft {
  return {
    key: "custom-models",
    origin: { providerKey: "custom-models" },
    config: { name },
    headers: [],
    models: [],
    modelOverrides: [],
  };
}

function modelsSnapshot(revision: string, providers: ModelsProviderDraft[] = []): ModelsConfigSnapshot {
  return {
    path: "/agent/models.json",
    exists: true,
    revision,
    sourceState: "valid",
    providers,
    metadata: { knownApis: [], builtInProviders: [] },
    diagnostics: [],
    preservedUnknownPaths: [],
    activeSessionsRefreshed: false,
  };
}

function authSnapshot(revision: string, providers: AuthProviderDraft[] = []): AuthConfigSnapshot {
  return {
    path: "/agent/auth.json",
    exists: true,
    revision,
    sourceState: "valid",
    providers,
    diagnostics: [],
    knownProviders: [],
  };
}

function createService(
  models: ModelsConfigSnapshot,
  auth: AuthConfigSnapshot,
  modelRuntime?: { getProviderAuthStatus(providerId: string): { configured: boolean; source?: string } },
) {
  const modelsService = {
    getConfig: vi.fn(async () => models),
    createBackup: vi.fn(async () => ({ snapshot: models, exists: models.exists, source: "" })),
    restoreBackup: vi.fn(),
    getExternalOpenTarget: vi.fn(async () => models.path),
    saveConfig: vi.fn(),
  };
  const authService = {
    getConfig: vi.fn(async () => auth),
    getExternalOpenTarget: vi.fn(async () => auth.path),
    saveConfig: vi.fn(),
  };
  return {
    service: new ProvidersConfigService(modelsService as never, authService as never, modelRuntime as never),
    modelsService,
    authService,
  };
}

describe("ProvidersConfigService", () => {
  test("classifies dynamic core providers as AI built-ins", async () => {
    const { service } = createService(modelsSnapshot("m0"), authSnapshot("a0"));

    const snapshot = await service.getConfig();

    expect(snapshot.providers).toContainEqual(
      expect.objectContaining({
        key: "radius",
        source: "ai-builtin",
        builtInModelCount: 0,
      }),
    );
  });

  test("includes custom providers that exist only in auth.json", async () => {
    const credential = { key: "auth-only-test-provider", apiKey: { key: "secret" } } satisfies AuthProviderDraft;
    const { service } = createService(modelsSnapshot("m0"), authSnapshot("a0", [credential]));

    const snapshot = await service.getConfig();

    expect(snapshot.providers).toContainEqual(
      expect.objectContaining({
        key: "auth-only-test-provider",
        source: "custom",
        credentialStatus: "configured",
      }),
    );
  });

  test("uses refreshed ModelRuntime auth status instead of treating env variable names as available credentials", async () => {
    const runtime = {
      getProviderAuthStatus: vi.fn((providerId: string) =>
        providerId === "anthropic" ? { configured: false } : { configured: true, source: "environment" },
      ),
    };
    const { service } = createService(modelsSnapshot("m0"), authSnapshot("a0"), runtime);

    const snapshot = await service.getConfig();

    expect(snapshot.providers.find(({ key }) => key === "anthropic")?.credentialStatus).toBe("missing");
    expect(snapshot.providers.some(({ credentialStatus }) => credentialStatus === "env-available")).toBe(true);
  });

  test("reports a stored but unresolved credential as missing for a known provider", async () => {
    const runtime = {
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getModels: (providerId: string) => (providerId === "anthropic" ? [{ id: "model" }] : []),
      hasConfiguredAuth: () => false,
    };
    const auth = authSnapshot("a0", [{ key: "anthropic", apiKey: { key: "$MISSING_ANTHROPIC_KEY" } }]);
    const { service } = createService(modelsSnapshot("m0"), auth, runtime);

    const snapshot = await service.getConfig();

    expect(snapshot.providers.find(({ key }) => key === "anthropic")?.credentialStatus).toBe("missing");
  });

  test("does not rewrite models.json for an auth-only change", async () => {
    const baselineAuth = authSnapshot("a0", [{ key: "anthropic", apiKey: { key: "old" } }]);
    const savedAuth = authSnapshot("a1", [{ key: "anthropic", apiKey: { key: "new" } }]);
    const baselineModels = modelsSnapshot("m0");
    const { service, modelsService, authService } = createService(baselineModels, baselineAuth);
    authService.saveConfig.mockResolvedValue({ status: "saved", snapshot: savedAuth });

    const result = await service.saveConfig({
      expectedModelsRevision: "m0",
      expectedAuthRevision: "a0",
      modelsProviders: [],
      authProviders: savedAuth.providers,
    });

    expect(result.status).toBe("saved");
    expect(modelsService.saveConfig).not.toHaveBeenCalled();
    expect(authService.saveConfig).toHaveBeenCalledOnce();
  });

  test("rolls models.json back when auth save conflicts", async () => {
    const baselineProvider = modelProvider();
    const changedProvider = modelProvider("Changed");
    const baselineModels = modelsSnapshot("m0", [baselineProvider]);
    const savedModels = modelsSnapshot("m1", [changedProvider]);
    const restoredModels = modelsSnapshot("m0", [baselineProvider]);
    const baselineAuth = authSnapshot("a0", [{ key: "anthropic", apiKey: { key: "old" } }]);
    const externalAuth = authSnapshot("a-external", [{ key: "anthropic", apiKey: { key: "external" } }]);
    const { service, modelsService, authService } = createService(baselineModels, baselineAuth);
    modelsService.saveConfig.mockResolvedValueOnce({ status: "saved", snapshot: savedModels });
    modelsService.restoreBackup.mockResolvedValue(restoredModels);
    authService.saveConfig.mockResolvedValue({ status: "conflict", current: externalAuth });

    const result = await service.saveConfig({
      expectedModelsRevision: "m0",
      expectedAuthRevision: "a0",
      modelsProviders: [changedProvider],
      authProviders: [{ key: "anthropic", apiKey: { key: "new" } }],
    });

    expect(result.status).toBe("conflict");
    expect(modelsService.restoreBackup).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: baselineModels }),
      "m1",
    );
  });

  test("detects either revision conflict before writing", async () => {
    const { service, modelsService, authService } = createService(modelsSnapshot("m1"), authSnapshot("a0"));

    const result = await service.saveConfig({
      expectedModelsRevision: "m0",
      expectedAuthRevision: "a0",
      modelsProviders: [],
      authProviders: [],
    });

    expect(result.status).toBe("conflict");
    expect(modelsService.saveConfig).not.toHaveBeenCalled();
    expect(authService.saveConfig).not.toHaveBeenCalled();
  });
});
