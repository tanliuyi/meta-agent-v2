import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionServices } from "../src/main/bootstrap/session-services.ts";
import { BrowserCapabilityPort } from "../src/main/session/browser-capability-port.ts";
import { WorkspaceMutationPort } from "../src/main/session/workspace-mutation-port.ts";

const mocks = vi.hoisted(() => ({
  metadata: { registerExternal: vi.fn(), dispose: vi.fn() },
  subagents: {
    acknowledge: vi.fn(),
    handleHostRequest: vi.fn(),
    cancelThread: vi.fn(),
    listThreads: vi.fn(),
    isActiveThread: vi.fn(),
    attach: vi.fn(),
    readImageResource: vi.fn(),
    cancelActiveThread: vi.fn(),
    beginWorkspaceMutation: vi.fn(),
    endWorkspaceMutation: vi.fn(),
    beginProjectMutation: vi.fn(),
    endProjectMutation: vi.fn(),
    beginThreadMutation: vi.fn(),
    endThreadMutation: vi.fn(),
    refreshAllModels: vi.fn(),
    dispose: vi.fn(),
  },
  workers: { acknowledge: vi.fn(), getSessionCwd: vi.fn(), refreshAllModels: vi.fn() },
  sessions: { dispose: vi.fn(), extensionSettingsChanged: vi.fn() },
  subagentOptions: undefined as Record<string, unknown> | undefined,
  workerOptions: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../src/main/sidecar/metadata-worker-client.ts", () => ({
  MetadataWorkerClient: vi.fn(function MetadataWorkerClient() {
    return mocks.metadata;
  }),
}));
vi.mock("../src/main/sidecar/subagent-worker-registry.ts", () => ({
  SubagentWorkerRegistry: vi.fn(function SubagentWorkerRegistry(options) {
    mocks.subagentOptions = options;
    return mocks.subagents;
  }),
}));
vi.mock("../src/main/sidecar/thread-worker-registry.ts", () => ({
  ThreadWorkerRegistry: vi.fn(function ThreadWorkerRegistry(options) {
    mocks.workerOptions = options;
    return mocks.workers;
  }),
}));
vi.mock("../src/main/pi/session-supervisor.ts", () => ({
  SessionSupervisor: vi.fn(function SessionSupervisor() {
    return mocks.sessions;
  }),
}));
vi.mock("../src/main/subagents/subagent-settings-config-service.ts", () => ({
  SubagentSettingsConfigService: vi.fn(),
}));
vi.mock("../src/main/sidecar/workspace-mutation-key.ts", () => ({
  resolveWorkspaceMutationKey: vi.fn(async () => "workspace"),
}));
vi.mock("../src/main/pi/extensions/pi-rewind/src/core.ts", () => ({ deleteSessionCheckpoints: vi.fn() }));

function options() {
  return {
    context: {
      manifest: { entries: { subagent: "C:/sidecar/subagent.js" } },
      agentDir: "C:/agent",
      userDataDir: "C:/data",
      sidecarLog: { write: vi.fn() },
      shellPath: undefined,
    },
    core: {
      projects: { getCwd: vi.fn(() => "C:/project"), resolveSessionCwd: vi.fn(), list: vi.fn(async () => []) },
      modelRuntime: {},
      isDesktopProviderAvailable: vi.fn(),
    },
    plugins: { extensionSourcePolicy: { invalidate: vi.fn() }, generationReferences: {} },
    workspaceMutation: new WorkspaceMutationPort(),
    browserCapability: new BrowserCapabilityPort(),
    publishCatalogChanged: vi.fn(),
    reportWorkerFailure: vi.fn(),
  } as never;
}

describe("createSessionServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subagentOptions = undefined;
    mocks.workerOptions = undefined;
    mocks.sessions.dispose.mockResolvedValue(undefined);
    mocks.subagents.dispose.mockResolvedValue(undefined);
    mocks.metadata.dispose.mockResolvedValue(undefined);
    mocks.subagents.refreshAllModels.mockResolvedValue(undefined);
    mocks.workers.refreshAllModels.mockResolvedValue(undefined);
  });

  it("constructs the worker graph through explicit ports", () => {
    const services = createSessionServices(options());

    expect(services).toMatchObject({
      metadata: mocks.metadata,
      subagents: mocks.subagents,
      workers: mocks.workers,
      sessions: mocks.sessions,
    });
    expect(mocks.subagentOptions).not.toHaveProperty("shellPath");
    expect(mocks.workerOptions).not.toHaveProperty("shellPath");
    expect(mocks.workerOptions?.registerBrowserSession).toEqual(expect.any(Function));
    expect(mocks.workerOptions?.beginTerminalWorkspaceMutation).toEqual(expect.any(Function));
  });

  it("continues disposal after a worker failure and aggregates it", async () => {
    mocks.sessions.dispose.mockRejectedValueOnce(new Error("thread stop failed"));
    const services = createSessionServices(options());

    await expect(services.dispose()).rejects.toThrow("Failed to dispose session services");

    expect(mocks.subagents.dispose).toHaveBeenCalledOnce();
    expect(mocks.metadata.dispose).toHaveBeenCalledOnce();
  });

  it("disposes the worker graph once", async () => {
    const services = createSessionServices(options());
    await Promise.all([services.dispose(), services.dispose()]);

    expect(mocks.sessions.dispose).toHaveBeenCalledOnce();
    expect(mocks.subagents.dispose).toHaveBeenCalledOnce();
    expect(mocks.metadata.dispose).toHaveBeenCalledOnce();
  });
});
