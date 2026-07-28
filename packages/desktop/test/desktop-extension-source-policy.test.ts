import { createHash } from "node:crypto";
import { mkdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopExtensionSettingsService } from "../src/main/extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "../src/main/extensions/desktop-extension-source-policy.ts";
import { writeMarketplaceProjection } from "../src/main/plugins/marketplace-installed-plugin.ts";
import type { InstalledMarketplacePluginRecord } from "../src/main/plugins/marketplace-plugin-registry.ts";
import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type DesktopExtensionDefinition,
} from "../src/shared/desktop-extension-contracts.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("DesktopExtensionSourcePolicy", () => {
  it("orders approved paths before inline builtins and caches generation for unchanged inputs", async () => {
    const harness = await createHarness();
    const first = await harness.policy.resolve("project");
    const second = await harness.policy.resolve("project");

    expect(first.generation).toBe("generation-1");
    expect(second.generation).toBe(first.generation);
    expect(first.entries.map(({ id }) => id)).toEqual(["curated", "builtin"]);
    expect(first.entries[0]?.entryPath).toBe(await realpath(harness.curatedPath));
    expect(first.entries[1]?.entryPath).toBeUndefined();
  });

  it("changes generation when extension bytes change even if size and mtime are preserved", async () => {
    const harness = await createHarness();
    const first = await harness.policy.resolve("project");
    const before = await stat(harness.curatedPath);
    await writeFile(harness.curatedPath, "export deFault function () {}\n", "utf8");
    await utimes(harness.curatedPath, before.atime, before.mtime);

    const second = await harness.policy.resolve("project");

    expect(second.generation).not.toBe(first.generation);
  });

  it("loads development entries only after explicit approval and Developer Mode enablement", async () => {
    const harness = await createHarness();
    const developmentPath = join(harness.root, "development.ts");
    await writeFile(developmentPath, "export default function () {}\n", "utf8");
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve", expectedRevision: initial.revision },
      developmentPath,
    );
    if (approved.status !== "saved") throw new Error("approval failed");

    expect((await harness.policy.resolve("project")).entries.map(({ source }) => source)).toEqual([
      "curated",
      "builtin",
    ]);

    await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    const enabled = await harness.policy.resolve("project");

    expect(enabled.generation).toBe("generation-2");
    expect(enabled.entries.map(({ source }) => source)).toEqual(["curated", "development", "builtin"]);
  });

  it("reports a missing development entry without loading it", async () => {
    const harness = await createHarness();
    const developmentPath = join(harness.root, "development.ts");
    await writeFile(developmentPath, "export default function () {}\n", "utf8");
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve", expectedRevision: initial.revision },
      developmentPath,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    await rm(developmentPath);

    const resolved = await harness.policy.resolve("project");

    expect(resolved.entries.some(({ source }) => source === "development")).toBe(false);
    expect(resolved.diagnostics).toEqual([
      expect.objectContaining({
        source: "development",
        code: "DESKTOP_EXTENSION_ENTRY_UNAVAILABLE",
        message: "Development extension entry is unavailable: development.ts",
      }),
    ]);
    expect(JSON.stringify(resolved.diagnostics)).not.toContain(developmentPath);
  });

  it("rejects curated entries that escape the bundled resource root", async () => {
    const harness = await createHarness();
    const outside = join(harness.root, "outside.ts");
    await writeFile(outside, "export default function () {}\n", "utf8");
    harness.curated[0] = { ...harness.curated[0]!, entryPath: outside };

    await expect(harness.policy.resolve("project")).rejects.toThrow("escapes bundled root");
  });

  it("loads enabled marketplace entries from the main-owned installed registry", async () => {
    const harness = await createHarness();
    const marketplaceRoot = join(harness.root, "marketplace", "publisher.plugin");
    const marketplaceEntry = join(marketplaceRoot, ".versions", "hash", "payload", "index.ts");
    await mkdir(join(marketplaceEntry, ".."), { recursive: true });
    const marketplaceSource = "export default function () {}\n";
    await writeFile(marketplaceEntry, marketplaceSource, "utf8");
    const plugin: InstalledMarketplacePluginRecord = {
      id: "publisher.plugin",
      displayName: "Marketplace Plugin",
      marketplaceId: "local.market",
      version: "1.0.0",
      artifactId: "linux-x64",
      artifactHash: "hash",
      enabled: true,
      capabilities: ["tools.register", "configuration.read"],
      containsNativeCode: false,
      configurationSchema: {
        version: 1,
        fields: [{ key: "endpoint", label: "Endpoint", type: "text", defaultValue: "https://example.test" }],
      },
      state: "installed",
      installedAt: 1,
      entryPath: marketplaceEntry,
      rootPath: marketplaceRoot,
      verifiedFiles: [
        {
          path: "payload/index.ts",
          sha256: createHash("sha256").update(marketplaceSource).digest("hex"),
          size: Buffer.byteLength(marketplaceSource),
        },
      ],
    };
    await writeMarketplaceProjection(plugin);
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => ({ revision: "market-1", plugins: [plugin] }),
      pluginConfigurations: {
        getRuntimeConfiguration: async () => ({
          revision: "configuration-1",
          values: { endpoint: "https://configured.test" },
        }),
      },
      marketplaceRoot: join(harness.root, "marketplace"),
      curatedRoot: harness.curatedRoot,
    });

    const resolved = await harness.policy.resolve("project");

    expect(resolved.entries.map(({ source }) => source)).toEqual(["curated", "marketplace", "builtin"]);
    expect(resolved.entries[1]).toEqual(
      expect.objectContaining({
        id: "publisher.plugin",
        entryPath: await realpath(marketplaceEntry),
        capabilities: ["tools.register", "configuration.read"],
        configuration: { endpoint: "https://configured.test" },
      }),
    );
    const restored = await harness.policy.hydrateRuntimeConfigurations({
      ...resolved,
      entries: resolved.entries.map(({ configuration: _configuration, ...entry }) => entry),
    });
    expect(restored.entries[1]).toEqual(
      expect.objectContaining({ configuration: { endpoint: "https://configured.test" } }),
    );

    const blockedPolicy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => ({ revision: "market-1", plugins: [plugin] }),
      getMarketplaceRevocation: async () => ({
        status: "blocked",
        reasonCode: "SECURITY",
        message: "Blocked by signed snapshot",
        checkedAt: 2,
        stale: false,
      }),
      marketplaceRoot: join(harness.root, "marketplace"),
      curatedRoot: harness.curatedRoot,
    });
    const blocked = await blockedPolicy.resolve("project");
    expect(blocked.entries.some((entry) => entry.source === "marketplace")).toBe(false);
    expect(blocked.diagnostics).toEqual([
      expect.objectContaining({ extensionId: "publisher.plugin", code: "DESKTOP_EXTENSION_BLOCKED" }),
    ]);

    await writeFile(marketplaceEntry, "export default function modified() {}\n", "utf8");
    const modified = await harness.policy.resolve("project");
    expect(modified.entries.some((entry) => entry.source === "marketplace")).toBe(false);
    expect(modified.diagnostics).toEqual([
      expect.objectContaining({ extensionId: "publisher.plugin", code: "DESKTOP_EXTENSION_ENTRY_UNAVAILABLE" }),
    ]);
  });

  it("does not load a marketplace registry entry outside the managed extension root", async () => {
    const harness = await createHarness();
    const marketplaceBase = join(harness.root, "marketplace");
    const outsideRoot = join(harness.root, "outside", "publisher.plugin");
    const outsideEntry = join(outsideRoot, "index.ts");
    await mkdir(outsideRoot, { recursive: true });
    await mkdir(marketplaceBase, { recursive: true });
    await writeFile(outsideEntry, "export default function () {}\n", "utf8");
    const plugin: InstalledMarketplacePluginRecord = {
      id: "publisher.plugin",
      displayName: "Outside Plugin",
      marketplaceId: "local.market",
      version: "1.0.0",
      artifactId: "universal",
      artifactHash: "hash",
      enabled: true,
      capabilities: [],
      containsNativeCode: false,
      state: "installed",
      installedAt: 1,
      entryPath: outsideEntry,
      rootPath: outsideRoot,
      verifiedFiles: [],
    };
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => ({ revision: "market-outside", plugins: [plugin] }),
      marketplaceRoot: marketplaceBase,
      curatedRoot: harness.curatedRoot,
    });

    const resolved = await harness.policy.resolve("project");

    expect(resolved.entries.some((entry) => entry.source === "marketplace")).toBe(false);
    expect(resolved.diagnostics).toEqual([
      expect.objectContaining({
        extensionId: "publisher.plugin",
        code: "DESKTOP_EXTENSION_ENTRY_UNAVAILABLE",
      }),
    ]);
  });

  it("rejects duplicate IDs across controlled sources", async () => {
    const harness = await createHarness({ builtinId: "curated" });
    await expect(harness.policy.resolve("project")).rejects.toThrow("Duplicate Desktop extension ID: curated");
  });
});

