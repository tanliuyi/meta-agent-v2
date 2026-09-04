import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserServices } from "../src/main/bootstrap/browser-services.ts";
import { createBrowserHostServer } from "../src/main/browser/browser-host-server.ts";
import { BrowserManager } from "../src/main/browser/browser-manager.ts";

const mocks = vi.hoisted(() => ({
  manager: { dispose: vi.fn() },
  host: { getEndpoint: vi.fn(), dispose: vi.fn() },
  createHost: vi.fn(),
  handleInternal: vi.fn(),
}));

vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: vi.fn(), encryptString: vi.fn(), decryptString: vi.fn() },
}));
vi.mock("../src/main/browser/browser-data-service.ts", () => ({ BrowserDataService: vi.fn() }));
vi.mock("../src/main/browser/browser-manager.ts", () => ({
  BrowserManager: vi.fn(function BrowserManager() {
    return mocks.manager;
  }),
}));
vi.mock("../src/main/browser/browser-host-server.ts", () => ({ createBrowserHostServer: mocks.createHost }));
vi.mock("../src/main/browser/browser-internal-page-protocol.ts", () => ({
  handleBrowserInternalPageRequests: mocks.handleInternal,
}));

function options() {
  return {
    context: {
      appDir: "C:/app/out/main",
      userDataDir: "C:/data",
      sidecarLog: { write: vi.fn() },
    },
    capability: { bind: vi.fn(), unbind: vi.fn() },
    publishState: vi.fn(),
    publishCreateTab: vi.fn(),
    publishCloseTab: vi.fn(),
    publishPasswordOffer: vi.fn(),
  } as never;
}

describe("createBrowserServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PI_BROWSER_HOST_PORT;
    delete process.env.PI_BROWSER_TOKEN;
    mocks.createHost.mockResolvedValue(mocks.host);
    mocks.host.getEndpoint.mockReturnValue({ port: 3210, token: "secret" });
    mocks.host.dispose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.PI_BROWSER_HOST_PORT;
    delete process.env.PI_BROWSER_TOKEN;
  });

  it("constructs and binds the browser graph", async () => {
    const input = options();
    const services = await createBrowserServices(input);

    expect(BrowserManager).toHaveBeenCalledOnce();
    expect(input.capability.bind).toHaveBeenCalledWith(mocks.manager);
    expect(createBrowserHostServer).toHaveBeenCalledWith(mocks.manager, expect.any(Object));
    expect(services.manager).toBe(mocks.manager);
    expect(process.env.PI_BROWSER_HOST_PORT).toBe("3210");
  });

  it("cleans the manager when host startup fails", async () => {
    mocks.createHost.mockRejectedValueOnce(new Error("listen failed"));

    await expect(createBrowserServices(options())).rejects.toThrow("listen failed");

    expect(mocks.manager.dispose).toHaveBeenCalledOnce();
  });

  it("supports a host without an endpoint and disposes once", async () => {
    mocks.host.getEndpoint.mockReturnValueOnce(undefined);
    const services = await createBrowserServices(options());

    await Promise.all([services.dispose(), services.dispose()]);

    expect(process.env.PI_BROWSER_HOST_PORT).toBeUndefined();
    expect(mocks.host.dispose).toHaveBeenCalledOnce();
    expect(mocks.manager.dispose).toHaveBeenCalledOnce();
  });

  it("still disposes the manager when host shutdown fails", async () => {
    mocks.host.dispose.mockRejectedValueOnce(new Error("host stop failed"));
    const services = await createBrowserServices(options());

    await expect(services.dispose()).rejects.toThrow("Failed to dispose browser services");

    expect(mocks.manager.dispose).toHaveBeenCalledOnce();
  });
});
