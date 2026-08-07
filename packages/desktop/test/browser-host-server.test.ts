import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { BrowserHostServer } from "../src/main/browser/browser-host-server.ts";
import { createBrowserHostServer } from "../src/main/browser/browser-host-server.ts";
import type { BrowserManager } from "../src/main/browser/browser-manager.ts";

/** 最小 stub manager：记录调用并返回固定结果。 */
function stubManager(): { manager: unknown; calls: Array<{ method: string; params?: unknown }> } {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const manager: Record<string, unknown> = {
    tabsList: () => [
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
    ],
    activeTab: () => null,
    navigate: (tabId: number, url: string, source: string) => {
      calls.push({ method: "navigate", params: { tabId, url, source } });
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
    navigationTarget: (tabId: number, direction: "back" | "forward") => {
      calls.push({ method: "historyTarget", params: { tabId, direction } });
      return {
        ok: true,
        current: { url: "https://example.com/current", title: "Current" },
        target: { url: "https://example.com/target", title: "Target" },
      };
    },
    snapshot: (tabId: number, opts: { withScreenshot?: boolean }) => {
      calls.push({ method: "snapshot", params: { tabId, opts } });
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
    action: (tabId: number, action: unknown, source: string) => {
      calls.push({ method: "action", params: { tabId, action, source } });
      return Promise.resolve({ ok: true });
    },
    openTab: (url: string) => {
      calls.push({ method: "openTab", params: { url } });
      return Promise.resolve({ ok: false, error: "stub" });
    },
    screenshot: (tabId: number) => {
      calls.push({ method: "screenshot", params: { tabId } });
      return Promise.resolve({ ok: false, error: "stub" });
    },
    clearData: () => {
      calls.push({ method: "clearData" });
      return Promise.resolve();
    },
    browserHistory: () => {
      calls.push({ method: "history" });
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
    manager[method] = (tabId: number, source: string) => {
      calls.push({ method, params: { tabId, source } });
      return Promise.resolve({ ok: true, tab: null });
    };
  }
  return { manager, calls };
}

let server: BrowserHostServer | null = null;
let baseUrl = "";
let token = "";
let calls: Array<{ method: string; params?: unknown }> = [];

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

describe("BrowserHostServer", () => {
  test("healthz 无需 token 返回 200", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  test("缺少或错误 token 返回 401", async () => {
    const noToken = await rpc("tabsList", undefined);
    expect(noToken.status).toBe(401);

    const badToken = await rpc("tabsList", undefined, { "x-desktop-browser-token": "wrong" });
    expect(badToken.status).toBe(401);
  });

  test("正确 token 可调用白名单方法", async () => {
    const headers = { "x-desktop-browser-token": token };

    const list = await rpc("tabsList", undefined, headers);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ ok: true, data: [{ tabId: 1 }] });

    const nav = await rpc("navigate", { tabId: 1, url: "https://example.com/a" }, headers);
    expect(nav.status).toBe(200);
    expect(calls).toContainEqual({
      method: "navigate",
      params: { tabId: 1, url: "https://example.com/a", source: "agent" },
    });

    const snap = await rpc("snapshot", { tabId: 1, withScreenshot: true }, headers);
    expect(snap.status).toBe(200);
    expect(calls).toContainEqual({ method: "snapshot", params: { tabId: 1, opts: { withScreenshot: true } } });

    const action = await rpc("action", { tabId: 1, action: { type: "click", elementIndex: 3 } }, headers);
    expect(action.status).toBe(200);
    expect(calls).toContainEqual({
      method: "action",
      params: { tabId: 1, action: { type: "click", elementIndex: 3 }, source: "agent" },
    });

    const open = await rpc("openTab", { url: "https://example.com" }, headers);
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ ok: true, data: { ok: false } });

    const clear = await rpc("clearData", undefined, headers);
    expect(clear.status).toBe(200);
    expect(calls).toContainEqual({ method: "clearData" });

    const settings = await rpc("getSettings", undefined, headers);
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({
      ok: true,
      data: { revision: "rev-1", settings: { allowSites: ["example.com"] } },
    });
    expect(calls).toContainEqual({ method: "getSettingsSnapshot" });
  });

  test("history 白名单返回浏览历史", async () => {
    const headers = { "x-desktop-browser-token": token };
    const response = await rpc("history", undefined, headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: [{ url: "https://example.com/" }] });
    expect(calls).toContainEqual({ method: "history" });
  });
  test("不支持的方法返回错误", async () => {
    const headers = { "x-desktop-browser-token": token };
    const response = await rpc("destroy", undefined, headers);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ ok: false });
  });

  test("historyTarget 白名单分发并透传方向", async () => {
    const headers = { "x-desktop-browser-token": token };
    const response = await rpc("historyTarget", { tabId: 1, direction: "back" }, headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, data: { target: { url: "https://example.com/target" } } });
    expect(calls).toContainEqual({ method: "historyTarget", params: { tabId: 1, direction: "back" } });
  });

  test("goBack/goForward/reload 白名单分发", async () => {
    const headers = { "x-desktop-browser-token": token };
    for (const method of ["goBack", "goForward", "reload"] as const) {
      const response = await rpc(method, { tabId: 1 }, headers);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true });
      expect(calls).toContainEqual({ method, params: { tabId: 1, source: "agent" } });
    }
  });

  test("缺少必填参数返回错误", async () => {
    const headers = { "x-desktop-browser-token": token };
    const response = await rpc("navigate", { tabId: 1 }, headers);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ ok: false });
  });

  test("非法 JSON 返回 400", async () => {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-desktop-browser-token": token },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  test("请求体超过 1MB 返回 413", async () => {
    const oversized = JSON.stringify({ method: "tabsList", params: { big: "x".repeat(1024 * 1024 + 1024) } });
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-desktop-browser-token": token },
      body: oversized,
    });
    expect(response.status).toBe(413);
  });
});
