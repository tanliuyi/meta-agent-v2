import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeRuntimeManifest } from "../src/main/sidecar/node-runtime-locator.ts";
import { type SubagentWorkerClient, SubagentWorkerRegistry } from "../src/main/sidecar/subagent-worker-registry.ts";
import { assertHostRequestIdentity } from "../src/main/sidecar/thread-worker-registry.ts";
import type { WorkerClientOptions } from "../src/main/sidecar/worker-client.ts";
import { PROTOCOL_VERSION, type SessionBootstrap, type SessionPushPayload } from "../src/shared/contracts.ts";
import type { RuntimeCompatibility, SidecarEvent } from "../src/shared/sidecar-contracts.ts";
import type { SubagentRunRequest } from "../src/shared/subagent-contracts.ts";

const compatibility: RuntimeCompatibility = {
  nodeVersion: process.version,
  modulesAbi: process.versions.modules,
  napi: process.versions.napi ?? "unknown",
  platform: process.platform,
  arch: process.arch,
  osRelease: "test",
  libc: "test",
  toolchain: "test",
  piVersion: "test",
  runtimeCompatibilityId: "test",
};

function runRequest(runId = "run-1", childIndex = 0): SubagentRunRequest {
  return {
    projectId: "project",
    parentThreadId: "thread",
    runId,
    rootRunId: runId,
    childIndex,
    depth: 1,
    maxDepth: 1,
    lineage: [],
    agent: "worker",
    task: "Inspect",
    cwd: process.cwd(),
    persistSession: false,
    inheritProjectContext: false,
    inheritSkills: false,
    extensionProfile: ["provider", "memory", "runtime"],
  };
}

function subagentBootstrap(threadId: string): SessionBootstrap {
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
      phase: "running",
    },
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: "project",
      threadId,
      title: "Inspect",
      updatedAt: 1,
      cwd: process.cwd(),
      running: true,
      interaction: "read-only",
      queueModes: { steering: "all", followUp: "all" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionSet: { generation: "subagent", diagnostics: [], reloadRequired: false },
      extensionHost: { statuses: {}, widgets: [] },
    },
  };
}

function manifest(): NodeRuntimeManifest {
  return {
    nodePath: process.execPath,
    npmCliPath: process.execPath,
    entries: { thread: "", metadata: "", subagent: "" },
    compatibility,
    integrity: {
      nodePath: "",
      npmCliPath: "",
      entries: { thread: "", metadata: "", subagent: "" },
      files: {},
    },
  };
}

class FakeClient implements SubagentWorkerClient {
  readonly instanceId = randomUUID();
  private readonly options: WorkerClientOptions;
  readonly acknowledgements: number[] = [];
  readonly commandTypes: string[] = [];
  shutdownCount = 0;
  failure?: Error;
  run?: Promise<unknown>;
  bootstrapResult?: SessionBootstrap;

  constructor(options: WorkerClientOptions) {
    this.options = options;
  }

  ready() {
    return Promise.resolve({
      kind: "ready" as const,
      protocolVersion: 3 as const,
      workerInstanceId: this.instanceId,
      role: "subagent" as const,
      runtime: compatibility,
    });
  }

  async request<T>(command: Parameters<SubagentWorkerClient["request"]>[0]): Promise<T> {
    this.commandTypes.push(command.type);
    if (command.type === "subagentRun") {
      if (this.run) return (await this.run) as T;
      this.options.onEvent?.(event(this.instanceId, 1, { type: "started", runId: command.request.runId }));
      this.options.onEvent?.(event(this.instanceId, 2, { type: "completed", runId: command.request.runId }));
      return { status: "completed" } as T;
    }
    if (command.type === "subagentBootstrap") return this.bootstrapResult as T;
    return null as T;
  }

  get shellPath(): string | undefined {
    return this.options.binding.role === "subagent" ? this.options.binding.value.shellPath : undefined;
  }

  hostRequest(request: Parameters<NonNullable<WorkerClientOptions["onHostRequest"]>>[0]) {
    const handler = this.options.onHostRequest;
    if (!handler) throw new Error("Host request handler is unavailable");
    return handler(request, () => undefined);
  }

  acknowledge(sequence: number): void {
    this.acknowledgements.push(sequence);
  }

  fail(error: Error): void {
    this.failure = error;
  }

  crash(error: Error): void {
    this.failure = error;
    this.options.onFailure?.(error);
  }

  emitSidecarEvent(sidecarEvent: SidecarEvent): void {
    this.options.onEvent?.(sidecarEvent);
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
  }
}

