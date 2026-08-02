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
      group: "General",
      order: 1,
      options: [
        { value: "fast", label: "Fast", description: "优先响应速度" },
        { value: "safe", label: "Safe" },
      ],
      defaultValue: "safe",
    },
    {
      key: "slug",
      label: "Slug",
      type: "text",
      group: "Advanced",
      order: 2,
      pattern: "^[a-z0-9-]+$",
      patternMessage: "Slug只能包含小写字母、数字和连字符",
      defaultValue: "default-slug",
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
      slug: "default-slug",
    });
    expect(initial.schema.fields[3]).toMatchObject({ group: "General", order: 1 });
    expect(initial.schema.fields[4]).toMatchObject({
      group: "Advanced",
      order: 2,
      pattern: "^[a-z0-9-]+$",
      patternMessage: "Slug只能包含小写字母、数字和连字符",
    });
    expect(initial.schema.fields[3].type === "select" && initial.schema.fields[3].options[0].description).toBe(
      "优先响应速度",
    );
    expect(initial.secrets).toEqual({ token: false });
    await expect(service.getRuntimeConfiguration("example.configurable")).rejects.toThrow(
      "Plugin configuration is incomplete: example.configurable.token",
    );

    const result = await service.saveConfig({
      requestId: "save-one",
      pluginId: "example.configurable",
      expectedRevision: initial.revision,
      values: {
        endpoint: "https://api.example.test",
        retries: 4,
        enabled: false,
        mode: "fast",
        slug: "api-slug",
      },
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
        slug: "api-slug",
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

  it("rejects values that violate a field pattern and persists matching values", async () => {
    const initial = await service.getConfig("example.configurable");
    const invalid = await service.saveConfig({
      requestId: "pattern-invalid",
      pluginId: "example.configurable",
      expectedRevision: initial.revision,
      values: {
        endpoint: "https://example.test",
        retries: 2,
        enabled: true,
        mode: "safe",
        slug: "UPPER CASE",
      },
      secretValues: { token: "secret-token" },
    });

    expect(invalid.status).toBe("invalid");
    if (invalid.status !== "invalid") throw new Error("Expected invalid configuration");
    expect(invalid.errors).toEqual([{ field: "slug", code: "pattern", message: "Slug只能包含小写字母、数字和连字符" }]);

    const saved = await service.saveConfig({
      requestId: "pattern-valid",
      pluginId: "example.configurable",
      expectedRevision: initial.revision,
      values: {
        endpoint: "https://example.test",
        retries: 2,
        enabled: true,
        mode: "safe",
        slug: "my-slug-1",
      },
      secretValues: { token: "secret-token" },
    });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Expected saved configuration");
    expect(saved.snapshot.values.slug).toBe("my-slug-1");
  });

  it("stores development plugin configuration under an encoded path from the caller-provided schema", async () => {
    const developmentSchema: PluginConfigurationSchema = {
      version: 1,
      fields: [
        { key: "endpoint", label: "Endpoint", type: "text", required: true, defaultValue: "https://example.test" },
        { key: "token", label: "Token", type: "secret", required: true, minLength: 4 },
      ],
    };
    const pluginId = "development:abc123";
    const initial = await service.getDevelopmentConfig(pluginId, developmentSchema);
    expect(initial.pluginId).toBe(pluginId);
    expect(initial.schema.fields.map((field) => field.key)).toEqual(["endpoint", "token"]);
    expect(initial.secrets).toEqual({ token: false });

    const saved = await service.saveDevelopmentConfig(
      {
        requestId: "dev-save",
        pluginId,
        expectedRevision: initial.revision,
        values: { endpoint: "https://dev.example.test" },
        secretValues: { token: "dev-token" },
      },
      developmentSchema,
    );
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("Expected saved configuration");
    expect(saved.snapshot.secrets).toEqual({ token: true });

    await expect(service.getDevelopmentRuntimeConfiguration(pluginId, developmentSchema)).resolves.toEqual({
      revision: saved.snapshot.revision,
      values: { endpoint: "https://dev.example.test", token: "dev-token" },
    });

    const stored = await readFile(join(directory, "plugins", "configuration", "development%3Aabc123.json"), "utf8");
    expect(stored).toContain("https://dev.example.test");
    expect(stored).not.toContain("dev-token");
    await expect(
      readFile(join(directory, "plugins", "configuration", "development_abc123.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects invalid development ids and unknown development fields", async () => {
    const schema: PluginConfigurationSchema = {
      version: 1,
      fields: [{ key: "endpoint", label: "Endpoint", type: "text" }],
    };
    await expect(service.getDevelopmentConfig("example.configurable", schema)).rejects.toThrow(
      "Development plugin configuration ID is invalid",
    );
    await expect(service.getDevelopmentConfig("development:UPPER", schema)).rejects.toThrow(
      "Development plugin configuration ID is invalid",
    );
    const initial = await service.getDevelopmentConfig("development:abc123", schema);
    await expect(
      service.saveDevelopmentConfig(
        {
          requestId: "dev-bad",
          pluginId: "development:abc123",
          expectedRevision: initial.revision,
          values: { unknown: "x" },
        },
        schema,
      ),
    ).rejects.toThrow("Unknown non-secret plugin configuration field: unknown");
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
