import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";
import type { UpdaterState } from "../src/shared/updater-contracts.ts";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  windows: [] as Array<{ isDestroyed(): boolean; webContents: { isDestroyed(): boolean; send: typeof vi.fn } }>,
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: () => undefined,
    getAllWindows: () => electron.windows,
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => electron.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

describe("updater IPC", () => {
  const state: UpdaterState = { status: "idle", currentVersion: "1.0.0" };
  const updater = {
    getState: vi.fn(() => state),
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    subscribe: vi.fn(),
  };
  const dirtyGuard = {
    requestClose: vi.fn(),
    setDirty: vi.fn(),
    remove: vi.fn(),
    confirmApplicationQuit: vi.fn(),
  };

  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    electron.send.mockReset();
    electron.windows = [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: electron.send } }];
    vi.clearAllMocks();
    registerIpc(
      { list: vi.fn(), getActive: vi.fn() } as never,
      {} as never,
      {} as never,
      { disposeProject: vi.fn(), disposeSession: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { getConfig: vi.fn(), saveConfig: vi.fn() } as never,
      dirtyGuard as never,
      { getStatus: vi.fn(), install: vi.fn(), onProgress: vi.fn() },
      updater as never,
    );
  });

  test("映射更新操作并广播状态", async () => {
    expect(electron.handles.get(CHANNELS.updaterGetState)?.({})).toBe(state);
    await electron.handles.get(CHANNELS.updaterCheck)?.({});
    await electron.handles.get(CHANNELS.updaterDownload)?.({});
    expect(updater.check).toHaveBeenCalledOnce();
    expect(updater.download).toHaveBeenCalledOnce();

    const publish = updater.subscribe.mock.calls[0]?.[0] as ((next: UpdaterState) => void) | undefined;
    publish?.({ status: "available", currentVersion: "1.0.0", availableVersion: "1.1.0" });
    expect(electron.send).toHaveBeenCalledWith(CHANNELS.updaterStateChanged, {
      status: "available",
      currentVersion: "1.0.0",
      availableVersion: "1.1.0",
    });
  });

  test("安装前复用应用退出确认", async () => {
    dirtyGuard.confirmApplicationQuit.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const install = electron.handles.get(CHANNELS.updaterInstall);

    await install?.({});
    expect(updater.install).not.toHaveBeenCalled();
    await install?.({});
    expect(updater.install).toHaveBeenCalledOnce();
  });
});
