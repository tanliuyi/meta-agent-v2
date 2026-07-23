import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  dialog: { showOpenDialog: electron.showOpenDialog },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => electron.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

describe("extensions IPC", () => {
  const sessions = {
    create: vi.fn(),
    applyExtensionSet: vi.fn(),
    extensionSettingsChanged: vi.fn(async () => undefined),
    getExtensionState: vi.fn(),
  };
  const extensions = {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    approveDevelopmentEntry: vi.fn(),
  };

  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    vi.clearAllMocks();
    registerIpc(
      { list: vi.fn(), getActive: vi.fn() } as never,
      sessions as never,
      {} as never,
      { disposeProject: vi.fn(), disposeSession: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { requestClose: vi.fn(), setDirty: vi.fn(), remove: vi.fn() } as never,
      { getStatus: vi.fn(), install: vi.fn(), onProgress: vi.fn() },
      undefined,
      extensions as never,
    );
  });

  it("routes settings mutations without accepting an entry path from renderer", async () => {
    const snapshot = { revision: "one", developerMode: false, reloadRequired: false, entries: [] };
    const input = {
      requestId: "request",
      expectedRevision: "one",
      mutation: { type: "set-developer-mode", enabled: true },
    };
    extensions.getConfig.mockResolvedValue(snapshot);
    extensions.saveConfig.mockResolvedValue({ status: "saved", snapshot });

    await expect(electron.handles.get(CHANNELS.extensionsGetConfig)?.({})).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.extensionsSaveConfig)?.({}, input)).resolves.toEqual({
      status: "saved",
      snapshot,
    });
    expect(extensions.saveConfig).toHaveBeenCalledWith(input);
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledOnce();
  });

  it("merges the active thread generation and diagnostics into the settings snapshot", async () => {
    extensions.getConfig.mockResolvedValue({
      revision: "one",
      developerMode: false,
      reloadRequired: false,
      diagnostics: [],
      entries: [],
    });
    sessions.getExtensionState.mockResolvedValue({
      appliedGeneration: "old",
      desiredGeneration: "next",
      reloadRequired: true,
      diagnostics: [{ extensionId: "development:one", message: "failed" }],
    });

    await expect(electron.handles.get(CHANNELS.extensionsGetConfig)?.({}, "project", "thread")).resolves.toMatchObject({
      reloadRequired: true,
      appliedGeneration: "old",
      desiredGeneration: "next",
      diagnostics: [{ extensionId: "development:one", message: "failed" }],
    });
  });

  it("approves only the path returned by the main-owned native dialog", async () => {
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/approved/extension.ts"] });
    extensions.approveDevelopmentEntry.mockResolvedValue({ status: "saved" });
    const input = { requestId: "approve", expectedRevision: "one" };

    await electron.handles.get(CHANNELS.extensionsChooseDevelopmentEntry)?.({ sender: {} }, input);

    expect(electron.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ["openFile"] }));
    expect(extensions.approveDevelopmentEntry).toHaveBeenCalledWith(input, "/approved/extension.ts");
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledOnce();
  });

  it("preserves the stale draft error code and generation details across IPC", async () => {
    sessions.create.mockRejectedValue(
      Object.assign(new Error("Draft extension set changed; refresh the draft before creating a session"), {
        code: "STALE_DRAFT_EXTENSION_SET",
        details: {
          code: "STALE_DRAFT_EXTENSION_SET",
          requestedGeneration: "old",
          currentGeneration: "new",
        },
      }),
    );

    await expect(electron.handles.get(CHANNELS.sessionsCreate)?.({}, {})).resolves.toMatchObject({
      ok: false,
      error: {
        code: "STALE_DRAFT_EXTENSION_SET",
        details: { requestedGeneration: "old", currentGeneration: "new" },
      },
    });
  });

  it("routes explicit apply confirmation to the session supervisor", async () => {
    sessions.applyExtensionSet.mockResolvedValue({ status: "applied", generation: "next" });

    await expect(
      electron.handles.get(CHANNELS.extensionsApply)?.(
        {},
        {
          projectId: "project",
          threadId: "thread",
          expectedDesiredGeneration: "next",
          abortRunning: true,
        },
      ),
    ).resolves.toEqual({ status: "applied", generation: "next" });
    expect(sessions.applyExtensionSet).toHaveBeenCalledWith("project", "thread", "next", true);
  });
});
