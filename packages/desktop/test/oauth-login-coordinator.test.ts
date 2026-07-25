import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
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
    let callbacks: OAuthLoginCallbacks | undefined;
    const events: AuthOauthLoginEvent[] = [];
    const opened: string[] = [];
    const coordinator = new OauthLoginCoordinator({
      createId: () => "request-1",
      login: async (_providerId, nextCallbacks) => {
        callbacks = nextCallbacks;
        nextCallbacks.onAuth({ url: "https://auth.example.test", instructions: "Sign in" });
        expect(await nextCallbacks.onPrompt({ message: "Paste code" })).toBe("secret-code");
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
    expect(callbacks).toBeDefined();
    expect(opened).toEqual(["https://auth.example.test"]);
    expect(events.map((event) => event.type)).toEqual(["auth", "request"]);
  });

  test("rejects responses from another renderer", async () => {
    let request: Extract<AuthOauthLoginEvent, { type: "request" }> | undefined;
    const coordinator = new OauthLoginCoordinator({
      createId: () => "request-2",
      login: async (_providerId, callbacks) => {
        await callbacks.onPrompt({ message: "Code" });
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
      login: (_providerId, callbacks) => {
        signal = callbacks.signal;
        return new Promise((_resolve, reject) => {
          callbacks.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
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
