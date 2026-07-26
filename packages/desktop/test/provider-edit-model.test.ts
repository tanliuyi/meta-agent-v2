import { describe, expect, test } from "vitest";
import {
  commitProviderEditorDrafts,
  normalizeProviderModelsDraft,
  providerEditorDraftsChanged,
} from "../src/renderer/src/features/settings/provider-edit-model.ts";
import type { AuthProviderDraft } from "../src/shared/auth-config-contracts.ts";
import type { ModelsProviderDraft } from "../src/shared/models-config-contracts.ts";

function modelsProvider(key: string, origin?: string): ModelsProviderDraft {
  return {
    key,
    ...(origin ? { origin: { providerKey: origin } } : {}),
    config: {},
    headers: [],
    models: [],
    modelOverrides: [],
  };
}

describe("provider editor draft commit", () => {
  test("distinguishes reverted local edits from a real transaction", () => {
    const models = modelsProvider("local");
    const auth: AuthProviderDraft = { key: "local", apiKey: { key: "secret" } };

    expect(providerEditorDraftsChanged(models, auth, structuredClone(models), structuredClone(auth))).toBe(false);
    expect(
      providerEditorDraftsChanged(models, auth, { ...models, config: { name: "Changed" } }, structuredClone(auth)),
    ).toBe(true);
  });

  test("removes a built-in provider override after every field returns to its default", () => {
    const configured = {
      ...modelsProvider("meta-agent"),
      config: {
        name: "Meta Agent",
        baseUrl: "https://meta-agent.test/v1",
        api: "openai-responses",
        authHeader: true,
      },
    };

    expect(
      normalizeProviderModelsDraft(configured, {
        name: "Meta Agent",
        baseUrl: "https://meta-agent.test/v1",
        api: "openai-responses",
        authHeader: true,
      }),
    ).toBeUndefined();
  });

  test("keeps a provider override with non-default content", () => {
    const configured = {
      ...modelsProvider("meta-agent"),
      config: { baseUrl: "https://custom.test/v1", api: "openai-responses" },
    };

    expect(
      normalizeProviderModelsDraft(configured, {
        baseUrl: "https://meta-agent.test/v1",
        api: "openai-responses",
      }),
    ).toEqual({ ...configured, config: { baseUrl: "https://custom.test/v1" } });
  });

  test("commits a provider and credential rename as one transaction", () => {
    const drafts = {
      modelsProviders: [modelsProvider("original", "original")],
      authProviders: [{ key: "original", apiKey: { key: "secret" } }] satisfies AuthProviderDraft[],
    };

    commitProviderEditorDrafts(drafts, {
      entryKey: "original",
      sourceModelsOriginProviderKey: "original",
      modelsProvider: { ...modelsProvider("renamed", "original"), config: { name: "Renamed" } },
      authProvider: { key: "renamed", origin: "original", apiKey: { key: "secret" } },
    });

    expect(drafts.modelsProviders).toHaveLength(1);
    expect(drafts.modelsProviders[0]?.key).toBe("renamed");
    expect(drafts.authProviders).toEqual([{ key: "renamed", origin: "original", apiKey: { key: "secret" } }]);
  });

  test("removes credentials without changing the models provider", () => {
    const configured = modelsProvider("local");
    const drafts = {
      modelsProviders: [configured],
      authProviders: [{ key: "local", apiKey: { key: "secret" } }] satisfies AuthProviderDraft[],
    };

    commitProviderEditorDrafts(drafts, {
      entryKey: "local",
      modelsProvider: configured,
      authProvider: undefined,
    });

    expect(drafts.modelsProviders).toEqual([configured]);
    expect(drafts.authProviders).toEqual([]);
  });

  test("adds the first local configuration for a built-in provider", () => {
    const drafts = { modelsProviders: [] as ModelsProviderDraft[], authProviders: [] as AuthProviderDraft[] };
    const configured = { ...modelsProvider("builtin"), config: { baseUrl: "https://example.test/v1" } };

    commitProviderEditorDrafts(drafts, {
      entryKey: "builtin",
      modelsProvider: configured,
    });

    expect(drafts.modelsProviders).toEqual([configured]);
    expect(drafts.authProviders).toEqual([]);
  });
});
