import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BrowserHostServer } from "../src/main/browser/browser-host-server.ts";
import { createBrowserHostServer } from "../src/main/browser/browser-host-server.ts";
import type { BrowserManager } from "../src/main/browser/browser-manager.ts";

const SESSION_A = { projectId: "proj-a", threadId: "thread-a" };
const SESSION_B = { projectId: "proj-a", threadId: "thread-b" };
const SESSION_TOKEN_A = "session-token-a";
const SESSION_TOKEN_B = "session-token-b";

/** 最小 stub manager：记录调用并返回固定结果；仅 SESSION_A 已注册。 */
function stubManager(): {
  manager: unknown;
  calls: Array<{ method: string; params?: unknown }>;
} {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const manager: Record<string, unknown> = {
    resolveSessionCapability: (token: string) => {
      if (token === SESSION_TOKEN_A) return SESSION_A;
      if (token === SESSION_TOKEN_B) return SESSION_B;
      return null;
    },
    isKnownSession: (identity: { projectId: string; threadId: string }) =>
      identity.projectId === SESSION_A.projectId && identity.threadId === SESSION_A.threadId,
    tabsList: (identity: unknown) => {
      calls.push({ method: "tabsList", params: { identity } });
      return [
        {
          tabId: 1,
          url: "https://example.com",
          title: "Example",
          loading: false,
          crashed: false,
          canGoBack: false,
          canGoForward: false,
          createdAt: 0,
        },
      ];
    },
    activeTab: (identity: unknown) => {
      calls.push({ method: "activeTab", params: { identity } });
      return null;
    },
    navigate: (identity: unknown, tabId: number, url: string, source: string) => {
      calls.push({ method: "navigate", params: { identity, tabId, url, source } });
      return Promise.resolve({
        ok: true,
        tab: {
          tabId,
          url,
          title: "",
          loading: false,
          crashed: false,
          canGoBack: false,
          canGoForward: false,
          createdAt: 0,
        },
      });
    },
    navigationTarget: (identity: unknown, tabId: number, direction: "back" | "forward") => {
      calls.push({ method: "historyTarget", params: { identity, tabId, direction } });
      return {
        ok: true,
        current: { url: "https://example.com/current", title: "Current" },
        target: { url: "https://example.com/target", title: "Target" },
      };
    },
    snapshot: (identity: unknown, tabId: number, opts: { withScreenshot?: boolean }) => {
      calls.push({ method: "snapshot", params: { identity, tabId, opts } });
      return Promise.resolve({
        ok: true,
        snapshot: {
          url: "about:blank",
          title: "",
          timestamp: 0,
          viewport: { width: 800, height: 600, dpr: 1 },
          tree: [],
          screenshot: null,
        },
      });
    },
    action: (identity: unknown, tabId: number, action: unknown, source: string) => {
      calls.push({ method: "action", params: { identity, tabId, action, source } });
      return Promise.resolve({ ok: true });
    },
    openTab: (identity: unknown, url: string, source: string, signal: AbortSignal | undefined) => {
      if (!hangOpenTab) {
        calls.push({ method: "openTab", params: { identity, url, source, aborted: signal?.aborted ?? false } });
        return Promise.resolve({ ok: false, error: "stub" });
      }
      // 挂起直到 abort（模拟 openTab 等待 renderer attach / 用户确认的长时间等待）。
      return new Promise((resolve) => {
        const record = (): void => {
          calls.push({ method: "openTab", params: { identity, url, source, aborted: signal?.aborted ?? false } });
        };
        if (!signal) {
          record();
          resolve({ ok: false, error: "stub" });
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            record();
            resolve({ ok: false, error: "已取消" });
          },
          { once: true },
        );
      });
    },
    screenshot: (identity: unknown, tabId: number) => {
      calls.push({ method: "screenshot", params: { identity, tabId } });
      return Promise.resolve({ ok: false, error: "stub" });
    },
    clearSessionData: (identity: unknown) => {
      calls.push({ method: "clearSessionData", params: { identity } });
      return Promise.resolve();
    },
    browserHistory: (identity: unknown) => {
      calls.push({ method: "history", params: { identity } });
      return [{ url: "https://example.com/", title: "Example", timestamp: 1 }];
    },
    getSettingsSnapshot: () => {
      calls.push({ method: "getSettingsSnapshot" });
      return Promise.resolve({
        path: "/tmp/browser-settings.json",
        exists: true,
        revision: "rev-1",
        settings: {
          allowSites: ["example.com"],
          blockSites: [],
          downloadDirectory: null,
          maxSnapshotNodes: 200,
          cdpTimeoutMs: 10_000,
          restoreTabsOnLaunch: true,
        },
      });
    },
  };
  for (const method of ["goBack", "goForward", "reload"] as const) {
    manager[method] = (identity: unknown, tabId: number, source: string) => {
      calls.push({ method, params: { identity, tabId, source } });
      return Promise.resolve({ ok: true, tab: null });
    };
  }
  return { manager, calls };
}

