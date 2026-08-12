import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("keeps the generation stable when extension bytes change", async () => {
    const harness = await createHarness();
    const first = await harness.policy.resolve("project");
    await writeFile(harness.curatedPath, "export deFault function () {}\n", "utf8");

    const second = await harness.policy.resolve("project");

    expect(second.generation).toBe(first.generation);
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

  it("passes development entries with a providers.register capability through unchanged", async () => {
    const harness = await createHarness();
    const developmentRoot = join(harness.root, "provider-dev");
    await mkdir(developmentRoot, { recursive: true });
    await writeFile(join(developmentRoot, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(developmentRoot, "market-manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        plugin: { name: "Provider Dev" },
        pi: { entry: "index.ts" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: ["providers.register"],
      })}\n`,
      "utf8",
    );
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve-provider", expectedRevision: initial.revision },
      developmentRoot,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });

    const resolved = await harness.policy.resolve("project");
    const development = resolved.entries.find((entry) => entry.source === "development");

    expect(development?.capabilities).toContain("providers.register");
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
        message: "本地插件“development.ts”暂不可用，本次会话不会加载该插件。",
      }),
    ]);
    expect(JSON.stringify(resolved.diagnostics)).not.toContain(developmentPath);
  });

  it("injects development configuration from manifest-declared schemas", async () => {
    const harness = await createHarness();
    const pluginRoot = join(harness.root, "dev-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(pluginRoot, "market-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        plugin: { name: "Dev Plugin" },
        pi: { entry: "index.ts" },
        capabilities: ["configuration.read", "tools.register"],
        configuration: {
          version: 1,
          fields: [{ key: "endpoint", label: "Endpoint", type: "text", defaultValue: "https://example.test" }],
        },
      }),
      "utf8",
    );
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve", expectedRevision: initial.revision },
      pluginRoot,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    const getDevelopmentRuntimeConfiguration = vi.fn(async () => ({
      revision: "dev-config-1",
      values: { endpoint: "https://configured.test" },
    }));
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      pluginConfigurations: { getDevelopmentRuntimeConfiguration },
      curatedRoot: harness.curatedRoot,
    });

    const resolved = await harness.policy.resolve("project");
    const devEntry = resolved.entries.find((entry) => entry.source === "development");
    expect(devEntry).toEqual(
      expect.objectContaining({
        capabilities: ["configuration.read", "tools.register"],
        configuration: { endpoint: "https://configured.test" },
      }),
    );
    expect(getDevelopmentRuntimeConfiguration).toHaveBeenCalledOnce();
    expect(getDevelopmentRuntimeConfiguration).toHaveBeenCalledWith(
      expect.stringContaining("development:"),
      expect.objectContaining({ version: 1 }),
    );
    const second = await harness.policy.resolve("project");
    expect(second.generation).toBe(resolved.generation);
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
    };
    await writeMarketplaceProjection(plugin);
    let marketplaceSnapshot = { revision: "market-1", plugins: [plugin] };
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => marketplaceSnapshot,
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
    await writeFile(marketplaceEntry, "export default function modified() {}\n", "utf8");
    const modified = await harness.policy.resolve("project");
    expect(modified.entries.some((entry) => entry.source === "marketplace")).toBe(true);
    expect(modified.diagnostics).toEqual([]);

    marketplaceSnapshot = { revision: "market-2", plugins: [{ ...plugin, enabled: false }] };
    const disabled = await harness.policy.resolve("project");
    expect(disabled.entries.some((entry) => entry.source === "marketplace")).toBe(false);
    expect(disabled.generation).not.toBe(modified.generation);
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

  it("loads project-scoped development entries only in the bound projects", async () => {
    const harness = await createHarness();
    const developmentPath = join(harness.root, "scoped-development.ts");
    await writeFile(developmentPath, "export default function () {}\n", "utf8");
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve-scoped", expectedRevision: initial.revision },
      developmentPath,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    const enabled = await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    if (enabled.status !== "saved") throw new Error("enable failed");
    const scoped = await harness.settings.saveConfig({
      requestId: "scope",
      expectedRevision: enabled.snapshot.revision,
      mutation: {
        type: "set-development-scope",
        extensionId: "development:development",
        scope: "project",
        projectIds: ["bound-project", "second-project"],
      },
    });
    if (scoped.status !== "saved") throw new Error("scope failed");

    const bound = await harness.policy.resolve("bound-project");
    expect(bound.entries.map(({ id }) => id)).toEqual(["curated", "development:development", "builtin"]);

    const second = await harness.policy.resolve("second-project");
    expect(second.entries.map(({ id }) => id)).toEqual(["curated", "development:development", "builtin"]);

    const other = await harness.policy.resolve("other-project");
    expect(other.entries.map(({ id }) => id)).toEqual(["curated", "builtin"]);
    expect(other.diagnostics).toEqual([]);
  });

  it("generates a new set generation when a development entry scope changes", async () => {
    const harness = await createHarness();
    const developmentPath = join(harness.root, "re-scoped-development.ts");
    await writeFile(developmentPath, "export default function () {}\n", "utf8");
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve-rescope", expectedRevision: initial.revision },
      developmentPath,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    const enabled = await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    if (enabled.status !== "saved") throw new Error("enable failed");
    const scoped = await harness.settings.saveConfig({
      requestId: "scope",
      expectedRevision: enabled.snapshot.revision,
      mutation: {
        type: "set-development-scope",
        extensionId: "development:development",
        scope: "project",
        projectIds: ["bound-project"],
      },
    });
    if (scoped.status !== "saved") throw new Error("scope failed");

    const first = await harness.policy.resolve("bound-project");
    const generation = first.generation;
    expect(first.entries.some(({ id }) => id === "development:development")).toBe(true);

    const config = await harness.settings.getConfig();
    const global = await harness.settings.saveConfig({
      requestId: "scope-global",
      expectedRevision: config.revision,
      mutation: { type: "set-development-scope", extensionId: "development:development", scope: "global" },
    });
    if (global.status !== "saved") throw new Error("global scope failed");
    const after = await harness.policy.resolve("bound-project");

    expect(after.generation).not.toBe(generation);
  });

  it("rejects duplicate IDs across controlled sources", async () => {
    const harness = await createHarness({ builtinId: "curated" });
    await expect(harness.policy.resolve("project")).rejects.toThrow("Duplicate Desktop extension ID: curated");
  });

  it("loads project-scoped marketplace entries only in the bound projects", async () => {
    const harness = await createHarness();
    let scopeGeneration = 0;
    const [globalPlugin, projectPlugin] = await createMarketplacePlugins(harness.root, [
      {
        id: "publisher.global",
        displayName: "Global Plugin",
        scope: "global",
      },
      {
        id: "publisher.bound",
        displayName: "Bound Plugin",
        scope: "project",
        projectIds: ["bound-project", "second-project"],
      },
    ]);
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => ({ revision: "market-scope", plugins: [globalPlugin, projectPlugin] }),
      marketplaceRoot: join(harness.root, "marketplace"),
      curatedRoot: harness.curatedRoot,
      createGeneration: () => `scope-generation-${++scopeGeneration}`,
    });

    const bound = await harness.policy.resolve("bound-project");
    expect(bound.entries.map(({ id }) => id)).toEqual(["curated", "publisher.global", "publisher.bound", "builtin"]);

    const second = await harness.policy.resolve("second-project");
    expect(second.entries.map(({ id }) => id)).toEqual(["curated", "publisher.global", "publisher.bound", "builtin"]);

    const other = await harness.policy.resolve("other-project");
    expect(other.entries.map(({ id }) => id)).toEqual(["curated", "publisher.global", "builtin"]);
    expect(other.diagnostics).toEqual([]);
  });

  it("generates a new set generation when a plugin scope changes", async () => {
    const harness = await createHarness();
    const [plugin] = await createMarketplacePlugins(harness.root, [
      { id: "publisher.scoped", displayName: "Scoped Plugin", scope: "global" },
    ]);
    const revision = "market-1";
    let scopeGeneration = 0;
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => ({ revision, plugins: [plugin] }),
      marketplaceRoot: join(harness.root, "marketplace"),
      curatedRoot: harness.curatedRoot,
      createGeneration: () => `scope-generation-${++scopeGeneration}`,
    });

    const first = await harness.policy.resolve("bound-project");
    expect(first.entries.some(({ id }) => id === "publisher.scoped")).toBe(true);

    plugin.scope = "project";
    plugin.projectIds = ["bound-project"];
    const afterProject = await harness.policy.resolve("bound-project");
    expect(afterProject.entries.some(({ id }) => id === "publisher.scoped")).toBe(true);
    expect(afterProject.generation).not.toBe(first.generation);

    plugin.projectIds = ["other-project"];
    const rebound = await harness.policy.resolve("bound-project");
    expect(rebound.entries.some(({ id }) => id === "publisher.scoped")).toBe(false);
    expect(rebound.generation).not.toBe(afterProject.generation);

    const other = await harness.policy.resolve("other-project");
    expect(other.entries.some(({ id }) => id === "publisher.scoped")).toBe(true);
  });

  it("disables the marketplace plugin when a local plugin declares the same plugin ID", async () => {
    const harness = await createHarness();
    const developmentRoot = join(harness.root, "local-dev");
    await mkdir(developmentRoot, { recursive: true });
    await writeFile(join(developmentRoot, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(developmentRoot, "market-manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "publisher.plugin", name: "Local Dev" },
        pi: { entry: "index.ts" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: [],
      })}\n`,
      "utf8",
    );
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve-local", expectedRevision: initial.revision },
      developmentRoot,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    const marketplacePlugins = await createMarketplacePlugins(harness.root, [
      { id: "publisher.plugin", displayName: "Marketplace Plugin" },
    ]);
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => ({ revision: "market-1", plugins: marketplacePlugins }),
      marketplaceRoot: join(harness.root, "marketplace"),
      curatedRoot: harness.curatedRoot,
    });

    const resolved = await harness.policy.resolve("project");

    expect(resolved.entries.map(({ source }) => source)).toEqual(["curated", "development", "builtin"]);
    expect(resolved.entries.find((entry) => entry.source === "development")).toEqual(
      expect.objectContaining({ id: "development:development", pluginId: "publisher.plugin" }),
    );
    expect(resolved.diagnostics).toEqual([
      expect.objectContaining({
        extensionId: "publisher.plugin",
        source: "marketplace",
        code: "DESKTOP_EXTENSION_SUPERSEDED_BY_DEVELOPMENT",
      }),
    ]);
  });

  it("keeps the marketplace plugin when local plugin IDs differ or are out of scope", async () => {
    const harness = await createHarness();
    const developmentRoot = join(harness.root, "local-dev");
    await mkdir(developmentRoot, { recursive: true });
    await writeFile(join(developmentRoot, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(developmentRoot, "market-manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "local.other", name: "Local Dev" },
        pi: { entry: "index.ts" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: [],
      })}\n`,
      "utf8",
    );
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve-local", expectedRevision: initial.revision },
      developmentRoot,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    const enabled = await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    if (enabled.status !== "saved") throw new Error("enable failed");
    const scoped = await harness.settings.saveConfig({
      requestId: "scope",
      expectedRevision: enabled.snapshot.revision,
      mutation: {
        type: "set-development-scope",
        extensionId: "development:development",
        scope: "project",
        projectIds: ["other-project"],
      },
    });
    if (scoped.status !== "saved") throw new Error("scope failed");
    const marketplacePlugins = await createMarketplacePlugins(harness.root, [
      { id: "publisher.plugin", displayName: "Marketplace Plugin" },
    ]);
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => ({ revision: "market-2", plugins: marketplacePlugins }),
      marketplaceRoot: join(harness.root, "marketplace"),
      curatedRoot: harness.curatedRoot,
    });

    const resolved = await harness.policy.resolve("project");

    // 本地插件 ID 不同且 scope 不匹配 project：市场插件保持加载
    expect(resolved.entries.some(({ id }) => id === "publisher.plugin")).toBe(true);
    expect(resolved.diagnostics).toEqual([]);
  });

  it("restores the marketplace plugin after the overriding local plugin is removed", async () => {
    const harness = await createHarness();
    const developmentRoot = join(harness.root, "local-dev");
    await mkdir(developmentRoot, { recursive: true });
    await writeFile(join(developmentRoot, "index.ts"), "export default function () {}\n", "utf8");
    await writeFile(
      join(developmentRoot, "market-manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        plugin: { id: "publisher.plugin", name: "Local Dev" },
        pi: { entry: "index.ts" },
        desktop: { hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION },
        capabilities: [],
      })}\n`,
      "utf8",
    );
    const initial = await harness.settings.getConfig();
    const approved = await harness.settings.approveDevelopmentEntry(
      { requestId: "approve-local", expectedRevision: initial.revision },
      developmentRoot,
    );
    if (approved.status !== "saved") throw new Error("approval failed");
    await harness.settings.saveConfig({
      requestId: "enable-mode",
      expectedRevision: approved.snapshot.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    const marketplacePlugins = await createMarketplacePlugins(harness.root, [
      { id: "publisher.plugin", displayName: "Marketplace Plugin" },
    ]);
    harness.policy = new DesktopExtensionSourcePolicy({
      settings: harness.settings,
      getBuiltinDefinitions: () => harness.builtin,
      getCuratedDefinitions: () => harness.curated,
      getMarketplaceExtensions: async () => ({ revision: "market-3", plugins: marketplacePlugins }),
      marketplaceRoot: join(harness.root, "marketplace"),
      curatedRoot: harness.curatedRoot,
    });

    const suppressed = await harness.policy.resolve("project");
    expect(suppressed.entries.some(({ id }) => id === "publisher.plugin")).toBe(false);

    const settings = await harness.settings.getConfig();
    const removed = await harness.settings.saveConfig({
      requestId: "remove-local",
      expectedRevision: settings.revision,
      mutation: { type: "remove-development-entry", extensionId: "development:development" },
    });
    if (removed.status !== "saved") throw new Error("remove failed");

    const restored = await harness.policy.resolve("project");

    expect(restored.entries.some(({ id }) => id === "publisher.plugin")).toBe(true);
    expect(restored.entries.some(({ source }) => source === "development")).toBe(false);
    expect(restored.diagnostics).toEqual([]);
  });
});

