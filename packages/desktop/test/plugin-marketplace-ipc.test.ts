import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("plugin marketplace IPC", () => {
  const endpoints = {
    getSettings: vi.fn(),
    testEndpoint: vi.fn(),
    saveEndpoint: vi.fn(),
  };
  const catalog = { list: vi.fn() };
  const sessions = {
    extensionSettingsChanged: vi.fn(),
    getExtensionState: vi.fn(),
    applyExtensionSet: vi.fn(),
  };
  const registry = { getSnapshot: vi.fn() };
  const installer = {
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    getPendingApplyTransaction: vi.fn(),
    clearCompletedMutation: vi.fn(),
  };
  const mutationApply = { rollback: vi.fn(), complete: vi.fn() };
  const applyJournal = { hasMutationOperation: vi.fn() };
  const revocations = { decorateSnapshot: vi.fn() };

  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    vi.clearAllMocks();
    revocations.decorateSnapshot.mockImplementation(async (snapshot) => ({
      ...snapshot,
      revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
    }));
    registerIpc(
      { list: vi.fn(), getActive: vi.fn() } as never,
      sessions as never,
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
      undefined,
      endpoints as never,
      catalog as never,
      registry as never,
      installer as never,
      mutationApply as never,
      applyJournal as never,
      revocations as never,
    );
  });

  it("maps endpoint settings and catalog without accepting an artifact URL", async () => {
    const snapshot = { revision: "one", endpoints: [] };
    const testInput = { baseUrl: "https://market.example" };
    const saveInput = { requestId: "save", expectedRevision: "one", baseUrl: "https://market.example" };
    const listInput = { query: "git", limit: 20 };
    endpoints.getSettings.mockResolvedValue(snapshot);
    endpoints.testEndpoint.mockResolvedValue({ status: "ready" });
    endpoints.saveEndpoint.mockResolvedValue({ status: "saved", snapshot });
    catalog.list.mockResolvedValue({ plugins: [] });

    await expect(electron.handles.get(CHANNELS.marketplaceGetEndpointSettings)?.({})).resolves.toBe(snapshot);
    await electron.handles.get(CHANNELS.marketplaceTestEndpoint)?.({}, testInput);
    await electron.handles.get(CHANNELS.marketplaceSaveEndpoint)?.({}, saveInput);
    await electron.handles.get(CHANNELS.marketplaceListPlugins)?.({}, listInput);

    expect(endpoints.testEndpoint).toHaveBeenCalledWith(testInput);
    expect(endpoints.saveEndpoint).toHaveBeenCalledWith(saveInput);
    expect(catalog.list).toHaveBeenCalledWith(listInput);
    expect(saveInput).not.toHaveProperty("artifactUrl");
  });

  it("decorates installed snapshots with verified revocation status", async () => {
    const snapshot = { revision: "one", plugins: [] };
    const decorated = { revision: "one", plugins: [{ id: "plugin", revocation: { status: "blocked" } }] };
    registry.getSnapshot.mockResolvedValue(snapshot);
    revocations.decorateSnapshot.mockResolvedValue(decorated);

    await expect(electron.handles.get(CHANNELS.marketplaceGetInstalled)?.({})).resolves.toBe(decorated);

    expect(revocations.decorateSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it("invalidates worker extension generations after an installation", async () => {
    const input = {
      requestId: "install",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
    };
    installer.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });

    const result = await electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input);

    expect(installer.install).toHaveBeenCalledWith(input);
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          revision: "two",
          revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
        }),
      }),
    );
  });

  it("applies an installation to the requested current session without exposing the mutation journal", async () => {
    const input = {
      requestId: "install-apply",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "thread", abortRunning: true },
    };
    installer.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });
    installer.getPendingApplyTransaction.mockResolvedValue({ operationId: "internal-operation" });
    sessions.getExtensionState.mockResolvedValue({ desiredGeneration: "generation-two" });
    sessions.applyExtensionSet.mockResolvedValue({ status: "applied", generation: "generation-two" });

    const result = await electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input);

    expect(sessions.applyExtensionSet).toHaveBeenCalledWith(
      "project",
      "thread",
      "generation-two",
      true,
      "internal-operation",
    );
    expect(result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
        }),
        application: { status: "applied", generation: "generation-two" },
      }),
    );
    expect(result).not.toHaveProperty("operationId");
  });

  it("clears a stale request cache after mutation apply rolls back", async () => {
    const input = {
      requestId: "install-rolled-back",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "thread" },
    };
    installer.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });
    installer.getPendingApplyTransaction.mockResolvedValue({ operationId: "internal-operation" });
    sessions.getExtensionState.mockResolvedValue({ desiredGeneration: "generation-two" });
    sessions.applyExtensionSet.mockResolvedValue({
      status: "rolled-back",
      generation: "generation-one",
      error: "/private/user/path/plugin.ts failed",
    });
    applyJournal.hasMutationOperation.mockResolvedValue(false);
    const restoredSnapshot = { revision: "restored", plugins: [] };
    const decoratedRestoredSnapshot = {
      ...restoredSnapshot,
      revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
    };
    registry.getSnapshot.mockResolvedValue(restoredSnapshot);
    revocations.decorateSnapshot.mockResolvedValue(decoratedRestoredSnapshot);

    const result = await electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input);

    expect(installer.clearCompletedMutation).toHaveBeenCalledWith("install-rolled-back");
    expect(result).toEqual(
      expect.objectContaining({
        snapshot: decoratedRestoredSnapshot,
        application: expect.objectContaining({
          status: "rolled-back",
          error: "插件 worker 启动失败，当前会话已恢复之前的扩展集合",
        }),
      }),
    );
    expect(revocations.decorateSnapshot).toHaveBeenCalledTimes(1);
    expect(revocations.decorateSnapshot).toHaveBeenCalledWith(restoredSnapshot);
    expect(JSON.stringify(result)).not.toContain("/private/user/path");
  });

  it("completes the committed mutation when apply fails before its durable journal handoff", async () => {
    const input = {
      requestId: "install-pre-journal-failure",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "thread" },
    };
    installer.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });
    installer.getPendingApplyTransaction.mockResolvedValue({ operationId: "internal-operation" });
    sessions.getExtensionState.mockResolvedValue({ desiredGeneration: "generation-two" });
    sessions.applyExtensionSet.mockRejectedValue(new Error("confirm abort"));
    applyJournal.hasMutationOperation.mockResolvedValue(false);

    await expect(electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input)).resolves.toEqual(
      expect.objectContaining({ status: "installed", applicationError: "confirm abort" }),
    );

    expect(mutationApply.complete).toHaveBeenCalledWith("internal-operation");
  });

  it("rolls back a linked mutation when a cold session cannot complete initial startup", async () => {
    const input = {
      requestId: "install-cold-startup-failure",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "cold-thread" },
    };
    installer.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });
    installer.getPendingApplyTransaction.mockResolvedValue({ operationId: "internal-operation" });
    sessions.getExtensionState
      .mockResolvedValueOnce({ desiredGeneration: "generation-two" })
      .mockResolvedValueOnce({ desiredGeneration: "generation-one" });
    sessions.applyExtensionSet.mockRejectedValue(
      Object.assign(new Error("cold worker failed"), { code: "COLD_EXTENSION_SET_APPLY_STARTUP_FAILED" }),
    );
    applyJournal.hasMutationOperation.mockResolvedValue(false);
    const restoredSnapshot = { revision: "restored", plugins: [] };
    registry.getSnapshot.mockResolvedValue(restoredSnapshot);

    const result = await electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input);

    expect(mutationApply.rollback).toHaveBeenCalledWith("internal-operation");
    expect(mutationApply.complete).toHaveBeenCalledWith("internal-operation");
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          revision: "restored",
          revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
        }),
        application: expect.objectContaining({ status: "rolled-back", generation: "generation-one" }),
      }),
    );
  });

  it("decorates a recovery-pending installation without starting session apply", async () => {
    const input = {
      requestId: "install-recovery-pending",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "thread" },
    };
    installer.install.mockResolvedValue({
      status: "installed",
      snapshot: { revision: "two", plugins: [] },
      recoveryPending: true,
    });

    const result = await electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input);

    expect(result).toEqual(
      expect.objectContaining({
        recoveryPending: true,
        snapshot: expect.objectContaining({
          revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
        }),
      }),
    );
    expect(installer.getPendingApplyTransaction).not.toHaveBeenCalled();
    expect(sessions.applyExtensionSet).not.toHaveBeenCalled();
  });

  it("keeps the mutation pending when apply already crossed the durable journal handoff", async () => {
    const input = {
      requestId: "install-post-journal-failure",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "thread" },
    };
    installer.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });
    installer.getPendingApplyTransaction.mockResolvedValue({ operationId: "internal-operation" });
    sessions.getExtensionState.mockResolvedValue({ desiredGeneration: "generation-two" });
    applyJournal.hasMutationOperation.mockResolvedValue(true);

    await expect(electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input)).resolves.toEqual(
      expect.objectContaining({
        status: "installed",
        applicationError: expect.stringContaining("recovery is pending"),
      }),
    );

    expect(sessions.applyExtensionSet).not.toHaveBeenCalled();
    expect(mutationApply.complete).not.toHaveBeenCalled();
  });

  it("invalidates worker extension generations after an update", async () => {
    const input = {
      requestId: "update",
      expectedRevision: "two",
      pluginId: "dev.meta-agent.plugin",
      version: "2.0.0",
      confirmFullTrust: true,
    };
    installer.update.mockResolvedValue({
      status: "updated",
      snapshot: { revision: "three", plugins: [] },
      reloadRequired: true,
    });

    const result = await electron.handles.get(CHANNELS.marketplaceUpdatePlugin)?.({}, input);

    expect(installer.update).toHaveBeenCalledWith(input);
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          revision: "three",
          revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
        }),
      }),
    );
  });

  it("decorates an update conflict current snapshot without invalidating extensions", async () => {
    const input = {
      requestId: "update-conflict",
      expectedRevision: "two",
      pluginId: "dev.meta-agent.plugin",
      version: "2.0.0",
      confirmFullTrust: true,
    };
    installer.update.mockResolvedValue({
      status: "conflict",
      current: { revision: "current", plugins: [] },
    });

    const result = await electron.handles.get(CHANNELS.marketplaceUpdatePlugin)?.({}, input);

    expect(result).toEqual({
      status: "conflict",
      current: {
        revision: "current",
        plugins: [],
        revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
      },
    });
    expect(sessions.extensionSettingsChanged).not.toHaveBeenCalled();
  });

  it("invalidates worker extension generations after an uninstall", async () => {
    const input = {
      requestId: "uninstall",
      expectedRevision: "two",
      pluginId: "dev.meta-agent.plugin",
      confirmRemoval: true,
    };
    installer.uninstall.mockResolvedValue({
      status: "uninstalled",
      snapshot: { revision: "three", plugins: [] },
      reloadRequired: true,
    });

    const result = await electron.handles.get(CHANNELS.marketplaceUninstallPlugin)?.({}, input);

    expect(installer.uninstall).toHaveBeenCalledWith(input);
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          revision: "three",
          revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
        }),
      }),
    );
  });

  it("decorates an uninstall not-installed snapshot without invalidating extensions", async () => {
    const input = {
      requestId: "uninstall-not-installed",
      expectedRevision: "three",
      pluginId: "dev.meta-agent.plugin",
      confirmRemoval: true,
    };
    installer.uninstall.mockResolvedValue({
      status: "not-installed",
      snapshot: { revision: "three", plugins: [] },
    });

    const result = await electron.handles.get(CHANNELS.marketplaceUninstallPlugin)?.({}, input);

    expect(result).toEqual({
      status: "not-installed",
      snapshot: {
        revision: "three",
        plugins: [],
        revocationChecks: [{ marketplaceId: "test.market", status: "fresh" }],
      },
    });
    expect(sessions.extensionSettingsChanged).not.toHaveBeenCalled();
  });
});
