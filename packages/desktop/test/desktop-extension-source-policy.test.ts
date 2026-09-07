import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopExtensionSettingsService } from "../src/main/extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "../src/main/extensions/desktop-extension-source-policy.ts";
import type { CodexPluginRegistryRecord } from "../src/main/plugins/codex/codex-plugin-registry.ts";
import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type DesktopExtensionDefinition,
} from "../src/shared/desktop-extension-contracts.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function codexRecord(id: string, rootPath: string, installedRootPath?: string): CodexPluginRegistryRecord {
  return {
    id,
    displayName: id,
    version: "1.0.0",
    rootPath,
    marketplacePath: join(dirname(rootPath), "marketplace.json"),
    sourcePath: `plugins/${id}`,
    enabled: true,
    discoveredAt: 1,
    ...(installedRootPath ? { installedRootPath, installedHash: "a".repeat(64) } : {}),
  };
}

async function writeCodexPlugin(root: string, name: string): Promise<string> {
  const pluginRoot = join(root, name);
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name, version: "1.0.0", description: "test", author: { name: "test" } })}\n`,
    "utf8",
  );
  return pluginRoot;
}

async function harness(records: CodexPluginRegistryRecord[] = []) {
  const root = join(tmpdir(), `extension-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const curatedRoot = join(root, "curated");
  const curatedPath = join(curatedRoot, "entry.ts");
  await mkdir(curatedRoot, { recursive: true });
  await writeFile(curatedPath, "export default function register() {}\n", "utf8");
  const builtin: DesktopExtensionDefinition[] = [
    {
      id: "builtin",
      displayName: "Builtin",
      source: "builtin",
      hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
      capabilities: [],
    },
  ];
  const curated: DesktopExtensionDefinition[] = [
    {
      id: "curated",
      displayName: "Curated",
      source: "curated",
      entryPath: curatedPath,
      hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
      capabilities: [],
    },
  ];
  const settings = new DesktopExtensionSettingsService(root, {
    builtinDefinitions: builtin,
    curatedDefinitions: curated,
  });
  let generation = 0;
  const policy = new DesktopExtensionSourcePolicy({
    settings,
    getBuiltinDefinitions: () => builtin,
    getCuratedDefinitions: () => curated,
    getCodexExtensions: async () => ({ revision: JSON.stringify(records), plugins: records }),
    curatedRoot,
    createGeneration: () => `generation-${++generation}`,
  });
  return { root, settings, policy };
}

describe("DesktopExtensionSourcePolicy", () => {
  it("loads internal adapters and caches unchanged generations", async () => {
    const { policy } = await harness();
    const first = await policy.resolve("project");
    const second = await policy.resolve("project");
    expect(first.entries.map((entry) => entry.id)).toEqual(["curated", "builtin"]);
    expect(second.generation).toBe(first.generation);
  });

  it("loads explicitly approved development entry files without manifest metadata", async () => {
    const { root, settings, policy } = await harness();
    const entryPath = join(root, "development.ts");
    await writeFile(entryPath, "export default function register() {}\n", "utf8");
    let revision = (await settings.getConfig()).revision;
    const approved = await settings.approveDevelopmentEntry(
      { requestId: "approve", expectedRevision: revision },
      entryPath,
    );
    if (approved.status !== "saved") throw new Error("Expected saved approval");
    revision = approved.snapshot.revision;
    await settings.saveConfig({
      requestId: "enable",
      expectedRevision: revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    const resolved = await policy.resolve("project");
    expect(resolved.entries.map((entry) => entry.source)).toEqual(["curated", "development", "builtin"]);
    expect(resolved.entries.find((entry) => entry.source === "development")?.capabilities).toEqual([]);
  });

  it("keeps discovered but uninstalled Codex plugins out of the loadable set", async () => {
    const root = join(tmpdir(), `codex-source-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const pluginRoot = await writeCodexPlugin(root, "sample");
    const { policy } = await harness([codexRecord("sample", pluginRoot)]);
    expect((await policy.resolve("project")).entries.map((entry) => entry.id)).toEqual(["curated", "builtin"]);
  });

  it("loads and validates an installed Codex copy", async () => {
    const root = join(tmpdir(), `codex-copy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const sourceRoot = join(root, "missing-source");
    const copy = await writeCodexPlugin(root, "sample");
    const installedRoot = join(root, "installed");
    await mkdir(join(installedRoot, ".versions"), { recursive: true });
    await rename(copy, join(installedRoot, ".versions", "a".repeat(64)));
    const { policy } = await harness([codexRecord("sample", sourceRoot, installedRoot)]);
    const resolved = await policy.resolve("project");
    expect(resolved.entries.map((entry) => entry.id)).toEqual(["curated", "sample", "builtin"]);
    expect(resolved.entries[1]?.codexCompanions?.rootPath).toContain(".versions");
  });

  it("reports invalid installed Codex copies without blocking builtins", async () => {
    const root = join(tmpdir(), `codex-broken-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const installedRoot = join(root, "installed");
    await mkdir(join(installedRoot, ".versions", "a".repeat(64)), { recursive: true });
    const { policy } = await harness([codexRecord("sample", join(root, "source"), installedRoot)]);
    const resolved = await policy.resolve("project");
    expect(resolved.entries.map((entry) => entry.id)).toEqual(["curated", "builtin"]);
    expect(resolved.diagnostics).toEqual([
      expect.objectContaining({ extensionId: "sample", code: "CODEX_EXTENSION_ENTRY_UNAVAILABLE" }),
    ]);
  });
});
