import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopExtensionSettingsService,
  MISSING_DESKTOP_EXTENSION_SETTINGS_REVISION,
} from "../src/main/extensions/desktop-extension-settings-service.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = join(tmpdir(), `desktop-extension-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return { root, service: new DesktopExtensionSettingsService(root, { createId: () => "local-one" }) };
}

describe("DesktopExtensionSettingsService", () => {
  it("starts with developer mode disabled", async () => {
    const { service } = await harness();
    await expect(service.getConfig()).resolves.toMatchObject({
      revision: MISSING_DESKTOP_EXTENSION_SETTINGS_REVISION,
      developerMode: false,
      entries: [],
    });
  });

  it("approves a single development entry without external manifest metadata", async () => {
    const { root, service } = await harness();
    const entryPath = join(root, "sample.mjs");
    await writeFile(entryPath, "export default function register() {}\n", "utf8");
    const initial = await service.getConfig();

    const result = await service.approveDevelopmentEntry(
      { requestId: "approve", expectedRevision: initial.revision },
      entryPath,
    );

    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("Expected saved settings");
    expect(result.snapshot.entries[0]).toMatchObject({
      id: "development:local-one",
      displayName: "sample.mjs",
      source: "development",
      capabilities: [],
    });
  });

  it("accepts a directory with a conventional index entry", async () => {
    const { root, service } = await harness();
    const pluginRoot = join(root, "sample-plugin");
    await mkdir(pluginRoot);
    await writeFile(join(pluginRoot, "index.ts"), "export default function register() {}\n", "utf8");

    const result = await service.approveDevelopmentEntry(
      { requestId: "approve-dir", expectedRevision: (await service.getConfig()).revision },
      pluginRoot,
    );

    expect(result.status).toBe("saved");
    if (result.status === "saved") expect(result.snapshot.entries[0]?.displayName).toBe("sample-plugin");
  });

  it("rejects a manifest-only legacy plugin directory", async () => {
    const { root, service } = await harness();
    const pluginRoot = join(root, "legacy-plugin");
    await mkdir(pluginRoot);
    await writeFile(join(pluginRoot, "market-manifest.json"), "{}\n", "utf8");

    await expect(
      service.approveDevelopmentEntry(
        { requestId: "approve-legacy", expectedRevision: (await service.getConfig()).revision },
        pluginRoot,
      ),
    ).rejects.toThrow("no index entry file");
  });

  it("uses revision CAS for development settings mutations", async () => {
    const { service } = await harness();
    const initial = await service.getConfig();
    const saved = await service.saveConfig({
      requestId: "enable",
      expectedRevision: initial.revision,
      mutation: { type: "set-developer-mode", enabled: true },
    });
    expect(saved.status).toBe("saved");
    const conflict = await service.saveConfig({
      requestId: "stale",
      expectedRevision: initial.revision,
      mutation: { type: "set-developer-mode", enabled: false },
    });
    expect(conflict.status).toBe("conflict");
  });
});
