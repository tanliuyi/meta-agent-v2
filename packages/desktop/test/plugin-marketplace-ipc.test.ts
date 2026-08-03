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
  const registry = { getSnapshot: vi.fn(), commitScope: vi.fn() };
  const installer = {
    install: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
  };
  const pluginConfigurations = { getConfig: vi.fn(), saveConfig: vi.fn() };

  beforeEach(() => {
    electron.handles.clear();
    electron.listeners.clear();
    vi.clearAllMocks();
    registerIpc(
      { list: vi.fn(), getActive: vi.fn() } as never,
      sessions as never,
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
      undefined,
      endpoints as never,
      catalog as never,
      registry as never,
      installer as never,
      pluginConfigurations as never,
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

  it("reads and saves validated plugin configuration through main-owned services", async () => {
    const snapshot = {
      pluginId: "dev.meta-agent.plugin",
      revision: "config-one",
      schema: { version: 1, fields: [] },
      values: {},
      secrets: {},
      secretStorageAvailable: true,
    };
    const input = {
      requestId: "config-save",
      pluginId: "dev.meta-agent.plugin",
      expectedRevision: "config-one",
      values: {},
    };
    pluginConfigurations.getConfig.mockResolvedValue(snapshot);
    pluginConfigurations.saveConfig.mockResolvedValue({ status: "saved", snapshot });

    await expect(
      electron.handles.get(CHANNELS.marketplaceGetPluginConfiguration)?.({}, "dev.meta-agent.plugin"),
    ).resolves.toBe(snapshot);
    await expect(electron.handles.get(CHANNELS.marketplaceSavePluginConfiguration)?.({}, input)).resolves.toEqual({
      status: "saved",
      snapshot,
    });

    expect(pluginConfigurations.getConfig).toHaveBeenCalledWith("dev.meta-agent.plugin");
    expect(pluginConfigurations.saveConfig).toHaveBeenCalledWith(input);
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledOnce();
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
        }),
      }),
    );
  });

  it("applies an installation directly to the requested current session", async () => {
    const input = {
      requestId: "install-apply",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "thread", abortRunning: true },
    };
    installer.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });
    sessions.getExtensionState.mockResolvedValue({ desiredGeneration: "generation-two" });
    sessions.applyExtensionSet.mockResolvedValue({ status: "applied", generation: "generation-two" });

    const result = await electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input);

    expect(sessions.applyExtensionSet).toHaveBeenCalledWith("project", "thread", "generation-two", true);
    expect(result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({}),
        application: { status: "applied", generation: "generation-two" },
      }),
    );
    expect(result).not.toHaveProperty("operationId");
  });

  it("keeps the installed version when current-session apply rolls back", async () => {
    const input = {
      requestId: "install-rolled-back",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      version: "1.0.0",
      confirmFullTrust: true,
      applyToCurrentSession: { projectId: "project", threadId: "thread" },
    };
    installer.install.mockResolvedValue({ status: "installed", snapshot: { revision: "two", plugins: [] } });
    sessions.getExtensionState.mockResolvedValue({ desiredGeneration: "generation-two" });
    sessions.applyExtensionSet.mockResolvedValue({
      status: "rolled-back",
      generation: "generation-one",
      error: "/private/user/path/plugin.ts failed",
    });

    const result = await electron.handles.get(CHANNELS.marketplaceInstallPlugin)?.({}, input);

    expect(result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({ revision: "two" }),
        application: expect.objectContaining({
          status: "rolled-back",
          error: "插件 worker 启动失败，当前会话已恢复之前的扩展集合",
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain("/private/user/path");
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
        snapshot: expect.objectContaining({}),
      }),
    );
    expect(sessions.applyExtensionSet).not.toHaveBeenCalled();
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
        snapshot: expect.objectContaining({ revision: "three" }),
      }),
    );
  });

  it("returns an update conflict without invalidating extensions", async () => {
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
        snapshot: expect.objectContaining({ revision: "three" }),
      }),
    );
  });

  it("returns an uninstall not-installed snapshot without invalidating extensions", async () => {
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
      },
    });
    expect(sessions.extensionSettingsChanged).not.toHaveBeenCalled();
  });

  it("applies a plugin scope change and invalidates extension settings", async () => {
    const input = {
      requestId: "scope",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      scope: "project",
      projectIds: ["project-a", "project-b"],
    };
    const snapshot = { revision: "two", plugins: [] };
    registry.commitScope.mockResolvedValue({ status: "saved", snapshot });

    const result = await electron.handles.get(CHANNELS.marketplaceSetPluginScope)?.({}, input);

    expect(registry.commitScope).toHaveBeenCalledWith("one", "dev.meta-agent.plugin", "project", [
      "project-a",
      "project-b",
    ]);
    expect(sessions.extensionSettingsChanged).toHaveBeenCalledOnce();
    expect(result).toEqual({ status: "saved", snapshot });
  });

  it("clears the bound project when a plugin scope reverts to global", async () => {
    const input = {
      requestId: "scope-global",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      scope: "global",
    };
    const snapshot = { revision: "two", plugins: [] };
    registry.commitScope.mockResolvedValue({ status: "saved", snapshot });

    await electron.handles.get(CHANNELS.marketplaceSetPluginScope)?.({}, input);

    expect(registry.commitScope).toHaveBeenCalledWith("one", "dev.meta-agent.plugin", "global", undefined);
  });

  it("applies a scope change directly to the requested current session", async () => {
    const input = {
      requestId: "scope-apply",
      expectedRevision: "one",
      pluginId: "dev.meta-agent.plugin",
      scope: "project",
      projectIds: ["project-a"],
      applyToCurrentSession: { projectId: "project", threadId: "thread" },
    };
    registry.commitScope.mockResolvedValue({ status: "saved", snapshot: { revision: "two", plugins: [] } });
    sessions.getExtensionState.mockResolvedValue({ desiredGeneration: "generation-two" });
    sessions.applyExtensionSet.mockResolvedValue({ status: "applied", generation: "generation-two" });

    const result = await electron.handles.get(CHANNELS.marketplaceSetPluginScope)?.({}, input);

    expect(sessions.applyExtensionSet).toHaveBeenCalledWith("project", "thread", "generation-two", undefined);
    expect(result).toEqual(
      expect.objectContaining({
        status: "saved",
        application: { status: "applied", generation: "generation-two" },
      }),
    );
  });

  it("keeps the scope unchanged when the registry conflicts", async () => {
    const input = {
      requestId: "scope-conflict",
      expectedRevision: "stale",
      pluginId: "dev.meta-agent.plugin",
      scope: "global",
    };
    const current = { revision: "two", plugins: [] };
    registry.commitScope.mockResolvedValue({ status: "conflict", snapshot: current });

    const result = await electron.handles.get(CHANNELS.marketplaceSetPluginScope)?.({}, input);

    expect(result).toEqual({ status: "conflict", current });
    expect(sessions.extensionSettingsChanged).not.toHaveBeenCalled();
    expect(sessions.applyExtensionSet).not.toHaveBeenCalled();
  });
});
