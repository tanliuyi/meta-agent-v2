import { beforeEach, describe, expect, test, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handler: undefined as ((request: Request) => Response | Promise<Response>) | undefined,
  fetch: vi.fn(async () => new Response("ok")),
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn((_scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
    electron.handler = handler;
  }),
}));

vi.mock("electron", () => ({
  net: { fetch: electron.fetch },
  protocol: {
    handle: electron.handle,
    registerSchemesAsPrivileged: electron.registerSchemesAsPrivileged,
  },
}));

import {
  handleBrowserInternalPageRequests,
  registerBrowserInternalScheme,
} from "../src/main/browser/browser-internal-page-protocol.ts";

describe("browser internal page protocol", () => {
  beforeEach(() => {
    electron.fetch.mockClear();
    electron.registerSchemesAsPrivileged.mockClear();
    electron.handle.mockClear();
    electron.handler = undefined;
  });

  test("显式注册安全标准 scheme", () => {
    registerBrowserInternalScheme();

    expect(electron.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: "browser",
        privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
      },
    ]);
  });

  test("可向浏览器 partition session 安装相同 handler", () => {
    const sessionHandle = vi.fn();

    handleBrowserInternalPageRequests("C:/app/renderer", undefined, {
      protocol: { handle: sessionHandle },
    } as never);

    expect(sessionHandle).toHaveBeenCalledWith("browser", expect.any(Function));
    expect(electron.handle).not.toHaveBeenCalled();
  });

  test("开发资源固定代理到 renderer origin", async () => {
    handleBrowserInternalPageRequests("C:/app/renderer", "http://localhost:5173/");

    await electron.handler?.(new Request("browser://history/%2F%2Fevil.example/x?raw=1"));

    expect(electron.fetch).toHaveBeenCalledWith("http://localhost:5173/evil.example/x?raw=1");
  });

  test("拒绝未知页面和畸形编码路径", async () => {
    handleBrowserInternalPageRequests("C:/app/renderer", "http://localhost:5173/");

    const unknown = await electron.handler?.(new Request("browser://unknown/"));
    const malformed = await electron.handler?.(new Request("browser://history/%"));

    expect(unknown?.status).toBe(404);
    expect(malformed?.status).toBe(404);
    expect(electron.fetch).not.toHaveBeenCalled();
  });

  test("生产环境只加载入口和 assets", async () => {
    handleBrowserInternalPageRequests("C:/app/renderer");

    await electron.handler?.(new Request("browser://history/assets/app.js"));
    const denied = await electron.handler?.(new Request("browser://history/src/main.tsx"));

    expect(electron.fetch).toHaveBeenCalledOnce();
    expect(String(electron.fetch.mock.calls[0]?.[0])).toContain("/renderer/assets/app.js");
    expect(denied?.status).toBe(404);
  });
});
