import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginServices } from "../src/main/bootstrap/plugin-services.ts";
import { DesktopExtensionSourcePolicy } from "../src/main/extensions/desktop-extension-source-policy.ts";
import { CodexPluginReconciler } from "../src/main/plugins/codex/codex-plugin-reconciler.ts";
import { PluginConfigurationService } from "../src/main/plugins/plugin-configuration-service.ts";

const mocks = vi.hoisted(() => ({
  registry: { reconcile: vi.fn(), getSnapshot: vi.fn() },
  reconciler: vi.fn(),
  crypto: undefined as { isAvailable(): boolean } | undefined,
  encryptionAvailable: vi.fn(),
}));

vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: mocks.encryptionAvailable, encryptString: vi.fn(), decryptString: vi.fn() },
}));
vi.mock("../src/main/extensions/desktop-extension-registry.ts", () => ({
  DesktopControlledExtensionRegistry: {
    getBuiltinDefinitions: vi.fn(() => []),
    getCuratedDefinitions: vi.fn(() => []),
  },
}));
vi.mock("../src/main/extensions/desktop-extension-settings-service.ts", () => ({
  DesktopExtensionSettingsService: vi.fn(),
}));
vi.mock("../src/main/extensions/desktop-extension-source-policy.ts", () => ({ DesktopExtensionSourcePolicy: vi.fn() }));
vi.mock("../src/main/plugins/codex/codex-plugin-sources.ts", () => ({
  discoverCodexPluginSources: vi.fn().mockResolvedValue({ plugins: [], issues: [] }),
}));
vi.mock("../src/main/plugins/codex/codex-plugin-registry.ts", () => ({
  CodexPluginRegistry: vi.fn(function CodexPluginRegistry() {
    return mocks.registry;
  }),
}));
vi.mock("../src/main/plugins/codex/codex-plugin-reconciler.ts", () => ({
  CodexPluginReconciler: vi.fn(function CodexPluginReconciler() {
    return { reconcile: mocks.reconciler };
  }),
}));
vi.mock("../src/main/plugins/codex/codex-plugin-installer.ts", () => ({ CodexPluginInstaller: vi.fn() }));
vi.mock("../src/main/plugins/codex/codex-plugin-catalog.ts", () => ({ CodexPluginCatalog: vi.fn() }));
vi.mock("../src/main/plugins/plugin-generation-reference-tracker.ts", () => ({
  PluginGenerationReferenceTracker: vi.fn(),
}));
vi.mock("../src/main/plugins/plugin-configuration-service.ts", () => ({
  PluginConfigurationService: vi.fn(function PluginConfigurationService(_root, crypto) {
    mocks.crypto = crypto;
  }),
}));

function context() {
  return {
    userDataDir: "C:/data",
    agentDir: "C:/agent",
    appDir: "C:/app/out/main",
    resourcesPath: "C:/resources",
    isPackaged: false,
    manifest: { compatibility: {} },
    sidecarLog: { write: vi.fn() },
  } as never;
}

describe("createPluginServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registry.reconcile.mockResolvedValue({ revision: "one", plugins: [] });
    mocks.reconciler.mockResolvedValue(undefined);
    mocks.encryptionAvailable.mockReturnValue(false);
  });

  it("reconciles Codex discovery before constructing the source policy", async () => {
    await createPluginServices(context(), { codexHomeDir: "C:/home" });
    expect(mocks.registry.reconcile).toHaveBeenCalledWith([]);
    expect(CodexPluginReconciler).toHaveBeenCalledOnce();
    expect(mocks.reconciler).toHaveBeenCalledOnce();
    expect(DesktopExtensionSourcePolicy).toHaveBeenCalledOnce();
  });

  it("preserves unavailable encryption as an explicit configuration capability", async () => {
    await createPluginServices(context(), {});
    expect(PluginConfigurationService).toHaveBeenCalledOnce();
    expect(mocks.crypto?.isAvailable()).toBe(false);
  });
});
