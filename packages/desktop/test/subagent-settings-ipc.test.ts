import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";

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

describe("subagent settings IPC", () => {
  const subagents = {
    getSnapshot: vi.fn(),
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
      {} as never,
      {} as never,
      { requestClose: vi.fn(), setDirty: vi.fn(), remove: vi.fn() } as never,
      { getStatus: vi.fn(), install: vi.fn(), onProgress: vi.fn() },
      undefined,
      undefined,
      subagents as never,
    );
  });

  test("maps snapshot reads and mutation saves", async () => {
    const snapshot = { revision: "one", builtinAgents: [] };
    const getInput = { projectId: "project" };
    const saveInput = {
      requestId: "request",
      projectId: "project",
      expectedSnapshotRevision: "one",
      mutation: { type: "set-agent-enabled", agent: "reviewer", disabled: true },
    };
    subagents.getSnapshot.mockResolvedValue(snapshot);
    subagents.saveConfig.mockResolvedValue({ status: "saved", snapshot });

    await expect(electron.handles.get(CHANNELS.subagentsGetSnapshot)?.({}, getInput)).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.subagentsSaveConfig)?.({}, saveInput)).resolves.toEqual({
      status: "saved",
      snapshot,
    });
    expect(subagents.getSnapshot).toHaveBeenCalledWith(getInput);
    expect(subagents.saveConfig).toHaveBeenCalledWith(saveInput);
  });
});