interface MarketplacePluginFixtureSpec {
  id: string;
  displayName: string;
  scope?: "global" | "project";
  projectIds?: string[];
}

async function createMarketplacePlugins(
  root: string,
  specs: MarketplacePluginFixtureSpec[],
): Promise<InstalledMarketplacePluginRecord[]> {
  return Promise.all(
    specs.map(async (spec) => {
      const pluginRoot = join(root, "marketplace", spec.id);
      const entryPath = join(pluginRoot, ".versions", "hash", "payload", "index.ts");
      await mkdir(join(entryPath, ".."), { recursive: true });
      await writeFile(entryPath, "export default function () {}\n", "utf8");
      const plugin: InstalledMarketplacePluginRecord = {
        id: spec.id,
        displayName: spec.displayName,
        marketplaceId: "local.market",
        version: "1.0.0",
        artifactId: "universal",
        artifactHash: "hash",
        enabled: true,
        capabilities: [],
        containsNativeCode: false,
        state: "installed",
        installedAt: 1,
        scope: spec.scope ?? "global",
        ...(spec.scope === "project" ? { projectIds: spec.projectIds ?? [] } : {}),
        entryPath,
        rootPath: pluginRoot,
      };
      await writeMarketplaceProjection(plugin);
      return plugin;
    }),
  );
}

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
