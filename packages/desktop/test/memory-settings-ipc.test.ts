import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: { relaunch: vi.fn(), exit: vi.fn() },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => electron.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

describe("memory settings IPC", () => {
  const refreshMemoryConfiguration = vi.fn();
  const dirtyGuard = { requestClose: vi.fn(), setDirty: vi.fn(), remove: vi.fn() };
  const memorySettings = {
    getSnapshot: vi.fn(),
    saveConfig: vi.fn(),
    mutateEntry: vi.fn(),
    runMaintenance: vi.fn(),
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
      {} as never,
      {} as never,
      dirtyGuard as never,
      { refreshMemoryConfiguration },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      memorySettings as never,
    );
  });

  test("映射快照、配置、条目和维护处理器", async () => {
    const snapshot = { revision: "one" };
    const saveInput = { expectedRevision: "one", settings: {} };
    const mutation = { action: "add", target: "user", content: "fact" };
    const maintenance = { action: "sync-markdown" };
    memorySettings.getSnapshot.mockResolvedValue(snapshot);
    memorySettings.saveConfig.mockResolvedValue({ status: "saved", snapshot });
    memorySettings.mutateEntry.mockResolvedValue({ success: true, snapshot });
    memorySettings.runMaintenance.mockResolvedValue({ success: true, message: "done", snapshot });

    await expect(electron.handles.get(CHANNELS.memorySettingsGetSnapshot)?.({})).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.memorySettingsSaveConfig)?.({}, saveInput)).resolves.toEqual({
      status: "saved",
      snapshot,
    });
    await expect(electron.handles.get(CHANNELS.memorySettingsMutateEntry)?.({}, mutation)).resolves.toMatchObject({
      success: true,
    });
    await expect(electron.handles.get(CHANNELS.memorySettingsRunMaintenance)?.({}, maintenance)).resolves.toMatchObject(
      { success: true },
    );
    expect(refreshMemoryConfiguration).toHaveBeenCalledOnce();
    expect(memorySettings.mutateEntry).toHaveBeenCalledWith(mutation);
    expect(memorySettings.runMaintenance).toHaveBeenCalledWith(maintenance);
  });

  test("配置冲突不刷新活动扩展", async () => {
    memorySettings.saveConfig.mockResolvedValue({ status: "conflict", current: { revision: "two" } });

    await electron.handles.get(CHANNELS.memorySettingsSaveConfig)?.({}, { expectedRevision: "one", settings: {} });

    expect(refreshMemoryConfiguration).not.toHaveBeenCalled();
  });

  test("配置已保存但活动会话刷新失败时返回警告", async () => {
    const snapshot = { revision: "two" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    memorySettings.saveConfig.mockResolvedValue({ status: "saved", snapshot, warning: "索引稍后更新。" });
    refreshMemoryConfiguration.mockRejectedValue(new Error("refresh failed"));

    await expect(
      electron.handles.get(CHANNELS.memorySettingsSaveConfig)?.({}, { expectedRevision: "one", settings: {} }),
    ).resolves.toEqual({
      status: "saved",
      snapshot,
      warning: "索引稍后更新。 设置已保存，但活动会话刷新失败；新会话将使用最新配置。",
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  test("同步记忆编辑器 dirty 状态并在渲染进程销毁时清理", () => {
    let destroyed: (() => void) | undefined;
    const event = {
      sender: {
        id: 42,
        once: vi.fn((_name: string, listener: () => void) => {
          destroyed = listener;
        }),
      },
      returnValue: undefined as boolean | undefined,
    };

    electron.listeners.get(CHANNELS.memorySettingsSetEditorDirty)?.(event, true);

    expect(event.returnValue).toBe(true);
    expect(dirtyGuard.setDirty).toHaveBeenCalledWith(42, true);
    expect(event.sender.once).toHaveBeenCalledWith("destroyed", expect.any(Function));
    destroyed?.();
    expect(dirtyGuard.remove).toHaveBeenCalledWith(42);
  });

  test("拒绝非布尔 dirty 状态", () => {
    const event = { sender: { id: 42 }, returnValue: undefined as boolean | undefined };

    electron.listeners.get(CHANNELS.memorySettingsSetEditorDirty)?.(event, "true");

    expect(event.returnValue).toBe(false);
    expect(dirtyGuard.setDirty).not.toHaveBeenCalled();
  });
});