function event(
  workerInstanceId: string,
  sequence: number,
  subagentEvent: Extract<SidecarEvent["event"], { type: "subagent-event" }>["event"],
): SidecarEvent {
  return {
    kind: "event",
    protocolVersion: 3,
    workerInstanceId,
    sequence,
    creditCost: 1,
    event: { type: "subagent-event", event: subagentEvent },
  };
}

describe("SubagentWorkerRegistry", () => {
  it("rejects host requests that escape the calling thread binding", () => {
    const binding = {
      mode: "open" as const,
      projectId: "project",
      cwd: process.cwd(),
      agentDir: process.cwd(),
      threadId: "thread",
      sessionFile: "session.jsonl",
      extensionSet: {
        generation: "builtin",
        projectId: "project",
        entries: [],
        diagnostics: [],
        resolvedAt: 0,
      },
    };
    expect(() =>
      assertHostRequestIdentity(
        { type: "subagent.run", request: { ...runRequest(), parentThreadId: "other" } },
        binding,
      ),
    ).toThrow("does not match");
    expect(() => assertHostRequestIdentity({ type: "subagent.run", request: runRequest() }, binding)).not.toThrow();
  });

  it("rejects extension paths before spawning a worker", async () => {
    let spawned = false;
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => {
        spawned = true;
        return new FakeClient(options);
      },
    });
    await expect(
      registry.handleHostRequest(
        { type: "subagent.run", request: { ...runRequest(), tools: ["C:\\extensions\\tool.ts"] } },
        () => undefined,
      ),
    ).rejects.toThrow("registered tool names");
    expect(spawned).toBe(false);
  });

  it("passes the resolved shell fallback in the explicit subagent binding", async () => {
    let client: FakeClient | undefined;
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      shellPath: "/managed/bin/bash",
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        return client;
      },
    });

    await registry.handleHostRequest({ type: "subagent.run", request: runRequest() }, () => undefined);

    expect(client?.shellPath).toBe("/managed/bin/bash");
  });

  it("broadcasts revisioned model refreshes to active subagent workers", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let client: FakeClient | undefined;
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        client.run = pending.then(() => ({ status: "completed" }));
        return client;
      },
    });
    const run = registry.handleHostRequest({ type: "subagent.run", request: runRequest() }, () => undefined);
    await expect.poll(() => client).toBeDefined();

    await registry.refreshAllModels({ generation: 8 });

    expect(client?.commandTypes).toContain("refreshModelConfiguration");
    release();
    await run;
  });

  it("owns a worker, forwards typed events, acknowledges them, and shuts it down", async () => {
    let client: FakeClient | undefined;
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        return client;
      },
    });
    const events: string[] = [];

    await expect(
      registry.handleHostRequest({ type: "subagent.run", request: runRequest() }, (item) => events.push(item.type)),
    ).resolves.toEqual({ status: "completed" });

    expect(events).toEqual(["started", "completed"]);
    expect(client?.acknowledgements).toEqual([1, 2]);
    expect(client?.shutdownCount).toBe(1);
  });

  it("projects persisted fork events into live thread catalog summaries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-catalog-"));
    const parentSessionFile = join(directory, "parent.jsonl");
    const sessionFile = join(directory, "child.jsonl");
    writeFileSync(
      parentSessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "direct-parent-thread",
        timestamp: "2026-01-02T03:04:00.000Z",
        cwd: process.cwd(),
      })}\n`,
    );
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "child-thread",
        timestamp: "2026-01-02T03:04:05.000Z",
        cwd: process.cwd(),
        parentSession: parentSessionFile,
      })}\n`,
    );
    const summaries: Array<{
      id: string;
      title: string;
      running: boolean;
      parentThreadId?: string;
      agentName?: string;
    }> = [];
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      catalogChanged: (summary) => summaries.push(summary),
      createWorkerClient: (options) => new FakeClient(options),
    });

    try {
      await registry.handleHostRequest(
        {
          type: "subagent.run",
          request: { ...runRequest(), persistSession: true, sessionFile, task: "Inspect the renderer tree" },
        },
        () => undefined,
      );

      expect(summaries[0]).toMatchObject({
        id: "child-thread",
        title: "Inspect the renderer tree",
        running: true,
        parentThreadId: "direct-parent-thread",
        agentName: "worker",
      });
      expect(summaries.at(-1)).toMatchObject({ id: "child-thread", running: false });
      expect(registry.listThreads("project")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists child metadata before terminal acknowledgement, owner removal, and resync", async () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-metadata-barrier-"));
    const sessionFile = join(directory, "child.jsonl");
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "durable-child",
        timestamp: "2026-01-02T03:04:05.000Z",
        cwd: process.cwd(),
      })}\n`,
    );
    let releaseWorker!: () => void;
    const workerPending = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let releaseMetadata!: () => void;
    const metadataPending = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    let client: FakeClient | undefined;
    const persisted: string[] = [];
    const resyncs: string[] = [];
    const summaries: string[] = [];
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      catalogChanged: (summary) => summaries.push(summary.title),
      persistSession: async (_projectId, persistedFile, summary) => {
        persisted.push(`${persistedFile}:${summary.running ? "running" : "stopped"}`);
        await metadataPending;
      },
      resync: (_projectId, threadId) => resyncs.push(threadId),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        client.run = workerPending.then(() => ({ status: "completed" }));
        client.bootstrapResult = subagentBootstrap("durable-child");
        return client;
      },
    });

    try {
      const run = registry.handleHostRequest(
        {
          type: "subagent.run",
          request: {
            ...runRequest(),
            persistSession: true,
            sessionFile,
            task: "[Read from: plan.md]\n\nInspect the durable child",
          },
        },
        () => undefined,
      );
      await expect.poll(() => client).toBeDefined();
      client?.emitSidecarEvent(event(client.instanceId, 1, { type: "started", runId: "run-1" }));
      await expect.poll(() => persisted.length).toBe(1);
      expect(summaries[0]).toBe("Inspect the durable child");
      expect(client?.acknowledgements).toEqual([1]);

      client?.emitSidecarEvent(event(client.instanceId, 2, { type: "completed", runId: "run-1", sessionFile }));
      releaseWorker();
      await Promise.resolve();
      expect(client?.acknowledgements).toEqual([1]);
      expect(registry.isActiveThread("project", "durable-child")).toBe(true);
      expect(resyncs).toEqual([]);

      releaseMetadata();
      await expect(run).resolves.toEqual({ status: "completed" });
      expect(persisted).toEqual([`${sessionFile}:running`, `${sessionFile}:stopped`]);
      expect(client?.acknowledgements).toEqual([1, 2]);
      expect(registry.isActiveThread("project", "durable-child")).toBe(false);
      expect(resyncs).toEqual(["durable-child"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks ordinary handoff when terminal metadata persistence fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-metadata-failure-"));
    const sessionFile = join(directory, "child.jsonl");
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "blocked-child",
        timestamp: "2026-01-02T03:04:05.000Z",
        cwd: process.cwd(),
      })}\n`,
    );
    let releaseWorker!: () => void;
    const workerPending = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let client: FakeClient | undefined;
    let persistenceCount = 0;
    const resyncs: string[] = [];
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      persistSession: async () => {
        persistenceCount += 1;
        if (persistenceCount === 2) throw new Error("metadata unavailable");
      },
      resync: (_projectId, threadId) => resyncs.push(threadId),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        client.run = workerPending.then(() => ({ status: "completed" }));
        client.bootstrapResult = subagentBootstrap("blocked-child");
        return client;
      },
    });

    try {
      const run = registry.handleHostRequest(
        { type: "subagent.run", request: { ...runRequest(), persistSession: true, sessionFile } },
        () => undefined,
      );
      await expect.poll(() => client).toBeDefined();
      client?.emitSidecarEvent(event(client.instanceId, 1, { type: "started", runId: "run-1" }));
      await expect.poll(() => persistenceCount).toBe(1);
      client?.emitSidecarEvent(event(client.instanceId, 2, { type: "completed", runId: "run-1", sessionFile }));
      releaseWorker();

      await expect(run).rejects.toThrow("metadata unavailable");
      expect(client?.acknowledgements).toEqual([1, 2]);
      expect(client?.shutdownCount).toBe(1);
      expect(registry.isActiveThread("project", "blocked-child")).toBe(true);
      expect(registry.listThreads("project")).toEqual([
        expect.objectContaining({ id: "blocked-child", running: false }),
      ]);
      expect(resyncs).toEqual([]);
      await expect(registry.attach("project", "blocked-child")).rejects.toThrow("handoff is blocked");

      await registry.cancelThread("project", "thread");
      expect(registry.isActiveThread("project", "blocked-child")).toBe(true);
      expect(resyncs).toEqual([]);
      await registry.dispose();
      expect(registry.isActiveThread("project", "blocked-child")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries catalog projection after a fresh child session file materializes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-late-session-file-"));
    const sessionFile = join(directory, "child.jsonl");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let client: FakeClient | undefined;
    const summaries: Array<{ id: string; running: boolean; messageCount: number }> = [];
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      catalogChanged: (summary) => summaries.push(summary),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        client.run = pending.then(() => ({ status: "completed" }));
        return client;
      },
    });

    try {
      const run = registry.handleHostRequest(
        { type: "subagent.run", request: { ...runRequest(), persistSession: true } },
        () => undefined,
      );
      await expect.poll(() => client).toBeDefined();
      client?.emitSidecarEvent(event(client.instanceId, 1, { type: "started", runId: "run-1", sessionFile }));
      expect(summaries).toEqual([]);

      writeFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: "late-child",
          timestamp: "2026-01-02T03:04:05.000Z",
          cwd: process.cwd(),
        })}\n`,
      );
      client?.emitSidecarEvent(
        event(client.instanceId, 2, {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        }),
      );
      client?.emitSidecarEvent(event(client.instanceId, 3, { type: "completed", runId: "run-1" }));

      expect(summaries).toEqual([
        expect.objectContaining({ id: "late-child", running: true, messageCount: 1 }),
        expect.objectContaining({ id: "late-child", running: false, messageCount: 1 }),
      ]);
      release();
      await run;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("attaches to the active subagent owner and routes live delivery acknowledgements", async () => {
    const directory = mkdtempSync(join(tmpdir(), "subagent-attach-"));
    const sessionFile = join(directory, "child.jsonl");
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "live-child",
        timestamp: "2026-01-02T03:04:05.000Z",
        cwd: process.cwd(),
      })}\n`,
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let client: FakeClient | undefined;
    const pushed: SessionPushPayload[] = [];
    const resyncs: string[] = [];
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      push: (payload) => pushed.push(payload),
      resync: (_projectId, threadId) => resyncs.push(threadId),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        client.run = pending.then(() => ({ status: "completed" }));
        client.bootstrapResult = subagentBootstrap("live-child");
        return client;
      },
    });

    try {
      const run = registry.handleHostRequest(
        { type: "subagent.run", request: { ...runRequest(), persistSession: true, sessionFile } },
        () => undefined,
      );
      await expect.poll(() => client).toBeDefined();
      client?.emitSidecarEvent(event(client.instanceId, 1, { type: "started", runId: "run-1" }));

      await expect(registry.attach("project", "live-child")).resolves.toMatchObject({
        threadId: "live-child",
        control: { interaction: "read-only" },
      });
      expect(registry.isActiveThread("project", "live-child")).toBe(true);

      const payload = subagentBootstrap("live-child").control;
      client?.emitSidecarEvent({
        kind: "event",
        protocolVersion: 3,
        workerInstanceId: client.instanceId,
        sequence: 2,
        creditCost: 1,
        event: {
          type: "session-push",
          payload: { type: "control", projectId: "project", threadId: "live-child", control: payload },
        },
      });
      expect(pushed).toHaveLength(1);
      expect(client?.acknowledgements).toEqual([1]);
      expect(registry.acknowledge(client!.instanceId, 2)).toBe(true);
      expect(client?.acknowledgements).toEqual([1, 2]);

      release();
      await run;
      expect(registry.isActiveThread("project", "live-child")).toBe(false);
      expect(resyncs).toContain("live-child");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cancels Main-owned children when their parent thread fails", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let client: FakeClient | undefined;
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        client.run = pending.then(() => ({ status: "completed" }));
        return client;
      },
    });
    const run = registry.handleHostRequest({ type: "subagent.run", request: runRequest() }, () => undefined);
    await Promise.resolve();

    await registry.cancelThread("project", "thread");
    expect(client?.commandTypes).not.toContain("subagentCancel");
    expect(client?.shutdownCount).toBe(1);
    release();
    await run;
  });

  it("owns parallel children independently and enforces per-thread capacity", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clients: FakeClient[] = [];
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      maxWorkersPerThread: 2,
      createWorkerClient: (options) => {
        const client = new FakeClient(options);
        client.run = pending.then(() => ({ status: "completed" }));
        clients.push(client);
        return client;
      },
    });

    const first = registry.handleHostRequest(
      { type: "subagent.run", request: runRequest("parallel", 0) },
      () => undefined,
    );
    const second = registry.handleHostRequest(
      { type: "subagent.run", request: runRequest("parallel", 1) },
      () => undefined,
    );
    await Promise.resolve();
    await expect(
      registry.handleHostRequest({ type: "subagent.run", request: runRequest("parallel", 2) }, () => undefined),
    ).rejects.toThrow("limit reached for this thread (2)");
    expect(clients).toHaveLength(2);

    release();
    await Promise.all([first, second]);
    expect(clients.every(({ shutdownCount }) => shutdownCount === 1)).toBe(true);
  });

  it("authorizes only direct nested descendants of a fanout worker", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clients: FakeClient[] = [];
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => {
        const client = new FakeClient(options);
        if (clients.length === 0) client.run = pending.then(() => ({ status: "completed" }));
        clients.push(client);
        return client;
      },
    });
    const parentRequest: SubagentRunRequest = {
      ...runRequest("root", 0),
      maxDepth: 2,
      extensionProfile: ["provider", "memory", "runtime", "fanout"],
    };
    const parentRun = registry.handleHostRequest({ type: "subagent.run", request: parentRequest }, () => undefined);
    await Promise.resolve();

    const nestedRequest: SubagentRunRequest = {
      ...runRequest("nested", 0),
      rootRunId: "root",
      depth: 2,
      maxDepth: 2,
      lineage: [{ runId: "root", childIndex: 0 }],
    };
    await expect(clients[0]?.hostRequest({ type: "subagent.run", request: nestedRequest })).resolves.toEqual({
      status: "completed",
    });
    await expect(
      clients[0]?.hostRequest({
        type: "subagent.run",
        request: { ...nestedRequest, runId: "forged", lineage: [] },
      }),
    ).rejects.toThrow("lineage does not match");
    expect(clients).toHaveLength(2);

    release();
    await parentRun;
  });

  it("reports an abnormal worker exit as a child failure without rejecting the parent host call", async () => {
    let rejectRun!: (error: Error) => void;
    const workerRun = new Promise<unknown>((_resolve, reject) => {
      rejectRun = reject;
    });
    let client: FakeClient | undefined;
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        client.run = workerRun;
        return client;
      },
    });
    const events: SubagentRunEvent[] = [];
    const run = registry.handleHostRequest({ type: "subagent.run", request: runRequest("oom-review", 0) }, (event) =>
      events.push(event),
    );
    await expect.poll(() => client).toBeDefined();

    const failure = new Error("Sidecar exited (134): JavaScript heap out of memory");
    client?.crash(failure);
    rejectRun(failure);

    await expect(run).resolves.toEqual({ status: "failed", error: failure.message });
    expect(events).toEqual([{ type: "failed", runId: "oom-review", error: failure.message }]);
    expect(client?.shutdownCount).toBe(1);
  });

  it("fails a run when its event stream requires resynchronization", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let client: FakeClient | undefined;
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => {
        client = new FakeClient(options);
        client.run = pending.then(() => ({ status: "completed" }));
        return client;
      },
    });
    const run = registry.handleHostRequest({ type: "subagent.run", request: runRequest() }, () => undefined);
    await Promise.resolve();
    client?.emitSidecarEvent({
      kind: "event",
      protocolVersion: 3,
      workerInstanceId: client.instanceId,
      sequence: 1,
      creditCost: 0,
      event: { type: "resync-required", reason: "overflow", lastSafeSequence: 0 },
    });
    release();

    await expect(run).rejects.toThrow("requires resync");
    expect(client?.failure?.message).toContain("overflow");
  });

  it("rejects requests whose maximum depth is below their current depth", async () => {
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => new FakeClient(options),
    });

    await expect(
      registry.handleHostRequest(
        { type: "subagent.run", request: { ...runRequest(), depth: 2, maxDepth: 1 } },
        () => undefined,
      ),
    ).rejects.toThrow("depth and lineage must be valid");
  });

  it("rejects duplicate active run identities", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let count = 0;
    const registry = new SubagentWorkerRegistry({
      manifest: manifest(),
      agentDir: process.cwd(),
      createWorkerClient: (options) => {
        const client = new FakeClient(options);
        if (count++ === 0) client.run = pending.then(() => ({ status: "completed" }));
        return client;
      },
    });
    const first = registry.handleHostRequest({ type: "subagent.run", request: runRequest() }, () => undefined);
    await Promise.resolve();
    await expect(
      registry.handleHostRequest({ type: "subagent.run", request: runRequest() }, () => undefined),
    ).rejects.toThrow("Duplicate subagent run");
    release();
    await first;
  });
});
