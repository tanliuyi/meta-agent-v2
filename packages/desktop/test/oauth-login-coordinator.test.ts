import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { OauthLoginCoordinator } from "../src/main/auth/oauth-login-coordinator.ts";
import type { AuthOauthLoginEvent } from "../src/shared/auth-config-contracts.ts";

const snapshot = {
  path: "/agent/auth.json",
  exists: true,
  revision: "saved",
  sourceState: "valid" as const,
  providers: [],
  diagnostics: [],
  knownProviders: [],
};

describe("OauthLoginCoordinator", () => {
  test("bridges interactive prompts and returns the saved snapshot", async () => {
    let interaction: AuthInteraction | undefined;
    const events: AuthOauthLoginEvent[] = [];
    const opened: string[] = [];
    const coordinator = new OauthLoginCoordinator({
      createId: () => "request-1",
      login: async (_providerId, nextInteraction) => {
        interaction = nextInteraction;
        nextInteraction.notify({ type: "auth_url", url: "https://auth.example.test", instructions: "Sign in" });
        expect(await nextInteraction.prompt({ type: "text", message: "Paste code" })).toBe("secret-code");
        return snapshot;
      },
    });

    const resultPromise = coordinator.start(
      7,
      { loginId: "login-1", providerId: "anthropic" },
      (event) => {
        events.push(event);
        if (event.type === "request") {
          coordinator.respond(7, { loginId: event.loginId, requestId: event.requestId, value: "secret-code" });
        }
      },
      async (url) => {
        opened.push(url);
      },
    );

    await expect(resultPromise).resolves.toBe(snapshot);
    expect(interaction).toBeDefined();
    expect(opened).toEqual(["https://auth.example.test"]);
    expect(events.map((event) => event.type)).toEqual(["auth", "request"]);
  });

  test("preserves allowEmpty from extension OAuth prompts", async () => {
    const requests: Extract<AuthOauthLoginEvent, { type: "request" }>[] = [];
    const coordinator = new OauthLoginCoordinator({
      createId: () => "allow-empty-request",
      login: async (_providerId, interaction) => {
        const prompt = { type: "text", message: "Optional team", allowEmpty: true } as const;
        expect(await interaction.prompt(prompt)).toBe("");
        return snapshot;
      },
    });

    const login = coordinator.start(
      4,
      { loginId: "allow-empty-login", providerId: "extension-provider" },
      (event) => {
        if (event.type !== "request") return;
        requests.push(event);
        coordinator.respond(4, { loginId: event.loginId, requestId: event.requestId, value: "" });
      },
      vi.fn(),
    );

    await expect(login).resolves.toBe(snapshot);
    expect(requests).toEqual([expect.objectContaining({ allowEmpty: true, requestType: "prompt" })]);
  });

  test("forwards info events with message and links from the login callbacks", async () => {
    const events: AuthOauthLoginEvent[] = [];
    const coordinator = new OauthLoginCoordinator({
      login: async (_providerId, interaction) => {
        interaction.notify({
          type: "info",
          message: "请完成浏览器中的验证步骤",
          links: [{ url: "https://docs.example.com/oauth" }, { url: "https://status.example.com", label: "服务状态" }],
        });
        return snapshot;
      },
    });

    await coordinator.start(
      1,
      { loginId: "info-test", providerId: "test-provider" },
      (event) => events.push(event),
      vi.fn(),
    );

    const infoEvent = events.find((e) => e.type === "info") as
      | Extract<AuthOauthLoginEvent, { type: "info" }>
      | undefined;
    expect(infoEvent).toBeDefined();
    expect(infoEvent!.message).toBe("请完成浏览器中的验证步骤");
    expect(infoEvent!.links).toHaveLength(2);
    expect(infoEvent!.links![0]!.url).toBe("https://docs.example.com/oauth");
    expect(infoEvent!.links![0]!.label).toBeUndefined();
    expect(infoEvent!.links![1]!.url).toBe("https://status.example.com");
    expect(infoEvent!.links![1]!.label).toBe("服务状态");
  });

  test("generates distinct request ids with the built-in generator when createId is not injected", async () => {
    const requests: Extract<AuthOauthLoginEvent, { type: "request" }>[] = [];
    const coordinator = new OauthLoginCoordinator({
      login: async (_providerId, interaction) => {
        expect(await interaction.prompt({ type: "text", message: "Paste code" })).toBe("prompt-value");
        expect(
          await interaction.prompt({
            type: "select",
            message: "Pick an account",
            options: [
              { id: "personal", label: "Personal" },
              { id: "work", label: "Work" },
            ],
          }),
        ).toBe("work");
        return snapshot;
      },
    });

    const result = coordinator.start(
      3,
      { loginId: "login-default-ids", providerId: "anthropic" },
      (event) => {
        if (event.type !== "request") return;
        requests.push(event);
        coordinator.respond(3, {
          loginId: event.loginId,
          requestId: event.requestId,
          value: event.requestType === "prompt" ? "prompt-value" : "work",
        });
      },
      vi.fn(),
    );

    await expect(result).resolves.toBe(snapshot);
    const requestIds = requests.map((event) => event.requestId);
    expect(requestIds).toHaveLength(2);
    expect(new Set(requestIds).size).toBe(2);
    for (const requestId of requestIds) expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("rejects responses from another renderer", async () => {
    let request: Extract<AuthOauthLoginEvent, { type: "request" }> | undefined;
    const coordinator = new OauthLoginCoordinator({
      createId: () => "request-2",
      login: async (_providerId, interaction) => {
        await interaction.prompt({ type: "text", message: "Code" });
        return snapshot;
      },
    });
    const login = coordinator.start(
      10,
      { loginId: "login-2", providerId: "anthropic" },
      (event) => {
        if (event.type === "request") request = event;
      },
      vi.fn(),
    );

    await vi.waitFor(() => expect(request).toBeDefined());
    expect(() =>
      coordinator.respond(11, { loginId: "login-2", requestId: request!.requestId, value: "wrong-owner" }),
    ).toThrow("Unknown OAuth login request");
    coordinator.cancel(10, "login-2");
    await expect(login).rejects.toThrow("Login cancelled");
  });

  test("aborts the provider flow when canceled", async () => {
    let signal: AbortSignal | undefined;
    const coordinator = new OauthLoginCoordinator({
      login: (_providerId, interaction) => {
        signal = interaction.signal;
        return new Promise((_resolve, reject) => {
          interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const login = coordinator.start(12, { loginId: "login-3", providerId: "github-copilot" }, vi.fn(), vi.fn());

    await vi.waitFor(() => expect(signal).toBeDefined());
    coordinator.cancelOwner(12);
    expect(signal?.aborted).toBe(true);
    await expect(login).rejects.toThrow("aborted");
  });
});
