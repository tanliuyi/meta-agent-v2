import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type InstalledMarketplacePluginRecord,
  MarketplacePluginRegistry,
  MISSING_MARKETPLACE_REGISTRY_REVISION,
} from "../src/main/plugins/marketplace-plugin-registry.ts";
import { PluginConfigurationService } from "../src/main/plugins/plugin-configuration-service.ts";
import type { PluginConfigurationSchema } from "../src/shared/plugin-configuration-contracts.ts";

const schema: PluginConfigurationSchema = {
  version: 1,
  fields: [
    { key: "endpoint", label: "Endpoint", type: "text", required: true, defaultValue: "https://example.test" },
    { key: "retries", label: "Retries", type: "number", minimum: 0, maximum: 10, defaultValue: 2 },
    { key: "enabled", label: "Enabled", type: "boolean", defaultValue: true },
    {
      key: "mode",
      label: "Mode",
      type: "select",
      options: [
        { value: "fast", label: "Fast" },
        { value: "safe", label: "Safe" },
      ],
      defaultValue: "safe",
    },
    { key: "token", label: "Token", type: "secret", required: true, minLength: 4 },
  ],
};

function record(root: string): InstalledMarketplacePluginRecord {
  return {
    id: "example.configurable",
    displayName: "Configurable",
    marketplaceId: "example.market",
    version: "1.0.0",
    artifactId: "artifact-one",
    artifactHash: "a".repeat(64),
    enabled: true,
    capabilities: ["tools.register", "configuration.read"],
    containsNativeCode: false,
    configurationSchema: schema,
    state: "installed",
    installedAt: 1,
    entryPath: join(root, "index.js"),
    rootPath: root,
    verifiedFiles: [],
  };
}

describe("plugin configuration service", () => {
  let directory: string;
  let registry: MarketplacePluginRegistry;
  let service: PluginConfigurationService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "plugin-configuration-"));
    registry = new MarketplacePluginRegistry(directory, { createId: () => "registry" });
    const saved = await registry.commitInstall(MISSING_MARKETPLACE_REGISTRY_REVISION, record(directory));
    expect(saved.status).toBe("saved");
    service = new PluginConfigurationService(
      directory,
      registry,
      {
        isAvailable: () => true,
        encrypt: (value) => Buffer.from(`encrypted:${value}`).toString("base64"),
        decrypt: (value) =>
          Buffer.from(value, "base64")
            .toString("utf8")
            .replace(/^encrypted:/, ""),
      },
      { createId: () => "configuration" },
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("applies defaults, encrypts secrets, and returns plaintext only to the runtime", async () => {
    const initial = await service.getConfig("example.configurable");
    expect(initial.values).toEqual({
      endpoint: "https://example.test",
      retries: 2,
      enabled: true,
      mode: "safe",
    });
    expect(initial.secrets).toEqual({ token: false });
    await expect(service.getRuntimeConfiguration("example.configurable")).rejects.toThrow(
      "Plugin configuration is incomplete: example.configurable.token",
    );

    const result = await service.saveConfig({
      requestId: "save-one",
      pluginId: "example.configurable",
      expectedRevision: initial.revision,
      values: { endpoint: "https://api.example.test", retries: 4, enabled: false, mode: "fast" },
      secretValues: { token: "secret-token" },
    });

    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("Expected saved configuration");
    expect(result.snapshot.secrets).toEqual({ token: true });
    expect(JSON.stringify(result.snapshot)).not.toContain("secret-token");
    await expect(service.getRuntimeConfiguration("example.configurable")).resolves.toEqual({
      revision: result.snapshot.revision,
      values: {
        endpoint: "https://api.example.test",
        retries: 4,
        enabled: false,
        mode: "fast",
        token: "secret-token",
      },
    });
    const stored = await readFile(join(directory, "plugins", "configuration", "example.configurable.json"), "utf8");
    expect(stored).not.toContain("secret-token");
  });

  it("returns field validation errors and preserves the current revision", async () => {
    const initial = await service.getConfig("example.configurable");
    const result = await service.saveConfig({
      requestId: "invalid-one",
      pluginId: "example.configurable",
      expectedRevision: initial.revision,
      values: { endpoint: "", retries: 12, enabled: true, mode: "unknown" },
    });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("Expected invalid configuration");
    expect(result.errors.map((error) => [error.field, error.code])).toEqual([
      ["endpoint", "required"],
      ["retries", "maximum"],
      ["mode", "option"],
      ["token", "required"],
    ]);
    expect(result.snapshot.revision).toBe(initial.revision);
  });

  it("uses revision CAS and never returns stored secret plaintext in conflicts", async () => {
    const initial = await service.getConfig("example.configurable");
    const saved = await service.saveConfig({
      requestId: "save-current",
      pluginId: "example.configurable",
      expectedRevision: initial.revision,
      values: { endpoint: "https://one.test", retries: 1, enabled: true, mode: "safe" },
      secretValues: { token: "first-secret" },
    });
    expect(saved.status).toBe("saved");

    const conflict = await service.saveConfig({
      requestId: "save-stale",
      pluginId: "example.configurable",
      expectedRevision: initial.revision,
      values: { endpoint: "https://two.test", retries: 2, enabled: true, mode: "safe" },
    });

    expect(conflict.status).toBe("conflict");
    expect(JSON.stringify(conflict)).not.toContain("first-secret");
  });
});
