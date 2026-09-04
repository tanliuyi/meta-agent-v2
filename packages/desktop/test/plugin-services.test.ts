import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginServices } from "../src/main/bootstrap/plugin-services.ts";
import { DesktopExtensionSourcePolicy } from "../src/main/extensions/desktop-extension-source-policy.ts";
import { MarketplacePluginReconciler } from "../src/main/plugins/marketplace-plugin-reconciler.ts";
import { PluginConfigurationService } from "../src/main/plugins/plugin-configuration-service.ts";

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  registry: { getInternalSnapshot: vi.fn() },
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
vi.mock("../src/main/plugins/marketplace-endpoint-settings-service.ts", () => ({
  MarketplaceEndpointSettingsService: vi.fn(),
}));
vi.mock("../src/main/plugins/marketplace-plugin-registry.ts", () => ({
  MarketplacePluginRegistry: vi.fn(function MarketplacePluginRegistry() {
    return mocks.registry;
  }),
}));
vi.mock("../src/main/plugins/plugin-configuration-service.ts", () => ({
  PluginConfigurationService: vi.fn(function PluginConfigurationService(_root, _registry, crypto) {
    mocks.crypto = crypto;
  }),
}));
vi.mock("../src/main/plugins/marketplace-plugin-reconciler.ts", () => ({
  MarketplacePluginReconciler: vi.fn(function MarketplacePluginReconciler() {
    return { reconcile: mocks.reconcile };
  }),
}));
vi.mock("../src/main/plugins/marketplace-generation-reference-tracker.ts", () => ({
  MarketplaceGenerationReferenceTracker: vi.fn(),
}));
vi.mock("../src/main/plugins/marketplace-plugin-garbage-collector.ts", () => ({
  MarketplacePluginGarbageCollector: vi.fn(),
}));
vi.mock("../src/main/plugins/marketplace-catalog-service.ts", () => ({ MarketplaceCatalogService: vi.fn() }));
vi.mock("../src/main/plugins/marketplace-plugin-installer.ts", () => ({ MarketplacePluginInstaller: vi.fn() }));
vi.mock("../src/main/plugins/marketplace-extension-root.ts", () => ({
  resolveMarketplaceExtensionRoot: vi.fn(() => "C:/data/plugins"),
}));
vi.mock("../src/main/plugins/marketplace-plugin-icon-protocol.ts", () => ({
  handleMarketplacePluginIconRequests: vi.fn(),
}));
vi.mock("../src/main/plugins/default-plugin-marketplace.ts", () => ({
  DEFAULT_PLUGIN_MARKETPLACE: { url: "https://example.test" },
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
    mocks.crypto = undefined;
    mocks.reconcile.mockResolvedValue(undefined);
    mocks.encryptionAvailable.mockReturnValue(false);
  });

  it("awaits reconcile before constructing runtime-facing plugin services", async () => {
    let finish!: () => void;
    mocks.reconcile.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = createPluginServices(context(), { desktopVersion: "1.0.0" });
    await Promise.resolve();
    expect(MarketplacePluginReconciler).toHaveBeenCalledOnce();
    expect(DesktopExtensionSourcePolicy).not.toHaveBeenCalled();
    finish();

    await expect(pending).resolves.toMatchObject({ marketplaceRegistry: mocks.registry });
    expect(DesktopExtensionSourcePolicy).toHaveBeenCalledOnce();
  });

  it("propagates reconcile failure without constructing dependent services", async () => {
    mocks.reconcile.mockRejectedValueOnce(new Error("reconcile failed"));
    await expect(createPluginServices(context(), { desktopVersion: "1.0.0" })).rejects.toThrow("reconcile failed");
    expect(DesktopExtensionSourcePolicy).not.toHaveBeenCalled();
  });

  it("preserves unavailable encryption as an explicit capability", async () => {
    await createPluginServices(context(), { desktopVersion: "1.0.0" });
    expect(PluginConfigurationService).toHaveBeenCalledOnce();
    expect(mocks.crypto?.isAvailable()).toBe(false);
  });
});
