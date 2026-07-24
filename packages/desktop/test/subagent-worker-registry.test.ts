import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NodeRuntimeManifest } from "../src/main/sidecar/node-runtime-locator.ts";
import { type SubagentWorkerClient, SubagentWorkerRegistry } from "../src/main/sidecar/subagent-worker-registry.ts";
import { assertHostRequestIdentity } from "../src/main/sidecar/thread-worker-registry.ts";
import type { WorkerClientOptions } from "../src/main/sidecar/worker-client.ts";
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
    return null as T;
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
