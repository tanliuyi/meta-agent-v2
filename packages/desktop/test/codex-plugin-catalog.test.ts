import { describe, expect, it, vi } from "vitest";
import { CodexPluginCatalog } from "../src/main/plugins/codex/codex-plugin-catalog.ts";

const fixtureRoot = new URL("fixtures/codex/plugins/dart-flutter", import.meta.url).pathname;

function record(marketplacePath: string) {
  return {
    id: "dart-flutter",
    displayName: "Dart Flutter",
    version: "1.0.0",
    rootPath: fixtureRoot,
    marketplacePath,
    sourcePath: "plugins/dart-flutter",
    enabled: true,
    discoveredAt: 1,
    marketplaceCategory: "Official",
    installationPolicy: "AVAILABLE" as const,
    authenticationPolicy: "ON_INSTALL" as const,
    products: ["CODEX"],
  };
}

describe("CodexPluginCatalog", () => {
  it("maps Codex manifest metadata without exposing executable paths", async () => {
    const registry = {
      getSnapshot: vi.fn().mockResolvedValue({
        revision: "one",
        plugins: [record("C:\\Users\\Test\\.agents\\plugins\\marketplace.json")],
      }),
    };
    const catalog = new CodexPluginCatalog(registry as never, {} as never);

    const snapshot = await catalog.list();

    expect(snapshot.plugins[0]).toMatchObject({
      id: "dart-flutter",
      displayName: "Dart and Flutter",
      developerName: "Dart and Flutter",
      category: "Developer Tools",
      capabilities: ["Skills", "MCP"],
      marketplace: "personal",
      source: "local",
      installed: false,
      marketplaceCategory: "Official",
      installationPolicy: "AVAILABLE",
      authenticationPolicy: "ON_INSTALL",
      products: ["CODEX"],
    });
    expect(snapshot.plugins[0]).not.toHaveProperty("rootPath");
    expect(snapshot.plugins[0]).not.toHaveProperty("marketplacePath");
  });

  it("marks non-personal marketplace files as custom", async () => {
    const registry = {
      getSnapshot: vi.fn().mockResolvedValue({ revision: "one", plugins: [record("/work/team/marketplace.json")] }),
    };
    const catalog = new CodexPluginCatalog(registry as never, {} as never);
    expect((await catalog.list()).plugins[0]?.marketplace).toBe("custom");
  });

  it("maps installer and enabled-state results to renderer snapshots", async () => {
    const snapshot = { revision: "two", plugins: [record("/home/test/.agents/plugins/marketplace.json")] };
    const registry = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      commitEnabled: vi.fn().mockResolvedValue({ status: "saved", snapshot }),
    };
    const installer = {
      install: vi.fn().mockResolvedValue({ status: "installed", snapshot }),
      update: vi.fn().mockResolvedValue({ status: "same-version", snapshot }),
      uninstall: vi.fn().mockResolvedValue({ status: "not-installed", snapshot }),
    };
    const catalog = new CodexPluginCatalog(registry as never, installer as never);
    const input = {
      requestId: "one",
      expectedRevision: "one",
      pluginId: "dart-flutter",
      confirmFullTrust: true as const,
    };

    await expect(catalog.install(input)).resolves.toMatchObject({ status: "installed", snapshot: { revision: "two" } });
    await expect(catalog.update(input)).resolves.toMatchObject({ status: "same-version" });
    await expect(catalog.uninstall({ ...input, confirmRemoval: true })).resolves.toMatchObject({
      status: "not-installed",
    });
    await expect(catalog.setEnabled("one", "dart-flutter", false)).resolves.toMatchObject({ status: "saved" });
  });
});
