import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthConfigService, MISSING_AUTH_CONFIG_REVISION } from "../src/main/auth/auth-config-service.ts";

const SOURCE_VALID = JSON.stringify(
  {
    anthropic: { type: "api_key", key: "sk-ant-valid" },
    openai: { type: "api_key", key: "$OPENAI_API_KEY", env: { OPENAI_API_KEY: "sk-real-secret" } },
    "github-copilot": {
      type: "oauth",
      accessToken: "gho_token",
      refreshToken: "ghr_refresh",
      expires: Date.now() + 86400000,
    },
  },
  null,
  2,
);

describe("AuthConfigService", () => {
  let directory: string;
  let configPath: string;
  let service: AuthConfigService;

  beforeEach(async () => {
    directory = join(tmpdir(), `desktop-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    configPath = join(directory, "auth.json");
    service = new AuthConfigService(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("returns a missing snapshot without creating files", async () => {
    const snapshot = await service.getConfig();
    expect(snapshot).toEqual(
      expect.objectContaining({
        exists: false,
        revision: MISSING_AUTH_CONFIG_REVISION,
        sourceState: "missing",
        providers: [],
      }),
    );
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("loads API key credentials correctly", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    expect(snapshot.sourceState).toBe("valid");
    expect(snapshot.exists).toBe(true);
    expect(snapshot.providers).toHaveLength(3);

    const anthropic = snapshot.providers.find((p) => p.key === "anthropic");
    expect(anthropic?.apiKey?.key).toBe("sk-ant-valid");

    const openai = snapshot.providers.find((p) => p.key === "openai");
    expect(openai?.apiKey?.key).toBe("$OPENAI_API_KEY");
    expect(openai?.apiKey?.env).toHaveLength(1);
    expect(openai!.apiKey!.env![0]).toEqual({ key: "OPENAI_API_KEY", value: "sk-real-secret" });
  });

  test("loads OAuth credential as read-only summary", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const copilot = snapshot.providers.find((p) => p.key === "github-copilot");
    expect(copilot?.oauth).toBeDefined();
    expect(copilot?.oauth?.providerName).toBe("github-copilot");
    expect(copilot?.oauth?.expired).toBe(false);
    expect(copilot?.oauth?.expires).toBeDefined();
    // OAuth tokens must not be exposed
    expect(JSON.stringify(snapshot)).not.toContain("gho_token");
    expect(JSON.stringify(snapshot)).not.toContain("ghr_refresh");
  });

  test("returns known providers with env keys", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    expect(snapshot.knownProviders.length).toBeGreaterThan(0);
    const anthropic = snapshot.knownProviders.find((kp) => kp.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.displayName).toBeTruthy();
  });

  test("saves API key credentials and returns new snapshot", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const providers = snapshot.providers;
    const anthropic = providers.find((p) => p.key === "anthropic")!;
    anthropic.apiKey!.key = "sk-ant-updated";

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    const savedContent = JSON.parse(await readFile(configPath, "utf8"));
    expect(savedContent.anthropic.key).toBe("sk-ant-updated");

    if (process.platform !== "win32") {
      expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  test("normalizes empty key to delete provider", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const providers = snapshot.providers.filter((p) => p.key !== "openai");

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    const savedContent = JSON.parse(await readFile(configPath, "utf8"));
    expect(savedContent.openai).toBeUndefined();
  });

  test("normalizes empty env map to omit env property", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const providers = snapshot.providers;
    const openai = providers.find((p) => p.key === "openai")!;
    openai.apiKey!.env = [];

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    const savedContent = JSON.parse(await readFile(configPath, "utf8"));
    expect(savedContent.openai.env).toBeUndefined();
  });

  test("validates key syntax and rejects invalid keys", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const providers = snapshot.providers;
    const anthropic = providers.find((p) => p.key === "anthropic")!;

    // empty key (should normalize to delete the provider but not error)
    anthropic.apiKey!.key = "";
    let result = await service.saveConfig({ expectedRevision: snapshot.revision, providers });
    expect(result.status).toBe("saved");
    expect(JSON.parse(await readFile(configPath, "utf8")).anthropic).toBeUndefined();

    // Invalid !! command
    const freshSnapshot = await service.getConfig();
    const freshProviders = freshSnapshot.providers.filter((p) => p.key !== "anthropic");
    freshProviders.push({ key: "anthropic", apiKey: { key: "!!invalid" } });
    result = await service.saveConfig({ expectedRevision: freshSnapshot.revision, providers: freshProviders });
    expect(result.status).toBe("invalid");

    // Unmatched brackets
    const freshSnapshot2 = await service.getConfig();
    const freshProviders2 = freshSnapshot2.providers.filter((p) => p.key !== "anthropic");
    freshProviders2.push({ key: "anthropic", apiKey: { key: "${UNCLOSED" } });
    result = await service.saveConfig({ expectedRevision: freshSnapshot2.revision, providers: freshProviders2 });
    expect(result.status).toBe("invalid");

    const freshSnapshot3 = await service.getConfig();
    const freshProviders3 = freshSnapshot3.providers.filter((p) => p.key !== "anthropic");
    freshProviders3.push({ key: "anthropic", apiKey: { key: "$" } });
    result = await service.saveConfig({ expectedRevision: freshSnapshot3.revision, providers: freshProviders3 });
    expect(result.status).toBe("invalid");
  });

  test("removes OAuth credentials when the provider is removed", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const providers = snapshot.providers.filter((provider) => provider.key !== "github-copilot");

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers });
    expect(result.status).toBe("saved");
    expect(JSON.parse(await readFile(configPath, "utf8"))["github-copilot"]).toBeUndefined();
  });

  test("preserves JSONC comments and unknown provider fields", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      configPath,
      '{\n  // Keep this comment\n  "anthropic": {\n    "type": "api_key",\n    "key": "old-key",\n    "futureField": { "enabled": true }\n  }\n}\n',
      "utf8",
    );
    const snapshot = await service.getConfig();
    const provider = snapshot.providers.find((item) => item.key === "anthropic")!;
    provider.apiKey!.key = "new-key";

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: snapshot.providers });
    expect(result.status).toBe("saved");
    const saved = await readFile(configPath, "utf8");
    expect(saved).toContain("// Keep this comment");
    expect(saved).toContain('"futureField": { "enabled": true }');
    expect(saved).toContain('"key": "new-key"');
  });

  test("returns a schema diagnostic for malformed provider entries", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, '{ "broken": null }', "utf8");

    const snapshot = await service.getConfig();
    expect(snapshot.sourceState).toBe("invalid");
    expect(snapshot.diagnostics[0]).toEqual(expect.objectContaining({ code: "schema.provider", path: ["broken"] }));
  });

  test("rejects malformed env keys", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const providers = snapshot.providers;
    const openai = providers.find((p) => p.key === "openai")!;
    openai.apiKey!.env = [{ key: "123invalid", value: "test" }];

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers });
    expect(result.status).toBe("invalid");
  });

  test("returns conflict after external edits", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const providers = snapshot.providers;
    providers[0]!.apiKey!.key = "local-draft";
    await writeFile(
      configPath,
      JSON.stringify({ ...JSON.parse(SOURCE_VALID), anthropic: { type: "api_key", key: "external" } }, null, 2),
      "utf8",
    );

    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers });
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") return;
    expect(result.current.revision).not.toBe(snapshot.revision);
  });

  test("serializes concurrent saves so only one matching revision wins", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, SOURCE_VALID, "utf8");
    const snapshot = await service.getConfig();
    const firstProviders = structuredClone(snapshot.providers);
    const secondProviders = structuredClone(snapshot.providers);
    firstProviders[0]!.apiKey!.key = "first";
    secondProviders[0]!.apiKey!.key = "second";

    const results = await Promise.all([
      service.saveConfig({ expectedRevision: snapshot.revision, providers: firstProviders }),
      service.saveConfig({ expectedRevision: snapshot.revision, providers: secondProviders }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["saved", "conflict"]);
  });

  test("rejects malformed input before filesystem work", async () => {
    await expect(
      service.saveConfig({
        expectedRevision: MISSING_AUTH_CONFIG_REVISION,
        providers: [{ key: undefined }] as never,
      }),
    ).rejects.toThrow("Invalid provider draft");
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects symlinks and non-files", async () => {
    const targetDirectory = `${directory}-target`;
    await mkdir(directory, { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "target.json"), SOURCE_VALID, "utf8");
    await symlink(join(targetDirectory, "target.json"), configPath);
    await expect(service.getConfig()).rejects.toThrow("symlink");
    await rm(configPath);
    await mkdir(configPath);
    await expect(service.getConfig()).rejects.toThrow("regular file");
    await rm(targetDirectory, { recursive: true, force: true });
  });

  test("returns invalid snapshot for unparseable JSON", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(configPath, "{ invalid json }", "utf8");
    const snapshot = await service.getConfig();
    expect(snapshot.sourceState).toBe("invalid");
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.diagnostics.length).toBeGreaterThan(0);

    // Saving should fail on invalid source
    const result = await service.saveConfig({ expectedRevision: snapshot.revision, providers: [] });
    expect(result.status).toBe("invalid");
  });
});
