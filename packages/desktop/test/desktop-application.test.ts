import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopApplication } from "../src/main/bootstrap/application.ts";

const electron = vi.hoisted(() => ({
  windows: [] as unknown[],
  setApplicationMenu: vi.fn(),
  showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
  dialog: { showMessageBox: electron.showMessageBox },
  Menu: { setApplicationMenu: electron.setApplicationMenu, buildFromTemplate: vi.fn() },
  Tray: vi.fn(),
  nativeImage: { createFromPath: vi.fn() },
  protocol: { handle: vi.fn(), isProtocolHandled: vi.fn(() => false), registerSchemesAsPrivileged: vi.fn() },
  session: { defaultSession: {} },
  safeStorage: { isEncryptionAvailable: vi.fn(), encryptString: vi.fn(), decryptString: vi.fn() },
  webContents: { fromId: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const calls: string[] = [];
  const app = {
    isPackaged: false,
    getPath: vi.fn(() => "C:/user-data"),
    getVersion: vi.fn(() => "1.0.0"),
    quit: vi.fn(),
  };
  const context = { sidecarLog: { dispose: vi.fn(() => calls.push("log")) } };
  const core = { projects: {} };
  const plugins = { marketplaceGarbageCollector: {} };
  const sessions = { dispose: vi.fn(async () => calls.push("session")), sessions: {} };
  const workspace = { dispose: vi.fn(() => calls.push("workspace")) };
  const browser = { dispose: vi.fn(async () => calls.push("browser")) };
  const registration = { dispose: vi.fn(() => calls.push("ipc")) };
  const window = { isDestroyed: vi.fn(() => false), destroy: vi.fn(() => calls.push("window")) };
  const createWindow = vi.fn(() => window as never);
  const factories = {
    createRuntimeContext: vi.fn(() => context),
    createCoreServices: vi.fn(async () => core),
    createPluginServices: vi.fn(async () => plugins),
    createSessionServices: vi.fn(() => sessions),
    createWorkspaceServices: vi.fn(() => workspace),
    createBrowserServices: vi.fn(async () => browser),
    registerIpc: vi.fn(() => registration),
    createUpdater: vi.fn(() => ({})),
    scheduleUpdates: vi.fn(() => () => calls.push("updates")),
    scheduleMarketplaceGc: vi.fn(() => () => calls.push("gc")),
  };
  const application = new DesktopApplication({
    app: app as never,
    appDir: "C:/app/out/main",
    resourcesPath: "C:/app/resources",
    installDevTools: vi.fn(async () => undefined),
    createWindow,
    factories: factories as never,
  });
  return { application, app, browser, calls, core, createWindow, factories, plugins, sessions, window, workspace };
}

describe("DesktopApplication", () => {
  beforeEach(() => {
    electron.windows = [];
    vi.clearAllMocks();
  });

  it("starts core, plugin and DevTools preparation concurrently", async () => {
    const harness = createHarness();
    const core = deferred<unknown>();
    const plugins = deferred<unknown>();
    const devTools = deferred<void>();
    harness.factories.createCoreServices.mockReturnValue(core.promise);
    harness.factories.createPluginServices.mockReturnValue(plugins.promise);
    const application = new DesktopApplication({
      app: harness.app as never,
      appDir: "C:/app/out/main",
      resourcesPath: "C:/app/resources",
      installDevTools: vi.fn(() => devTools.promise),
      createWindow: harness.createWindow,
      factories: harness.factories as never,
    });

    const startup = application.start();
    await Promise.resolve();

    expect(harness.factories.createCoreServices).toHaveBeenCalledOnce();
    expect(harness.factories.createPluginServices).toHaveBeenCalledOnce();
    core.resolve(harness.core);
    plugins.resolve(harness.plugins);
    devTools.resolve();
    await startup;
  });

  it("registers IPC and creates the window only once", async () => {
    const { application, createWindow, factories } = createHarness();

    await Promise.all([application.start(), application.start()]);

    expect(factories.registerIpc).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("rolls back partial initialization and never creates a window", async () => {
    const { application, calls, createWindow, factories } = createHarness();
    factories.createBrowserServices.mockRejectedValueOnce(new Error("browser failed"));

    await expect(application.start()).rejects.toThrow("browser failed");

    expect(createWindow).not.toHaveBeenCalled();
    expect(calls).toEqual(["workspace", "session", "log"]);
  });

  it("stops cleanly when disposal begins during initialization", async () => {
    const harness = createHarness();
    const core = deferred<unknown>();
    harness.factories.createCoreServices.mockReturnValueOnce(core.promise);

    const initialization = harness.application.initialize();
    await Promise.resolve();
    const disposal = harness.application.dispose();
    core.resolve(harness.core);

    await expect(initialization).rejects.toThrow("initialization was stopped");
    await expect(disposal).resolves.toBeUndefined();
    expect(harness.factories.createSessionServices).not.toHaveBeenCalled();
    expect(harness.calls).toEqual(["log"]);
  });

  it("rolls back all initialized services when IPC registration fails", async () => {
    const { application, calls, createWindow, factories } = createHarness();
    factories.registerIpc.mockImplementationOnce(() => {
      throw new Error("IPC failed");
    });

    await expect(application.start()).rejects.toThrow("IPC failed");
    await application.dispose();

    expect(createWindow).not.toHaveBeenCalled();
    expect(calls).toEqual(["browser", "workspace", "session", "log"]);
  });

  it("prevents the first dirty quit and continues after confirmation", async () => {
    const { application, app } = createHarness();
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { id: 42 },
    };
    electron.windows = [window];
    electron.showMessageBox.mockResolvedValueOnce({ response: 1 });
    application.dirtyGuard.setDirty(42, true);
    const event = { preventDefault: vi.fn() };

    application.requestQuit(event as never);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not schedule duplicate quits while disposal is running", async () => {
    const harness = createHarness();
    const sessionDisposal = deferred<void>();
    harness.sessions.dispose.mockImplementationOnce(() => sessionDisposal.promise);
    await harness.application.start();
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    harness.application.requestQuit(first as never);
    harness.application.requestQuit(second as never);
    sessionDisposal.resolve();
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
  });

  it("logs shutdown failures and still quits", async () => {
    const harness = createHarness();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    harness.browser.dispose.mockRejectedValueOnce(new Error("browser stop failed"));
    await harness.application.start();

    harness.application.requestQuit({ preventDefault: vi.fn() } as never);
    await vi.waitFor(() => expect(harness.app.quit).toHaveBeenCalledOnce());

    expect(consoleError).toHaveBeenCalledWith("Desktop shutdown failed:", expect.any(AggregateError));
    consoleError.mockRestore();
  });

  it("disposes shutdown phases once even when called repeatedly", async () => {
    const { application, calls } = createHarness();
    await application.start();

    await Promise.all([application.dispose(), application.dispose()]);

    expect(calls).toEqual(["ipc", "window", "updates", "gc", "browser", "workspace", "session", "log"]);
  });
});
