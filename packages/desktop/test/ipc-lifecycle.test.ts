import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";
import { createIpcTestDependencies } from "./ipc-test-dependencies.ts";

const electron = vi.hoisted(() => ({
  failChannel: undefined as string | undefined,
  removeHandler: vi.fn(),
  removeAllListeners: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { relaunch: vi.fn(), exit: vi.fn(), getPath: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string) => {
      if (channel === electron.failChannel) throw new Error(`failed ${channel}`);
    },
    on: vi.fn(),
    removeHandler: electron.removeHandler,
    removeAllListeners: electron.removeAllListeners,
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  webContents: { fromId: vi.fn() },
}));

describe("registerIpc lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electron.failChannel = undefined;
  });

  it("rolls back registered channels when a registrar fails", () => {
    electron.failChannel = CHANNELS.sessionsList;

    expect(() => registerIpc(createIpcTestDependencies({}))).toThrow(`failed ${CHANNELS.sessionsList}`);

    expect(electron.removeAllListeners).toHaveBeenCalledWith(CHANNELS.windowClose);
    expect(electron.removeHandler).toHaveBeenCalledWith(CHANNELS.sessionsList);
  });

  it("disposes subscriptions and owned channels once", () => {
    const unsubscribe = vi.fn();
    const registration = registerIpc(
      createIpcTestDependencies({
        updater: { subscribe: vi.fn(() => unsubscribe) } as never,
      }),
    );

    registration.dispose();
    registration.dispose();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(electron.removeHandler).toHaveBeenCalledWith(CHANNELS.updaterCheck);
    expect(electron.removeHandler).not.toHaveBeenCalledWith("external:channel");
  });
});
