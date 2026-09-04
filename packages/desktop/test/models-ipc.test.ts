import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";
import { createIpcTestDependencies } from "./ipc-test-dependencies.ts";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  openPath: vi.fn(),
  owner: { close: vi.fn() },
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: () => electron.owner,
    getAllWindows: () => [],
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => electron.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  shell: { openExternal: vi.fn(), openPath: electron.openPath },
}));

describe("models IPC", () => {
  const refreshActiveModelRuntimes = vi.fn(async () => undefined);
  const models = {
    getConfig: vi.fn(),
    getConfigRevision: vi.fn(),
    saveConfig: vi.fn(),
    getExternalOpenTarget: vi.fn(),
  };
  const providers = {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    getExternalOpenTarget: vi.fn(),
  };
  const dirtyGuard = {
    requestClose: vi.fn(),
    setDirty: vi.fn(),
    remove: vi.fn(),
  };

  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    electron.openPath.mockReset().mockResolvedValue("");
    vi.clearAllMocks();
    registerIpc(
      createIpcTestDependencies({
        projects: {
          list: vi.fn(),
          getActive: vi.fn(),
        } as never,
        models: models as never,
        providers: providers as never,
        dirtyGuard: dirtyGuard as never,
        runtime: {
          refreshActiveModelRuntimes,
        },
      }),
    );
  });

  test("maps fixed-path model service handlers", async () => {
    const snapshot = { revision: "one", activeSessionsRefreshed: false };
    models.getConfig.mockResolvedValue(snapshot);
    models.getConfigRevision.mockResolvedValue("one");
    models.saveConfig.mockResolvedValue({ status: "saved", snapshot });
    models.getExternalOpenTarget.mockResolvedValue("/agent/models.json");
    const event = { sender: { id: 1 } };
    const input = { expectedRevision: "one", providers: [] };

    await expect(electron.handles.get(CHANNELS.modelsGetConfig)?.(event)).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.modelsGetConfigRevision)?.(event)).resolves.toBe("one");
    await expect(electron.handles.get(CHANNELS.modelsSaveConfig)?.(event, input)).resolves.toEqual({
      status: "saved",
      snapshot: { ...snapshot, activeSessionsRefreshed: true },
    });
    await electron.handles.get(CHANNELS.modelsOpenConfigExternally)?.(event);

    expect(models.saveConfig).toHaveBeenCalledWith(input);
    expect(refreshActiveModelRuntimes).toHaveBeenCalledOnce();
    expect(models.getExternalOpenTarget).toHaveBeenCalledWith();
    expect(electron.openPath).toHaveBeenCalledWith("/agent/models.json");
  });

  test("awaits active-runtime refresh after a unified providers save", async () => {
    const snapshot = { modelsRevision: "m1", authRevision: "a1" };
    providers.saveConfig.mockResolvedValue({ status: "saved", snapshot });

    await expect(
      electron.handles.get(CHANNELS.providersSaveConfig)?.(
        {},
        {
          expectedModelsRevision: "m0",
          expectedAuthRevision: "a0",
          modelsProviders: [],
          authProviders: [],
        },
      ),
    ).resolves.toEqual({ status: "saved", snapshot });
    expect(refreshActiveModelRuntimes).toHaveBeenCalledOnce();
  });

  test("keeps a committed save successful when an active-runtime refresh fails", async () => {
    const snapshot = { revision: "two", activeSessionsRefreshed: false };
    models.saveConfig.mockResolvedValue({ status: "saved", snapshot });
    refreshActiveModelRuntimes.mockRejectedValueOnce(new Error("worker refresh failed"));

    await expect(
      electron.handles.get(CHANNELS.modelsSaveConfig)?.({}, { expectedRevision: "one", providers: [] }),
    ).resolves.toEqual({ status: "saved", snapshot });
    expect(models.saveConfig).toHaveBeenCalledOnce();
  });

  test("sets dirty synchronously and clears sender state on destruction", () => {
    let destroyed: (() => void) | undefined;
    const event = {
      sender: {
        id: 42,
        once: (_name: string, listener: () => void) => {
          destroyed = listener;
        },
      },
      returnValue: undefined as unknown,
    };
    electron.listeners.get(CHANNELS.modelsSetEditorDirty)?.(event, true);
    expect(event.returnValue).toBe(true);
    expect(dirtyGuard.setDirty).toHaveBeenCalledWith(42, true);
    destroyed?.();
    expect(dirtyGuard.remove).toHaveBeenCalledWith(42);
  });

  test("rejects invalid dirty payloads without hanging sendSync", () => {
    const event = { sender: { id: 7 }, returnValue: undefined as unknown };
    electron.listeners.get(CHANNELS.modelsSetEditorDirty)?.(event, "true");
    expect(event.returnValue).toBe(false);
    expect(dirtyGuard.setDirty).not.toHaveBeenCalled();
  });
});
