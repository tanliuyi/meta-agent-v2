import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceServices } from "../src/main/bootstrap/workspace-services.ts";
import { OfficeDocumentPreviewService } from "../src/main/files/office-document-preview-service.ts";

const mocks = vi.hoisted(() => ({
  scm: {},
  scmWatcher: { stopAll: vi.fn() },
  fileWatcher: { dispose: vi.fn() },
  terminals: { dispose: vi.fn() },
  office: {},
  officeOptions: undefined as { getConfiguration(): Promise<unknown> } | undefined,
}));

vi.mock("../src/main/scm/scm-service.ts", () => ({
  ScmService: vi.fn(function ScmService() {
    return mocks.scm;
  }),
}));
vi.mock("../src/main/scm/scm-watcher.ts", () => ({
  ProjectScmWatcher: vi.fn(function ProjectScmWatcher() {
    return mocks.scmWatcher;
  }),
}));
vi.mock("../src/main/files/file-watcher.ts", () => ({
  ProjectFileWatcher: vi.fn(function ProjectFileWatcher() {
    return mocks.fileWatcher;
  }),
}));
vi.mock("../src/main/terminal/terminal-supervisor.ts", () => ({
  createTerminalShellResolver: vi.fn(() => "shell-resolver"),
  TerminalSupervisor: vi.fn(function TerminalSupervisor() {
    return mocks.terminals;
  }),
}));
vi.mock("../src/main/files/office-document-preview-service.ts", () => ({
  OfficeDocumentPreviewService: vi.fn(function OfficeDocumentPreviewService(_projects, options) {
    mocks.officeOptions = options;
    return mocks.office;
  }),
}));

function options(getRuntimeConfiguration = vi.fn(async () => ({ values: {} }))) {
  return {
    context: { agentDir: "C:/agent", userDataDir: "C:/data" },
    core: { projects: {} },
    plugins: { pluginConfigurations: { getRuntimeConfiguration } },
    sessions: { workers: { getSessionCwd: vi.fn() } },
    workspaceMutation: { bind: vi.fn(), unbind: vi.fn() },
    publishScmChanged: vi.fn(),
    publishFileChanged: vi.fn(),
    publishTerminalEvent: vi.fn(),
  } as never;
}

describe("createWorkspaceServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.officeOptions = undefined;
  });

  it("constructs and binds the workspace graph", () => {
    const input = options();
    const services = createWorkspaceServices(input);

    expect(input.workspaceMutation.bind).toHaveBeenCalledWith(mocks.terminals);
    expect(OfficeDocumentPreviewService).toHaveBeenCalledOnce();
    expect(services).toMatchObject({ scm: mocks.scm, scmWatcher: mocks.scmWatcher, terminals: mocks.terminals });
  });

  it("degrades optional Office configuration failures to an empty config", async () => {
    createWorkspaceServices(
      options(
        vi.fn(async () => {
          throw new Error("plugin missing");
        }),
      ),
    );

    await expect(mocks.officeOptions?.getConfiguration()).resolves.toEqual({});
  });

  it("disposes watchers and terminals once", () => {
    const services = createWorkspaceServices(options());

    services.dispose();
    services.dispose();

    expect(mocks.scmWatcher.stopAll).toHaveBeenCalledOnce();
    expect(mocks.fileWatcher.dispose).toHaveBeenCalledOnce();
    expect(mocks.terminals.dispose).toHaveBeenCalledOnce();
  });

  it("continues disposal when a watcher fails", () => {
    mocks.scmWatcher.stopAll.mockImplementationOnce(() => {
      throw new Error("watcher stop failed");
    });
    const services = createWorkspaceServices(options());

    expect(() => services.dispose()).toThrow("Failed to dispose workspace services");

    expect(mocks.fileWatcher.dispose).toHaveBeenCalledOnce();
    expect(mocks.terminals.dispose).toHaveBeenCalledOnce();
  });
});
