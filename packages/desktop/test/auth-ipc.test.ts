import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";

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

describe("auth IPC", () => {
  const auth = {
    getConfig: vi.fn(),
    getConfigRevision: vi.fn(),
    saveConfig: vi.fn(),
    getExternalOpenTarget: vi.fn(),
  };
  const models = {
    getConfig: vi.fn(),
    getConfigRevision: vi.fn(),
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
      {
        list: vi.fn(),
        getActive: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      { disposeProject: vi.fn(), disposeSession: vi.fn() } as never,
      models as never,
      auth as never,
      {} as never,
      dirtyGuard as never,
      { getStatus: vi.fn(), install: vi.fn(), onProgress: vi.fn() },
    );
  });

  test("maps fixed-path auth service handlers", async () => {
    const snapshot = { revision: "one", providers: [], knownProviders: [] };
    auth.getConfig.mockResolvedValue(snapshot);
    auth.getConfigRevision.mockResolvedValue("one");
    auth.saveConfig.mockResolvedValue({ status: "saved", snapshot });
    auth.getExternalOpenTarget.mockResolvedValue("/agent/auth.json");
    const event = { sender: { id: 1 } };
    const input = { expectedRevision: "one", providers: [] };

    await expect(electron.handles.get(CHANNELS.authGetConfig)?.(event)).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.authGetConfigRevision)?.(event)).resolves.toBe("one");
    await expect(electron.handles.get(CHANNELS.authSaveConfig)?.(event, input)).resolves.toEqual({
      status: "saved",
      snapshot,
    });
    await electron.handles.get(CHANNELS.authOpenConfigExternally)?.(event);

    expect(auth.saveConfig).toHaveBeenCalledWith(input);
    expect(auth.getExternalOpenTarget).toHaveBeenCalledWith();
    expect(electron.openPath).toHaveBeenCalledWith("/agent/auth.json");
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
    electron.listeners.get(CHANNELS.authSetEditorDirty)?.(event, true);
    expect(event.returnValue).toBe(true);
    expect(dirtyGuard.setDirty).toHaveBeenCalledWith(42, true);
    destroyed?.();
    expect(dirtyGuard.remove).toHaveBeenCalledWith(42);
  });

  test("rejects invalid dirty payloads without hanging sendSync", () => {
    const event = { sender: { id: 7 }, returnValue: undefined as unknown };
    electron.listeners.get(CHANNELS.authSetEditorDirty)?.(event, "true");
    expect(event.returnValue).toBe(false);
    expect(dirtyGuard.setDirty).not.toHaveBeenCalled();
  });

  test("result union round-trips saved status", async () => {
    const snapshot = { revision: "two", providers: [], knownProviders: [] };
    auth.saveConfig.mockResolvedValue({ status: "saved", snapshot });
    const event = { sender: { id: 1 } };
    const input = { expectedRevision: "one", providers: [] };
    const result = await electron.handles.get(CHANNELS.authSaveConfig)?.(event, input);
    expect(result).toEqual({ status: "saved", snapshot });
  });

  test("result union round-trips conflict status", async () => {
    const current = { revision: "two", providers: [], knownProviders: [] };
    auth.saveConfig.mockResolvedValue({ status: "conflict", current });
    const event = { sender: { id: 1 } };
    const input = { expectedRevision: "one", providers: [] };
    const result = await electron.handles.get(CHANNELS.authSaveConfig)?.(event, input);
    expect(result).toEqual({ status: "conflict", current });
  });

  test("thrown I/O error preserves message", async () => {
    auth.getConfig.mockRejectedValue(new Error("ENOENT: auth.json not found"));
    const event = { sender: { id: 1 } };
    await expect(electron.handles.get(CHANNELS.authGetConfig)?.(event)).rejects.toThrow("ENOENT: auth.json not found");
  });
});
