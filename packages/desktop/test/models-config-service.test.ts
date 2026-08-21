import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { validateModelsConfigValue } from "../src/main/models/models-config-schema.ts";
import { MISSING_MODELS_CONFIG_REVISION, ModelsConfigService } from "../src/main/models/models-config-service.ts";

const SOURCE = `{
  // root comment
  "providers": {
    // provider comment
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "!printf raw-command",
      "headers": {
        // header comment
        "X-Token": "$LOCAL_TOKEN"
      },
      "models": [
        {
          "id": "qwen",
          "name": "Qwen",
          "futureModelField": true
        }
      ],
      "futureProviderField": { "enabled": true }
    }
  },
  "futureRootField": 42
}
`;

describe("ModelsConfigService", () => {
  let directory: string;
  let configPath: string;
  let service: ModelsConfigService;

  beforeEach(async () => {
    directory = join(tmpdir(), `desktop-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    configPath = join(directory, "models.json");
    service = new ModelsConfigService(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("returns a missing snapshot without creating files", async () => {
    const snapshot = await service.getConfig();
    expect(snapshot).toEqual(
      expect.objectContaining({
        exists: false,
        revision: MISSING_MODELS_CONFIG_REVISION,
        sourceState: "missing",
        providers: [],
        activeSessionsRefreshed: false,
      }),
    );
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("loads raw config strings, metadata, origins, and unknown paths", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, "utf8");
    const snapshot = await service.getConfig();
    expect(snapshot.sourceState).toBe("valid");
    expect(snapshot.providers[0]?.config.apiKey).toBe("!printf raw-command");
    expect(snapshot.providers[0]?.headers[0]).toEqual(
      expect.objectContaining({ key: "X-Token", value: "$LOCAL_TOKEN" }),
    );
    expect(snapshot.metadata.builtInProviders.length).toBeGreaterThan(0);
    expect(snapshot.preservedUnknownPaths).toContainEqual(["futureRootField"]);
    expect(snapshot.preservedUnknownPaths).toContainEqual(["providers", "local", "futureProviderField"]);
    expect(snapshot.preservedUnknownPaths).toContainEqual(["providers", "local", "models", 0, "futureModelField"]);
  });

  test("saves field edits atomically while preserving comments and unknown fields", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, { encoding: "utf8", mode: 0o644 });
    const snapshot = await service.getConfig();
    const provider = snapshot.providers[0]!;
    provider.config.baseUrl = "http://localhost:1234/v1";
    provider.config.apiKey = "$NEW_API_KEY";

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: snapshot.providers });
    expect(result.status).toBe("saved");
    const saved = await readFile(configPath, "utf8");
    expect(saved).toContain("// root comment");
    expect(saved).toContain("// provider comment");
    expect(saved).toContain('"futureRootField": 42');
    expect(saved).toContain('"futureProviderField": { "enabled": true }');
    expect(saved).toContain('"futureModelField": true');
    expect(saved).toContain('"baseUrl": "http://localhost:1234/v1"');
    expect(saved).toContain('"apiKey": "$NEW_API_KEY"');
    if (process.platform !== "win32") {
      expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  test("renames provider and header keys without losing attached comments", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, "utf8");
    const snapshot = await service.getConfig();
    const provider = snapshot.providers[0]!;
    provider.key = "renamed-local";
    provider.headers[0]!.key = "X-Renamed";

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: snapshot.providers });
    expect(result.status).toBe("saved");
    const saved = await readFile(configPath, "utf8");
    expect(saved).toContain("// provider comment");
    expect(saved).toContain("// header comment");
    expect(saved).toContain('"renamed-local"');
    expect(saved).toContain('"X-Renamed": "$LOCAL_TOKEN"');
    expect(saved).not.toContain('"X-Token"');
  });

  test("deletes a model by origin without rewriting the following model node", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      configPath,
      `{
  "providers": {
    "local": {
      "baseUrl": "http://localhost/v1",
      "api": "openai-completions",
      "models": [
        { "id": "remove-me", "name": "Remove" },
        {
          // retained model comment
          "id": "keep-me",
          "name": "Keep"
        }
      ]
    }
  }
}\n`,
      "utf8",
    );
    const snapshot = await service.getConfig();
    snapshot.providers[0]!.models.splice(0, 1);
    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: snapshot.providers });
    expect(result.status).toBe("saved");
    const saved = await readFile(configPath, "utf8");
    expect(saved).not.toContain("remove-me");
    expect(saved).toContain("// retained model comment");
    expect(saved).toContain('"id": "keep-me"');
  });

  test("normalizes an empty apiKey to property omission", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, "utf8");
    const snapshot = await service.getConfig();
    snapshot.providers[0]!.config.apiKey = "";
    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: snapshot.providers });
    expect(result.status).toBe("saved");
    expect(await readFile(configPath, "utf8")).not.toContain('"apiKey"');
  });

  test("normalizes undefined optional fields to property omission", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          providers: {
            local: {
              baseUrl: "http://localhost/v1",
              api: "openai-completions",
              compat: { openRouterRouting: { sort: "price" } },
              models: [{ id: "qwen", input: ["text"], thinkingLevelMap: { low: "low" } }],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const snapshot = await service.getConfig();
    const provider = snapshot.providers[0]!;
    provider.models[0]!.config.input = undefined;
    provider.models[0]!.config.thinkingLevelMap = undefined;
    provider.compat!.config.openRouterRouting = { sort: undefined };

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: snapshot.providers });

    expect(result.status).toBe("saved");
    const saved = await readFile(configPath, "utf8");
    expect(saved).not.toContain('"input"');
    expect(saved).not.toContain('"thinkingLevelMap"');
    expect(saved).not.toContain('"sort"');
  });

  test("accepts empty built-in providers and modelOverrides-only providers", () => {
    expect(
      validateModelsConfigValue({
        providers: {
          anthropic: {},
          openai: { modelOverrides: { "gpt-5.5": { maxTokens: 4096 } } },
          custom: { modelOverrides: { inherited: { contextWindow: 128000 } } },
        },
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  test("serializes accepted no-op built-ins and overrides into the system Pi models format", async () => {
    const result = await service.saveConfig({
      expectedRevision: MISSING_MODELS_CONFIG_REVISION,
      providers: [
        { key: "anthropic", config: {}, headers: [], models: [], modelOverrides: [] },
        {
          key: "openai",
          config: {},
          headers: [],
          models: [],
          modelOverrides: [
            {
              modelId: "gpt-5.5",
              config: { name: "Saved Desktop Override", maxTokens: 4096 },
              headers: [],
            },
          ],
        },
      ],
    });
    expect(result.status).toBe("saved");
    const serialized = JSON.parse(await readFile(configPath, "utf8")) as { providers: Record<string, unknown> };
    expect(serialized.providers.anthropic).toBeUndefined();
    expect(serialized.providers.openai).toBeDefined();

    expect(serialized.providers.openai).toEqual({
      modelOverrides: {
        "gpt-5.5": { name: "Saved Desktop Override", maxTokens: 4096 },
      },
    });
  });

  test("reports every Desktop models semantic constraint", () => {
    const result = validateModelsConfigValue({
      providers: {
        "": {},
        custom: {
          models: [
            {
              id: "duplicate",
              contextWindow: 0,
              maxTokens: -1,
              cost: {
                input: -1,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                tiers: [
                  { inputTokensAbove: -1, input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
                  { inputTokensAbove: -1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ],
              },
            },
            {
              id: "duplicate",
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
          modelOverrides: { "": { maxTokens: 0 } },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.diagnostics.map((diagnostic) => diagnostic.path.join("."));
    expect(paths).toEqual(
      expect.arrayContaining([
        "providers.",
        "providers.custom.baseUrl",
        "providers.custom.models.0.api",
        "providers.custom.models.0.contextWindow",
        "providers.custom.models.0.maxTokens",
        "providers.custom.models.0.cost.input",
        "providers.custom.models.0.cost.tiers.0.inputTokensAbove",
        "providers.custom.models.0.cost.tiers.0.input",
        "providers.custom.models.0.cost.tiers.1.inputTokensAbove",
        "providers.custom.models.1.id",
        "providers.custom.models.1.api",
        "providers.custom.modelOverrides.",
        "providers.custom.modelOverrides..maxTokens",
      ]),
    );
  });

  test("rejects empty model ids at schema validation", () => {
    const result = validateModelsConfigValue({
      providers: {
        custom: {
          baseUrl: "https://example.test/v1",
          api: "openai-completions",
          models: [{ id: "" }],
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.path).toEqual(["providers", "custom", "models", 0, "id"]);
  });

  test("rejects semantic errors before replacing models.json", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, "utf8");
    const snapshot = await service.getConfig();
    const original = await readFile(configPath, "utf8");
    const model = snapshot.providers[0]!.models[0]!;
    model.config.contextWindow = 0;
    snapshot.providers[0]!.models.push(structuredClone(model));

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: snapshot.providers });

    expect(result.status).toBe("invalid");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  test("returns invalid snapshots and refuses to overwrite them", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, '{ "providers": [ }', "utf8");
    const snapshot = await service.getConfig();
    expect(snapshot.sourceState).toBe("invalid");
    expect(snapshot.providers).toEqual([]);
    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: [] });
    expect(result).toEqual({ status: "invalid", diagnostics: snapshot.diagnostics });
    expect(await readFile(configPath, "utf8")).toBe('{ "providers": [ }');
  });

  test("returns a conflict and keeps the caller draft after external edits", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, "utf8");
    const snapshot = await service.getConfig();
    snapshot.providers[0]!.config.name = "Local draft";
    await writeFile(configPath, SOURCE.replace("Qwen", "External Qwen"), "utf8");
    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: snapshot.providers });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.current.revision).not.toBe(snapshot.revision);
    expect(snapshot.providers[0]!.config.name).toBe("Local draft");
  });

  test("serializes concurrent saves so only one matching revision wins", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, "utf8");
    const snapshot = await service.getConfig();
    const firstProviders = structuredClone(snapshot.providers);
    const secondProviders = structuredClone(snapshot.providers);
    firstProviders[0]!.config.name = "First";
    secondProviders[0]!.config.name = "Second";
    const results = await Promise.all([
      service.saveConfig({ expectedRevision: snapshot.revision, providers: firstProviders }),
      service.saveConfig({ expectedRevision: snapshot.revision, providers: secondProviders }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["saved", "conflict"]);
  });

  test("restores an exact backup after structural provider changes", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE, "utf8");
    const backup = await service.createBackup();
    const providers = structuredClone(backup.snapshot.providers);
    providers[0]!.key = "renamed-local";
    providers[0]!.models.splice(0, 1);

    const saved = await service.saveConfig({ expectedRevision: backup.snapshot.revision, providers });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") return;

    const restored = await service.restoreBackup(backup, saved.snapshot.revision);
    expect(restored.revision).toBe(backup.snapshot.revision);
    expect(await readFile(configPath, "utf8")).toBe(SOURCE);
  });

  test("restores a missing-file backup after creating models.json", async () => {
    const backup = await service.createBackup();
    const saved = await service.saveConfig({
      expectedRevision: backup.snapshot.revision,
      providers: [
        {
          key: "temporary",
          config: { api: "openai-responses", baseUrl: "https://example.test" },
          headers: [],
          models: [],
          modelOverrides: [],
        },
      ],
    });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") return;

    const restored = await service.restoreBackup(backup, saved.snapshot.revision);
    expect(restored.sourceState).toBe("missing");
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects malformed nested IPC drafts before filesystem work", async () => {
    await expect(
      service.saveConfig({
        expectedRevision: MISSING_MODELS_CONFIG_REVISION,
        providers: [
          {
            key: "local",
            config: {},
            headers: "invalid",
            models: [],
            modelOverrides: [],
          },
        ] as never,
      }),
    ).rejects.toThrow("Invalid provider draft fields");
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects symlinks and non-files", async () => {
    const targetDirectory = `${directory}-target`;
    await mkdir(directory, { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "target.json"), SOURCE, "utf8");
    await symlink(join(targetDirectory, "target.json"), configPath);
    await expect(service.getConfig()).rejects.toThrow("symlink");
    await rm(configPath);
    await mkdir(configPath);
    await expect(service.getConfig()).rejects.toThrow("regular file");
    await rm(targetDirectory, { recursive: true, force: true });
  });
});
