import { describe, expect, it, vi } from "vitest";
import { registerApplicationIpc } from "../src/main/bootstrap/ipc-registration.ts";
import { registerIpc } from "../src/main/ipc.ts";

vi.mock("../src/main/ipc.ts", () => ({ registerIpc: vi.fn(() => ({ dispose: vi.fn() })) }));

describe("registerApplicationIpc", () => {
  it("maps the completed service graph to named IPC dependencies", () => {
    const core = {
      projects: {},
      files: {},
      models: {},
      auth: {},
      providers: {},
      settings: {},
      preferences: {},
      memorySettings: {},
      autoTitleSettings: {},
    };
    const plugins = {
      extensionSettings: {},
      marketplaceEndpoints: {},
      marketplaceCatalog: {},
      marketplaceRegistry: {},
      marketplaceInstaller: {},
      pluginConfigurations: {},
      marketplaceGarbageCollector: {},
    };
    const sessions = {
      sessions: {},
      subagentSettings: {},
      refreshActiveModelRuntimes: vi.fn(),
      refreshMemoryConfiguration: vi.fn(),
    };
    const workspace = { scm: {}, scmWatcher: {}, officeDocuments: {}, fileWatcher: {}, terminals: {} };
    const browser = { manager: {} };
    const context = {
      agentDir: "C:/agent",
      shellPath: undefined,
      shellInstaller: { installedBashPath: vi.fn(), install: vi.fn(), onProgress: vi.fn() },
    };
    const updater = {};
    const dirtyGuard = {};

    registerApplicationIpc({ context, core, plugins, sessions, workspace, browser, updater, dirtyGuard } as never);

    expect(registerIpc).toHaveBeenCalledOnce();
    expect(vi.mocked(registerIpc).mock.calls[0]?.[0]).toMatchObject({
      projects: core.projects,
      files: core.files,
      sessions: sessions.sessions,
      subagents: sessions.subagentSettings,
      scm: workspace.scm,
      terminals: workspace.terminals,
      extensions: plugins.extensionSettings,
      marketplaceRegistry: plugins.marketplaceRegistry,
      browser: browser.manager,
      updater,
      dirtyGuard,
    });
  });
});
