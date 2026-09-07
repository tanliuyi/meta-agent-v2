import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";
import { createIpcTestDependencies } from "./ipc-test-dependencies.ts";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => electron.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

describe("Codex plugin IPC", () => {
  const sessions = { extensionSettingsChanged: vi.fn() };
  const codexCatalog = {
    list: vi.fn(),
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    setEnabled: vi.fn(),
  };

  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    vi.clearAllMocks();
    registerIpc(
      createIpcTestDependencies({
        projects: { list: vi.fn(), getActive: vi.fn() } as never,
        sessions: sessions as never,
        dirtyGuard: { requestClose: vi.fn(), setDirty: vi.fn(), remove: vi.fn() } as never,
        codexCatalog: codexCatalog as never,
      }),
    );
  });

  it("exposes only the Codex plugin channels", () => {
    expect(electron.handles.has(CHANNELS.codexPluginsList)).toBe(true);
    expect([...electron.handles.keys()].some((channel) => channel.startsWith("desktop:marketplace:"))).toBe(false);
  });

  it("invalidates extension generations after successful mutations", async () => {
    const install = { requestId: "install", expectedRevision: "one", pluginId: "sample", confirmFullTrust: true };
    const update = { requestId: "update", expectedRevision: "two", pluginId: "sample", confirmFullTrust: true };
    const uninstall = { requestId: "remove", expectedRevision: "three", pluginId: "sample", confirmRemoval: true };
    codexCatalog.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });
    codexCatalog.update.mockResolvedValue({ status: "updated", snapshot: { revision: "three", plugins: [] } });
    codexCatalog.uninstall.mockResolvedValue({ status: "uninstalled", snapshot: { revision: "four", plugins: [] } });

    await electron.handles.get(CHANNELS.codexPluginsInstall)?.({}, install);
    await electron.handles.get(CHANNELS.codexPluginsUpdate)?.({}, update);
    await electron.handles.get(CHANNELS.codexPluginsUninstall)?.({}, uninstall);

    expect(codexCatalog.install).toHaveBeenCalledWith(install);
    expect(codexCatalog.update).toHaveBeenCalledWith(update);
    expect(codexCatalog.uninstall).toHaveBeenCalledWith(uninstall);
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledTimes(3);
  });

  it("rejects missing trust confirmation before calling the catalog", async () => {
    const handler = electron.handles.get(CHANNELS.codexPluginsInstall);
    await expect(handler?.({}, { requestId: "install", expectedRevision: "one", pluginId: "sample" })).rejects.toThrow(
      "Invalid plugin IPC input",
    );
    expect(codexCatalog.install).not.toHaveBeenCalled();
  });

  it("does not invalidate generations for conflicts", async () => {
    codexCatalog.setEnabled.mockResolvedValue({ status: "conflict", current: { revision: "two", plugins: [] } });
    const result = await electron.handles.get(CHANNELS.codexPluginsSetEnabled)?.(
      {},
      { requestId: "toggle", expectedRevision: "one", pluginId: "sample", enabled: false },
    );
    expect(result).toEqual({ status: "conflict", current: { revision: "two", plugins: [] } });
    expect(sessions.extensionSettingsChanged).not.toHaveBeenCalled();
  });
});
