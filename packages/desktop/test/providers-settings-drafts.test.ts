import { describe, expect, test } from "vitest";
import { createAuthProviderDraft } from "../src/renderer/src/features/settings/auth/auth-settings-model.ts";
import { createProviderDraft } from "../src/renderer/src/features/settings/models/models-settings-model.ts";
import { applyDraftsMutator } from "../src/renderer/src/features/settings/models/use-providers-controller.ts";
import type { AuthProviderDraft } from "../src/shared/auth-config-contracts.ts";

describe("applyDraftsMutator", () => {
  test("deleting a provider via array replacement removes it from both drafts", () => {
    const models = [createProviderDraft("local"), createProviderDraft("other")];
    const auth = [createAuthProviderDraft("local"), createAuthProviderDraft("other")];

    const result = applyDraftsMutator(
      (drafts) => {
        drafts.modelsProviders = drafts.modelsProviders.filter((provider) => provider.key !== "local");
        drafts.authProviders = drafts.authProviders.filter((provider) => provider.key !== "local");
      },
      models,
      auth,
    );

    expect(result.modelsProviders.map((provider) => provider.key)).toEqual(["other"]);
    expect(result.authProviders.map((provider) => provider.key)).toEqual(["other"]);
  });

  test("in-place edits (push) are preserved", () => {
    const result = applyDraftsMutator(
      (drafts) => {
        drafts.modelsProviders.push(createProviderDraft("added"));
        drafts.authProviders.push(createAuthProviderDraft("added"));
      },
      [],
      [],
    );

    expect(result.modelsProviders.map((provider) => provider.key)).toEqual(["added"]);
    expect(result.authProviders.map((provider) => provider.key)).toEqual(["added"]);
  });

  test("source arrays are not mutated", () => {
    const models = [createProviderDraft("local")];
    const auth: AuthProviderDraft[] = [];

    const result = applyDraftsMutator(
      (drafts) => {
        drafts.modelsProviders = [];
        drafts.authProviders.push(createAuthProviderDraft("added"));
      },
      models,
      auth,
    );

    expect(result.modelsProviders).toEqual([]);
    expect(result.authProviders.map((provider) => provider.key)).toEqual(["added"]);
    expect(models).toHaveLength(1);
    expect(auth).toHaveLength(0);
  });
});
