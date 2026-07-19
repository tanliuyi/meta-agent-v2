import { describe, expect, test } from "vitest";
import {
  cloneModelsProviders,
  createModelDraft,
  createModelOverrideDraft,
  createProviderDraft,
  modelsDraftsEqual,
  validateModelsDraft,
} from "../src/renderer/src/features/settings/models-settings-model.ts";

describe("models settings draft model", () => {
  test("creates structured provider, model, and override drafts", () => {
    const provider = createProviderDraft("local");
    provider.models.push(createModelDraft("qwen"));
    provider.modelOverrides.push(createModelOverrideDraft("built-in"));
    expect(provider).toEqual(
      expect.objectContaining({
        key: "local",
        headers: [],
        models: [expect.objectContaining({ config: { id: "qwen" } })],
        modelOverrides: [expect.objectContaining({ modelId: "built-in" })],
      }),
    );
  });

  test("deep clones origins and detects changes", () => {
    const provider = createProviderDraft("local");
    provider.origin = { providerKey: "original" };
    provider.headers = [
      {
        key: "X-Renamed",
        value: "raw",
        origin: { parentPath: ["providers", "original", "headers"], key: "X-Original" },
      },
    ];
    const clone = cloneModelsProviders([provider]);
    expect(modelsDraftsEqual([provider], clone)).toBe(true);
    clone[0]!.headers[0]!.key = "X-Next";
    expect(modelsDraftsEqual([provider], clone)).toBe(false);
    expect(provider.headers[0]!.origin?.key).toBe("X-Original");
  });

  test("reports duplicate identities, invalid numbers, and map keys", () => {
    const first = createProviderDraft("duplicate");
    const second = createProviderDraft("duplicate");
    first.models = [createModelDraft("same"), createModelDraft("same")];
    first.models[0]!.config.contextWindow = 0;
    first.headers = [
      { key: "X-Key", value: "one" },
      { key: "X-Key", value: "two" },
    ];
    first.modelOverrides = [createModelOverrideDraft("override"), createModelOverrideDraft("override")];
    const messages = validateModelsDraft([first, second])
      .map((diagnostic) => diagnostic.message)
      .join("\n");
    expect(messages).toContain("Provider ID 必须唯一");
    expect(messages).toContain("Model ID 必须唯一");
    expect(messages).toContain("大于零");
    expect(messages).toContain("Key 必须唯一");
    expect(messages).toContain("覆盖的 Model ID 必须唯一");
  });

  test("accepts a valid complete local draft", () => {
    const provider = createProviderDraft("local");
    provider.config = {
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      apiKey: "!security find-generic-password",
    };
    const model = createModelDraft("qwen");
    model.config.contextWindow = 32_768;
    model.config.maxTokens = 8_192;
    model.config.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    provider.models.push(model);
    expect(validateModelsDraft([provider])).toEqual([]);
  });
});
