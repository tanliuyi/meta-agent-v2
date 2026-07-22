import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: () => undefined,
    getAllWindows: () => [],
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => electron.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

describe("settings IPC", () => {
  const settings = {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
  };

  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    vi.clearAllMocks();
    registerIpc(
      { list: vi.fn(), getActive: vi.fn() } as never,
      {} as never,
      {} as never,
      { disposeProject: vi.fn(), disposeSession: vi.fn() } as never,
      {} as never,
      {} as never,
      settings as never,
      { requestClose: vi.fn(), setDirty: vi.fn(), remove: vi.fn() } as never,
      { getStatus: vi.fn(), install: vi.fn(), onProgress: vi.fn() },
    );
  });

  test("映射 settings 配置读写处理器", async () => {
    const snapshot = { revision: "one", settings: { showThinking: true } };
    const input = { expectedRevision: "one", settings: { showThinking: false } };
    settings.getConfig.mockResolvedValue(snapshot);
    settings.saveConfig.mockResolvedValue({ status: "saved", snapshot });

    await expect(electron.handles.get(CHANNELS.settingsGetConfig)?.({})).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.settingsSaveConfig)?.({}, input)).resolves.toEqual({
      status: "saved",
      snapshot,
    });
    expect(settings.saveConfig).toHaveBeenCalledWith(input);
  });
});
