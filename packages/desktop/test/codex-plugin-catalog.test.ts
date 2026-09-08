import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexPluginCatalog } from "../src/main/plugins/codex/codex-plugin-catalog.ts";

const fixtureRoot = fileURLToPath(new URL("fixtures/codex/plugins/dart-flutter", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(marketplacePath: string) {
  return {
    id: "dart-flutter",
    displayName: "Dart Flutter",
    version: "1.0.0",
    sourceVersion: "1.0.0",
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

  it("prefers metadata from the immutable installed payload", async () => {
    const root = join(tmpdir(), `codex-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    temporaryRoots.push(root);
    const hash = "a".repeat(64);
    const payload = join(root, ".versions", hash);
    await mkdir(payload, { recursive: true });
    await cp(fixtureRoot, payload, { recursive: true });
    const manifestPath = join(payload, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.interface = { ...(manifest.interface as object), displayName: "Installed Metadata" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const installedRecord = {
      ...record("/home/test/.agents/plugins/marketplace.json"),
      installedRootPath: root,
      installedHash: hash,
    };
    const registry = { getSnapshot: vi.fn().mockResolvedValue({ revision: "one", plugins: [installedRecord] }) };

    const snapshot = await new CodexPluginCatalog(registry as never, {} as never).list();

    expect(snapshot.plugins[0]?.displayName).toBe("Installed Metadata");
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("projects discovery issues without exposing local paths", async () => {
    const registry = { getSnapshot: vi.fn().mockResolvedValue({ revision: "one", plugins: [] }) };
    const catalog = new CodexPluginCatalog(registry as never, {} as never, [
      {
        code: "plugin.invalid",
        pluginName: "broken-tool",
        marketplacePath: "C:\\secret\\marketplace.json",
        message: "C:\\secret\\plugins\\broken-tool is invalid",
      },
    ]);

    const snapshot = await catalog.list();

    expect(snapshot.diagnostics).toEqual([
      { code: "plugin.invalid", pluginId: "broken-tool", message: "插件“broken-tool” manifest 无效。" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("C:\\\\secret");
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
