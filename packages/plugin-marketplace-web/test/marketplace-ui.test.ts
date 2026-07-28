import { MutationObserver, onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceApiError } from "../src/api.ts";
import { authLogoutMutationOptions, clearClientSession } from "../src/api-hooks.ts";
import { authErrorMessage, SESSION_KEY, type SessionState } from "../src/lib/marketplace-ui.ts";

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  onlineManager.setOnline(true);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

describe("marketplace UI errors", () => {
  it("localizes the server username conflict code", () => {
    expect(authErrorMessage(new MarketplaceApiError("Username is already taken", 409, "USERNAME_TAKEN"))).toBe(
      "该用户名已被使用。",
    );
  });
});

describe("marketplace client session", () => {
  it("clears the matching local and cached session synchronously", () => {
    const queryClient = new QueryClient();
    const session: SessionState = { token: "old-token", expiresAt: Date.now() + 60_000 };
    storage.set(SESSION_KEY, JSON.stringify(session));
    queryClient.setQueryData(["session"], session);
    queryClient.setQueryData(["managedPlugins", session.token], { plugins: [] });

    expect(clearClientSession(queryClient, session.token)).toBe(true);
    expect(storage.has(SESSION_KEY)).toBe(false);
    expect(queryClient.getQueryData(["session"])).toBeNull();
    expect(queryClient.getQueryData(["managedPlugins", session.token])).toBeUndefined();
  });

  it("clears locally even when the logout request starts offline", async () => {
    const queryClient = new QueryClient();
    const session: SessionState = { token: "offline-token", expiresAt: Date.now() + 60_000 };
    storage.set(SESSION_KEY, JSON.stringify(session));
    queryClient.setQueryData(["session"], session);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("offline"))),
    );
    onlineManager.setOnline(false);
    const observer = new MutationObserver(queryClient, authLogoutMutationOptions(queryClient));

    await expect(observer.mutate(session.token)).rejects.toThrow("offline");
    expect(storage.has(SESSION_KEY)).toBe(false);
    expect(queryClient.getQueryData(["session"])).toBeNull();
  });

  it("does not let a stale request clear a newer session", () => {
    const queryClient = new QueryClient();
    const session: SessionState = { token: "new-token", expiresAt: Date.now() + 60_000 };
    storage.set(SESSION_KEY, JSON.stringify(session));
    queryClient.setQueryData(["session"], session);

    expect(clearClientSession(queryClient, "old-token")).toBe(false);
    expect(storage.get(SESSION_KEY)).toBe(JSON.stringify(session));
    expect(queryClient.getQueryData(["session"])).toEqual(session);
  });
});
