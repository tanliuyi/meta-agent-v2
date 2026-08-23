import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetadataWorkerClient } from "../src/main/sidecar/metadata-worker-client.ts";
import type { SidecarRuntimeManifest } from "../src/main/sidecar/sidecar-runtime-manifest.ts";
import {
  type ThreadWorkerClient,
  ThreadWorkerRegistry,
  type ThreadWorkerRegistryOptions,
} from "../src/main/sidecar/thread-worker-registry.ts";
import type { WorkerClientOptions } from "../src/main/sidecar/worker-client.ts";
import {
  type HostResponse,
  type JsonValue,
  PROTOCOL_VERSION,
  type SessionBootstrap,
  type SessionCreateInput,
  type SessionPromptInput,
  type SessionPushPayload,
  type Thread,
} from "../src/shared/contracts.ts";
import { SIDECAR_PROTOCOL_VERSION, type SidecarCommand, type SidecarReady } from "../src/shared/sidecar-contracts.ts";
import { currentRuntimeCompatibility } from "../src/shared/sidecar-wire.ts";

describe("ThreadWorkerRegistry model refresh", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "thread-worker-model-refresh-"));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("restarts an idle materialized worker and requests renderer resync", async () => {
    const harness = createHarness(userDataDir);
    const registry = new ThreadWorkerRegistry(harness.options);
    const attachment = await registry.attach("project", "thread");

    await registry.refreshAllModels({ generation: 7 });

    expect(harness.clients).toHaveLength(2);
    expect(harness.clients[0]?.shutdownCount).toBe(1);
    expect(harness.clients[1]?.instanceId).not.toBe(attachment.workerInstanceId);
    expect(harness.resync).toHaveBeenCalledWith(
      "project",
      "thread",
      "System Pi restarted for model configuration generation 7",
    );
    await registry.dispose();
  });

  it("serializes concurrent configuration generations across replacement startup", async () => {
    const replacementReady = deferred<void>();
    const harness = createHarness(userDataDir, { replacementReady });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");

    const firstRefresh = registry.refreshAllModels({ generation: 7 });
    await vi.waitFor(() => expect(harness.clients).toHaveLength(2));
    const secondRefresh = registry.refreshAllModels({ generation: 8 });
    await Promise.resolve();
    expect(harness.clients).toHaveLength(2);

    replacementReady.resolve();
    await Promise.all([firstRefresh, secondRefresh]);
    expect(harness.clients).toHaveLength(3);
    expect(harness.resync).toHaveBeenNthCalledWith(
      1,
      "project",
      "thread",
      "System Pi restarted for model configuration generation 7",
    );
    expect(harness.resync).toHaveBeenNthCalledWith(
      2,
      "project",
      "thread",
      "System Pi restarted for model configuration generation 8",
    );
    await registry.dispose();
  });

  it("does not restart a worker while a sidecar request is in flight", async () => {
    const promptGate = deferred<void>();
    const harness = createHarness(userDataDir, { promptGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const prompting = registry.prompt(promptInput());
    await vi.waitFor(() => expect(harness.clients[0]?.requests).toContain("prompt"));

    await expect(registry.refreshModels("project", "thread")).resolves.toBeUndefined();
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.shutdownCount).toBe(0);

    promptGate.resolve();
    await prompting;
    await vi.waitFor(() => expect(harness.clients).toHaveLength(2));
    expect(harness.clients[0]?.shutdownCount).toBe(1);
    await registry.dispose();
  });

  it("keeps prompt running state atomic when summary events are backpressured", async () => {
    const harness = createHarness(userDataDir, { promptRunning: true });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");

    await registry.prompt(promptInput());
    await expect(registry.refreshAllModels({ generation: 9 })).resolves.toBeUndefined();
    await expect(registry.refreshAllModels({ generation: 10 })).resolves.toBeUndefined();
    expect(harness.clients[0]?.shutdownCount).toBe(0);

    harness.clients[0]?.emitRunning(false);
    await vi.waitFor(() => expect(harness.clients).toHaveLength(2));
    expect(harness.clients[0]?.shutdownCount).toBe(1);
    expect(harness.resync).toHaveBeenCalledOnce();
    expect(harness.resync).toHaveBeenCalledWith(
      "project",
      "thread",
      "System Pi restarted for model configuration generation 10",
    );
    await registry.dispose();
  });

  it("defers refresh while a host UI response is in flight", async () => {
    const hostResponseGate = deferred<void>();
    const harness = createHarness(userDataDir, { hostResponseGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    const responding = registry.respond("project", "thread", hostResponse());
    await vi.waitFor(() => expect(harness.clients[0]?.requests).toContain("respondHostUi"));

    await expect(registry.refreshModels("project", "thread")).resolves.toBeUndefined();
    expect(harness.clients[0]?.shutdownCount).toBe(0);

    hostResponseGate.resolve();
    await responding;
    await vi.waitFor(() => expect(harness.clients).toHaveLength(2));
    expect(harness.clients[0]?.shutdownCount).toBe(1);
    await registry.dispose();
  });

  it("does not revive a worker when a queued refresh overlaps project removal", async () => {
    const replacementReady = deferred<void>();
    const harness = createHarness(userDataDir, { replacementReady });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");

    const activeRefresh = registry.refreshAllModels({ generation: 11 });
    await vi.waitFor(() => expect(harness.clients).toHaveLength(2));
    const queuedRefresh = registry.refreshModels("project", "thread");
    const removal = registry.removeProject("project");
    replacementReady.resolve();

    await activeRefresh;
    await expect(queuedRefresh).rejects.toThrow("Project project is being removed");
    await removal;
    expect(harness.clients).toHaveLength(2);
    expect(harness.clients[1]?.shutdownCount).toBe(1);
    await registry.dispose();
  });

  it("reports a deferred restart shutdown failure through the worker failure channel", async () => {
    const harness = createHarness(userDataDir, { promptRunning: true, shutdownError: new Error("shutdown failed") });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    await registry.prompt(promptInput());
    await expect(registry.refreshModels("project", "thread")).resolves.toBeUndefined();

    harness.clients[0]?.emitRunning(false);
    await vi.waitFor(() =>
      expect(harness.failed).toHaveBeenCalledWith(
        "project",
        "thread",
        expect.objectContaining({ message: "shutdown failed" }),
      ),
    );
    expect(harness.clients).toHaveLength(1);
    await registry.dispose();
  });

  it("accounts for creation recovery bootstrap requests before refreshing", async () => {
    const bootstrapGate = deferred<void>();
    const harness = createHarness(userDataDir, { bootstrapGate });
    const registry = new ThreadWorkerRegistry(harness.options);
    await registry.attach("project", "thread");
    writeCreationReservation(userDataDir);

    const recovery = registry.create(createInput());
    await vi.waitFor(() => expect(harness.clients[0]?.bootstrapRequestCount).toBe(2));
    await expect(registry.refreshAllModels({ generation: 9 })).resolves.toBeUndefined();
    expect(harness.clients[0]?.shutdownCount).toBe(0);

    bootstrapGate.resolve();
    await expect(recovery).resolves.toMatchObject({ threadId: "thread" });
    await vi.waitFor(() => expect(harness.clients).toHaveLength(2));
    expect(harness.clients[0]?.shutdownCount).toBe(1);
    await registry.dispose();
  });
});

interface HarnessOptions {
  promptGate?: ReturnType<typeof deferred<void>>;
  replacementReady?: ReturnType<typeof deferred<void>>;
  bootstrapGate?: ReturnType<typeof deferred<void>>;
  hostResponseGate?: ReturnType<typeof deferred<void>>;
  promptRunning?: boolean;
  shutdownError?: Error;
}

interface Harness {
  options: ThreadWorkerRegistryOptions;
  clients: FakeWorkerClient[];
  failed: ReturnType<typeof vi.fn>;
  resync: ReturnType<typeof vi.fn>;
}

function createHarness(userDataDir: string, harnessOptions: HarnessOptions = {}): Harness {
  const clients: FakeWorkerClient[] = [];
  const failed = vi.fn();
  const resync = vi.fn();
  const metadata = {
    list: vi.fn(async (): Promise<Thread[]> => [thread()]),
    resolve: vi.fn(async () => ({ id: "thread", path: join(userDataDir, "thread.jsonl") })),
    upsert: vi.fn(async () => undefined),
    invalidateProject: vi.fn(async () => undefined),
  } as unknown as MetadataWorkerClient;
  const options: ThreadWorkerRegistryOptions = {
    manifest: manifest(),
    metadata,
    userDataDir,
    agentDir: join(userDataDir, "agent"),
    getCwd: () => "/workspace",
    push: vi.fn<(payload: SessionPushPayload, workerInstanceId: string, sidecarSequence: number) => void>(),
    failed,
    resync,
    createWorkerClient: (clientOptions) => {
      const readyGate = clients.length > 0 ? harnessOptions.replacementReady : undefined;
      const client = new FakeWorkerClient(
        clientOptions,
        harnessOptions.promptGate,
        readyGate,
        harnessOptions.bootstrapGate,
        harnessOptions.hostResponseGate,
        harnessOptions.promptRunning ?? false,
        harnessOptions.shutdownError,
      );
      clients.push(client);
      return client;
    },
  };
  return { options, clients, failed, resync };
}

class FakeWorkerClient implements ThreadWorkerClient {
  readonly instanceId: string;
  readonly available = true;
  readonly requests: SidecarCommand["type"][] = [];
  bootstrapRequestCount = 0;
  shutdownCount = 0;
  private readonly options: WorkerClientOptions;
  private readonly promptGate?: ReturnType<typeof deferred<void>>;
  private readonly readyGate?: ReturnType<typeof deferred<void>>;
  private readonly bootstrapGate?: ReturnType<typeof deferred<void>>;
  private readonly hostResponseGate?: ReturnType<typeof deferred<void>>;
  private readonly promptRunning: boolean;
  private readonly shutdownError?: Error;

  constructor(
    options: WorkerClientOptions,
    promptGate?: ReturnType<typeof deferred<void>>,
    readyGate?: ReturnType<typeof deferred<void>>,
    bootstrapGate?: ReturnType<typeof deferred<void>>,
    hostResponseGate?: ReturnType<typeof deferred<void>>,
    promptRunning = false,
    shutdownError?: Error,
  ) {
    this.options = options;
    this.promptGate = promptGate;
    this.readyGate = readyGate;
    this.bootstrapGate = bootstrapGate;
    this.hostResponseGate = hostResponseGate;
    this.promptRunning = promptRunning;
    this.shutdownError = shutdownError;
    this.instanceId = `worker-${nextWorkerId++}`;
  }

  async ready(): Promise<SidecarReady> {
    await this.readyGate?.promise;
    if (this.options.binding.role !== "thread") throw new Error("Expected a thread worker binding");
    const threadId =
      this.options.binding.value.mode === "open"
        ? this.options.binding.value.threadId
        : this.options.binding.value.sessionId;
    return {
      kind: "ready",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.instanceId,
      role: "thread",
      runtime: this.options.manifest.compatibility,
      result: bootstrap(threadId) as unknown as JsonValue,
    };
  }

  async request<T>(command: SidecarCommand): Promise<T> {
    this.requests.push(command.type);
    if (command.type === "bootstrap") {
      this.bootstrapRequestCount += 1;
      if (this.bootstrapRequestCount > 1) await this.bootstrapGate?.promise;
      return bootstrap("thread") as unknown as T;
    }
    if (command.type === "prompt") {
      await this.promptGate?.promise;
      return { accepted: true, queued: false, running: this.promptRunning } as T;
    }
    if (command.type === "respondHostUi") await this.hostResponseGate?.promise;
    return null as T;
  }

  acknowledge(): void {}

  emitRunning(running: boolean): void {
    this.options.onEvent({
      kind: "event",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.instanceId,
      sequence: 1,
      creditCost: 1,
      event: { type: "summary-changed", summary: { ...thread(), running } },
    });
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    if (this.shutdownError) throw this.shutdownError;
  }
}

let nextWorkerId = 1;

function createInput(): SessionCreateInput {
  return {
    projectId: "project",
    createRequestId: "create-request",
    model: { provider: "provider", id: "model" },
    thinkingLevel: "off",
  };
}

function writeCreationReservation(userDataDir: string): void {
  const directory = join(userDataDir, "creation-reservations");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "thread.json"),
    JSON.stringify({
      projectId: "project",
      cwd: "/workspace",
      sessionId: "thread",
      createRequestId: "create-request",
      state: "materialized",
      sessionFile: join(userDataDir, "thread.jsonl"),
      updatedAt: Date.now(),
    }),
  );
}

function hostResponse(): HostResponse {
  return {
    requestId: "host-request",
    confirmed: true,
  };
}

function promptInput(): SessionPromptInput {
  return {
    requestId: "request",
    projectId: "project",
    threadId: "thread",
    text: "hello",
    images: [],
  };
}

function bootstrap(threadId: string): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId,
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId,
      cursor: 0,
      headId: null,
      nodes: [],
      queue: [],
      phase: "idle",
    },
    events: [],
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: "project",
      threadId,
      title: threadId,
      updatedAt: 1,
      cwd: "/workspace",
      running: false,
      queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionHost: { statuses: {}, widgets: [] },
    },
  };
}

function thread(): Thread {
  return {
    id: "thread",
    projectId: "project",
    title: "thread",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: "",
    archived: false,
    running: false,
  };
}

function manifest(): SidecarRuntimeManifest {
  const compatibility = currentRuntimeCompatibility("test");
  return {
    entries: { thread: "", metadata: "" },
    compatibility,
    integrity: { entries: { thread: "", metadata: "" }, files: {} },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value as T) };
}