let server: BrowserHostServer | null = null;
let baseUrl = "";
let token = "";
let calls: Array<{ method: string; params?: unknown }> = [];
/** openTab 是否挂起等待 abort（abort 传播测试用）。 */
let hangOpenTab = false;

const sessionHeaders = {
  "x-desktop-browser-session-token": SESSION_TOKEN_A,
  "x-desktop-browser-session-project-id": SESSION_A.projectId,
  "x-desktop-browser-session-thread-id": SESSION_A.threadId,
};

beforeEach(async () => {
  const stub = stubManager();
  calls = stub.calls;
  server = await createBrowserHostServer(stub.manager as unknown as BrowserManager, {});
  const endpoint = server.getEndpoint();
  if (!endpoint) throw new Error("endpoint 不可用");
  token = endpoint.token;
  baseUrl = `http://127.0.0.1:${endpoint.port}`;
});

afterEach(async () => {
  await server?.dispose();
  server = null;
});

async function rpc(
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ method, params }),
  });
  const body = (await response.json()) as unknown;
  return { status: response.status, body };
}

const authHeaders = (): Record<string, string> => ({ "x-desktop-browser-token": token });

describe("BrowserHostServer", () => {
  test("healthz 无需 token 返回 200", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  test("缺少或错误 token 返回 401", async () => {
    const noToken = await rpc("tabsList", undefined, sessionHeaders);
    expect(noToken.status).toBe(401);

    const badToken = await rpc("tabsList", undefined, { ...sessionHeaders, "x-desktop-browser-token": "wrong" });
    expect(badToken.status).toBe(401);
  });

  test("缺少会话身份头返回 403（fail-closed）", async () => {
    const headers = authHeaders();
    const missing = await rpc("tabsList", undefined, headers);
    expect(missing.status).toBe(403);
    expect(missing.body).toMatchObject({ ok: false, error: expect.stringContaining("会话身份") });

    const partial = await rpc("tabsList", undefined, {
      ...headers,
      "x-desktop-browser-session-project-id": SESSION_A.projectId,
    });
    expect(partial.status).toBe(403);
  });

  test("未注册会话身份返回 403（fail-closed）", async () => {
    const headers = {
      ...authHeaders(),
      "x-desktop-browser-session-token": SESSION_TOKEN_B,
      "x-desktop-browser-session-project-id": SESSION_B.projectId,
      "x-desktop-browser-session-thread-id": SESSION_B.threadId,
    };
    const response = await rpc("tabsList", undefined, headers);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ ok: false, error: "未知的浏览器会话身份" });
    expect(calls).toHaveLength(0);
  });

  test("会话 header 不能覆盖 capability 绑定的 identity", async () => {
    const headers = {
      ...authHeaders(),
      "x-desktop-browser-session-token": SESSION_TOKEN_A,
      "x-desktop-browser-session-project-id": SESSION_B.projectId,
      "x-desktop-browser-session-thread-id": SESSION_B.threadId,
    };
    const response = await rpc("tabsList", undefined, headers);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ ok: false, error: "浏览器会话 capability 无效" });
    expect(calls).toHaveLength(0);
  });

  test("正确 token + 身份可调用白名单方法，identity 透传到 manager", async () => {
    const headers = { ...authHeaders(), ...sessionHeaders };

    const list = await rpc("tabsList", undefined, headers);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ ok: true, data: [{ tabId: 1 }] });
    expect(calls).toContainEqual({ method: "tabsList", params: { identity: SESSION_A } });

    const nav = await rpc("navigate", { tabId: 1, url: "https://example.com/a" }, headers);
    expect(nav.status).toBe(200);
    expect(calls).toContainEqual({
      method: "navigate",
      params: { identity: SESSION_A, tabId: 1, url: "https://example.com/a", source: "agent" },
    });

    const snap = await rpc("snapshot", { tabId: 1, withScreenshot: true }, headers);
    expect(snap.status).toBe(200);
    expect(calls).toContainEqual({
      method: "snapshot",
      params: { identity: SESSION_A, tabId: 1, opts: { withScreenshot: true } },
    });

    const action = await rpc("action", { tabId: 1, action: { type: "click", elementIndex: 3 } }, headers);
    expect(action.status).toBe(200);
    expect(calls).toContainEqual({
      method: "action",
      params: { identity: SESSION_A, tabId: 1, action: { type: "click", elementIndex: 3 }, source: "agent" },
    });

    const open = await rpc("openTab", { url: "https://example.com" }, headers);
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ ok: true, data: { ok: false } });
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "openTab",
        params: expect.objectContaining({ identity: SESSION_A, url: "https://example.com", source: "agent" }),
      }),
    );

    const clear = await rpc("clearData", undefined, headers);
    expect(clear.status).toBe(200);
    expect(calls).toContainEqual({ method: "clearSessionData", params: { identity: SESSION_A } });

    const settings = await rpc("getSettings", undefined, headers);
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({
      ok: true,
      data: { revision: "rev-1", settings: { allowSites: ["example.com"] } },
    });
    expect(calls).toContainEqual({ method: "getSettingsSnapshot" });
  });

  test("history 白名单返回浏览历史（按会话）", async () => {
    const headers = { ...authHeaders(), ...sessionHeaders };
    const response = await rpc("history", undefined, headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: [{ url: "https://example.com/" }] });
    expect(calls).toContainEqual({ method: "history", params: { identity: SESSION_A } });
  });

  test("不支持的方法返回错误", async () => {
    const headers = { ...authHeaders(), ...sessionHeaders };
    const response = await rpc("destroy", undefined, headers);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ ok: false });
  });

  test("historyTarget 白名单分发并透传方向", async () => {
    const headers = { ...authHeaders(), ...sessionHeaders };
    const response = await rpc("historyTarget", { tabId: 1, direction: "back" }, headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { target: { url: "https://example.com/target" } } });
    expect(calls).toContainEqual({
      method: "historyTarget",
      params: { identity: SESSION_A, tabId: 1, direction: "back" },
    });
  });

  test("goBack/goForward/reload 白名单分发", async () => {
    const headers = { ...authHeaders(), ...sessionHeaders };
    for (const method of ["goBack", "goForward", "reload"] as const) {
      const response = await rpc(method, { tabId: 1 }, headers);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true });
      expect(calls).toContainEqual({ method, params: { identity: SESSION_A, tabId: 1, source: "agent" } });
    }
  });

  test("缺少必填参数返回错误", async () => {
    const headers = { ...authHeaders(), ...sessionHeaders };
    const response = await rpc("navigate", { tabId: 1 }, headers);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ ok: false });
  });

  test("非法 JSON 返回 400", async () => {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(), ...sessionHeaders },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  test("请求体超过 1MB 返回 413", async () => {
    const oversized = JSON.stringify({ method: "tabsList", params: { big: "x".repeat(1024 * 1024 + 1024) } });
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(), ...sessionHeaders },
      body: oversized,
    });
    expect(response.status).toBe(413);
  });

  test("openTab 客户端断开（abort）时取消等待", async () => {
    hangOpenTab = true;
    try {
      const headers = { ...authHeaders(), ...sessionHeaders };
      const controller = new AbortController();
      const pending = fetch(`${baseUrl}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ method: "openTab", params: { url: "https://example.com" } }),
        signal: controller.signal,
      });
      // 让请求到达服务端并进入挂起后断开。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(calls.some((call) => call.method === "openTab")).toBe(false);
      controller.abort();
      await expect(pending).rejects.toThrow();
      // 服务端收到断开后取消 openTab：manager 记录 aborted=true。
      await vi.waitFor(() => {
        const openTabCall = calls.find((call) => call.method === "openTab");
        expect(openTabCall).toBeDefined();
        expect((openTabCall!.params as { aborted: boolean }).aborted).toBe(true);
      });
    } finally {
      hangOpenTab = false;
    }
  });

  test("openTab 正常请求不携带已中止信号", async () => {
    const headers = { ...authHeaders(), ...sessionHeaders };
    const response = await rpc("openTab", { url: "https://example.com" }, headers);
    expect(response.status).toBe(200);
    const openTabCall = calls.find((call) => call.method === "openTab");
    expect((openTabCall!.params as { aborted: boolean }).aborted).toBe(false);
  });
});
