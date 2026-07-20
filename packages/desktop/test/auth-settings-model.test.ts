import { describe, expect, test } from "vitest";
import {
  authDraftsEqual,
  cloneAuthProviders,
  createAuthProviderDraft,
  validateAuthDraft,
} from "../src/renderer/src/features/settings/auth-settings-model.ts";

describe("auth settings draft model", () => {
  test("creates structured provider draft", () => {
    const provider = createAuthProviderDraft("anthropic");
    expect(provider).toEqual(
      expect.objectContaining({
        key: "anthropic",
        apiKey: expect.objectContaining({ key: "", env: [] }),
      }),
    );
  });

  test("deep clones and detects changes", () => {
    const provider = createAuthProviderDraft("anthropic");
    provider.apiKey!.key = "sk-ant-test";
    const clone = cloneAuthProviders([provider]);
    expect(authDraftsEqual([provider], clone)).toBe(true);
    clone[0]!.apiKey!.key = "sk-ant-changed";
    expect(authDraftsEqual([provider], clone)).toBe(false);
  });

  test("reports duplicate provider keys", () => {
    const first = createAuthProviderDraft("dup");
    const second = createAuthProviderDraft("dup");
    const messages = validateAuthDraft([first, second])
      .map((d) => d.message)
      .join("\n");
    expect(messages).toContain("唯一");
  });

  test("reports empty provider key", () => {
    const provider = createAuthProviderDraft("");
    const messages = validateAuthDraft([provider])
      .map((d) => d.message)
      .join("\n");
    expect(messages).toContain("不能为空");
  });

  test("reports duplicate env keys", () => {
    const provider = createAuthProviderDraft("test");
    provider.apiKey!.env = [
      { key: "MY_KEY", value: "a" },
      { key: "MY_KEY", value: "b" },
    ];
    const messages = validateAuthDraft([provider])
      .map((d) => d.message)
      .join("\n");
    expect(messages).toContain("唯一");
  });

  test("reports invalid env key format", () => {
    const provider = createAuthProviderDraft("test");
    provider.apiKey!.env = [{ key: "123-invalid", value: "test" }];
    const messages = validateAuthDraft([provider])
      .map((d) => d.message)
      .join("\n");
    expect(messages).toContain("格式无效");
  });

  test("accepts a valid provider with no env", () => {
    const provider = createAuthProviderDraft("anthropic");
    provider.apiKey!.key = "sk-ant-valid-key";
    expect(validateAuthDraft([provider])).toEqual([]);
  });

  test("accepts a valid provider with env", () => {
    const provider = createAuthProviderDraft("openai");
    provider.apiKey!.key = "$OPENAI_API_KEY";
    provider.apiKey!.env = [{ key: "OPENAI_API_KEY", value: "sk-real" }];
    expect(validateAuthDraft([provider])).toEqual([]);
  });
});