async function createHarness(options: { builtinId?: string } = {}) {
  const root = join(tmpdir(), `desktop-extension-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  directories.push(root);
  const curatedRoot = join(root, "curated");
  const curatedPath = join(curatedRoot, "curated.ts");
  await mkdir(curatedRoot, { recursive: true });
  await writeFile(curatedPath, "export default function () {}\n", "utf8");
  const builtin: DesktopExtensionDefinition[] = [
    {
      id: options.builtinId ?? "builtin",
      displayName: "Builtin",
      source: "builtin",
      hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
      capabilities: ["providers.register"],
    },
  ];
  const curated: DesktopExtensionDefinition[] = [
    {
      id: "curated",
      displayName: "Curated",
      source: "curated",
      entryPath: curatedPath,
      hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
      capabilities: ["commands.register"],
    },
  ];
  const settings = new DesktopExtensionSettingsService(root, {
    createId: () => "development",
    builtinDefinitions: builtin,
    curatedDefinitions: curated,
  });
  let generation = 0;
  const policy = new DesktopExtensionSourcePolicy({
    settings,
    getBuiltinDefinitions: () => builtin,
    getCuratedDefinitions: () => curated,
    curatedRoot,
    createGeneration: () => `generation-${++generation}`,
  });
  return { root, curatedRoot, curatedPath, curated, builtin, settings, policy };
}
