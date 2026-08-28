import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSupervisor } from "../src/main/pi/session-supervisor.ts";
import type { ThreadWorkerRegistry } from "../src/main/sidecar/thread-worker-registry.ts";
import type { ProjectStore } from "../src/main/store/project-store.ts";
import type { SessionAttachInput, SessionBootstrap, SessionPush, SessionPushPayload } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

interface RegistryMock {
  value: ThreadWorkerRegistry;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  readImageResource: ReturnType<typeof vi.fn>;
}

describe("SessionSupervisor attachment leases", () => {
  let workers: RegistryMock;

  beforeEach(() => {
    workers = registryMock();
  });

  it("validates and canonicalizes a selected worktree before worker creation", async () => {
    const resolveWorktree = vi.fn(async () => "/canonical/worktree");
    const supervisor = new SessionSupervisor(projectStore(resolveWorktree), workers.value);

    await supervisor.create({
      projectId: "project",
      worktreePath: "/candidate/worktree",
      createRequestId: "create",
      extensionSetGeneration: "extensions-generation",
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
    });

    expect(resolveWorktree).toHaveBeenCalledWith("project", "/candidate/worktree");
    expect(workers.create).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: "/canonical/worktree" }));
    await supervisor.dispose();
  });

  it("loads draft configuration from a validated worktree", async () => {
    const resolveSessionCwd = vi.fn(async () => "/canonical/worktree");
    const supervisor = new SessionSupervisor(projectStore(undefined, resolveSessionCwd), workers.value);

    await supervisor.getDraftConfig("project", "/candidate/worktree");

    expect(resolveSessionCwd).toHaveBeenCalledWith("project", "/candidate/worktree");
    expect(workers.value.getDraftConfig).toHaveBeenCalledWith("project", "/canonical/worktree");
    await supervisor.dispose();
  });

  it("keeps independent A/B leases for one renderer window and routes pushes by identity", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const aPush = vi.fn<(update: SessionPush) => void>();
    const bPush = vi.fn<(update: SessionPush) => void>();
    const a = await supervisor.attach(1, input("a", "request-a"), aPush);
    const b = await supervisor.attach(1, input("b", "request-b"), bPush);

    receive(supervisor, controlPush("a"), "worker-a", 1);
    receive(supervisor, controlPush("b"), "worker-b", 1);

    expect(aPush).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: a.attachmentId, threadId: "a" }));
    expect(bPush).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: b.attachmentId, threadId: "b" }));
    expect(aPush).toHaveBeenCalledTimes(1);
    expect(bPush).toHaveBeenCalledTimes(1);
    await supervisor.dispose();
  });

  it("reuses sidecar JSON length for exact timeline delivery accounting", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const send = vi.fn<(update: SessionPush) => void>();
    await supervisor.attach(1, input("thread", "request"), send);
    const payload = timelinePush("thread");

    supervisor.receive(payload, "worker", 7, JSON.stringify(payload).length);

    const delivered = send.mock.calls[0]?.[0];
    if (!delivered) throw new Error("Expected a timeline delivery");
    const { deliveryBytes, ...withoutAccounting } = delivered;
    expect(deliveryBytes).toBe(JSON.stringify(withoutAccounting).length * 2);
    await supervisor.dispose();
  });

  it("does not stringify timeline payloads when the sidecar supplied their length", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const send = vi.fn<(update: SessionPush) => void>();
    await supervisor.attach(1, input("thread", "request"), send);
    const payload = timelinePush("thread");
    const payloadJsonLength = JSON.stringify(payload).length;
    Object.defineProperty(payload.event, "toJSON", {
      value: () => {
        throw new Error("timeline payload was stringified again");
      },
    });

    expect(() => supervisor.receive(payload, "worker", 7, payloadJsonLength)).not.toThrow();
    expect(send).toHaveBeenCalledOnce();
    await supervisor.dispose();
  });

  it("registers the lease before bootstrap so concurrent worker events are not lost", async () => {
    let resolveBootstrap!: (value: { bootstrap: SessionBootstrap; workerInstanceId: string }) => void;
    workers.attach.mockImplementation(
      (_projectId: string, threadId: string) =>
        new Promise<{ bootstrap: SessionBootstrap; workerInstanceId: string }>((resolve) => {
          resolveBootstrap = resolve;
          expect(threadId).toBe("thread");
        }),
    );
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const send = vi.fn<(update: SessionPush) => void>();
    const attaching = supervisor.attach(1, input("thread", "request"), send);
    await vi.waitFor(() => expect(workers.attach).toHaveBeenCalled());

    receive(supervisor, timelinePush("thread"), "subagent-worker", 4);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread", workerInstanceId: "subagent-worker", sidecarSequence: 4 }),
    );

    resolveBootstrap({ bootstrap: bootstrap("thread"), workerInstanceId: "worker-bootstrap" });
    const attachment = await attaching;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: attachment.attachmentId }));
    supervisor.acknowledge(1, attachment.attachmentId, "subagent-worker", 4);
    expect(workers.acknowledge).toHaveBeenCalledWith("subagent-worker", 4);
    await supervisor.dispose();
  });

  it("rejects a duplicate first attach for one owner/session", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    await supervisor.attach(1, input("thread", "first"), vi.fn());
    await expect(supervisor.attach(1, input("thread", "duplicate"), vi.fn())).rejects.toThrow("already attached");
    await supervisor.dispose();
  });

  it("replaces only the supplied CAS lease and stale detach cannot remove the newer lease", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const firstPush = vi.fn<(update: SessionPush) => void>();
    const secondPush = vi.fn<(update: SessionPush) => void>();
    const first = await supervisor.attach(1, input("thread", "first"), firstPush);
    const second = await supervisor.attach(1, input("thread", "second", first.attachmentId), secondPush);

    supervisor.detach(1, first.attachmentId);
    receive(supervisor, controlPush("thread"), "worker", 1);

    expect(firstPush).not.toHaveBeenCalled();
    expect(secondPush).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: second.attachmentId }));
    expect(workers.detach).toHaveBeenCalledWith("project", "thread", "worker-1");
    await supervisor.dispose();
  });

  it("does not allow a stale replacement token to detach a current lease", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const first = await supervisor.attach(1, input("thread", "first"), vi.fn());
    const second = await supervisor.attach(1, input("thread", "second", first.attachmentId), vi.fn());

    await expect(supervisor.attach(1, input("thread", "stale", first.attachmentId), vi.fn())).rejects.toThrow("Stale");
    receive(supervisor, controlPush("thread"), "worker", 1);
    supervisor.acknowledge(1, second.attachmentId, "worker", 1);
    expect(workers.acknowledge).toHaveBeenCalledWith("worker", 1);
    await supervisor.dispose();
  });

  it("waits for every lease consumer before returning worker credit", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const one = await supervisor.attach(1, input("thread", "one"), vi.fn());
    const two = await supervisor.attach(2, input("thread", "two"), vi.fn());

    receive(supervisor, timelinePush("thread"), "worker", 8);
    supervisor.acknowledge(1, one.attachmentId, "worker", 8);
    expect(workers.acknowledge).not.toHaveBeenCalled();
    supervisor.acknowledge(2, two.attachmentId, "worker", 8);
    expect(workers.acknowledge).toHaveBeenCalledWith("worker", 8);
    await supervisor.dispose();
  });

  it("releases only the requesting renderer lease before closing the worker", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const firstPush = vi.fn<(update: SessionPush) => void>();
    const secondPush = vi.fn<(update: SessionPush) => void>();
    await supervisor.attach(1, input("thread", "one"), firstPush);
    await supervisor.attach(2, input("thread", "two"), secondPush);

    await supervisor.close(1, "project", "thread");
    receive(supervisor, controlPush("thread"), "worker", 1);

    expect(workers.detach).toHaveBeenCalledTimes(1);
    expect(workers.close).toHaveBeenCalledWith("project", "thread");
    expect(firstPush).not.toHaveBeenCalled();
    expect(secondPush).toHaveBeenCalledOnce();
    await supervisor.dispose();
  });

  it("removes every owner lease on window teardown", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    await supervisor.attach(1, input("a", "a"), vi.fn());
    await supervisor.attach(1, input("b", "b"), vi.fn());
    supervisor.detachAll(1);
    receive(supervisor, controlPush("a"), "worker", 1);
    expect(workers.detach).toHaveBeenCalledTimes(2);
    expect(workers.acknowledge).toHaveBeenCalledWith("worker", 1);
    await supervisor.dispose();
  });

  it("reads image resources only under the caller's active attachment lease", async () => {
    const readImageResource = vi.fn(async () => ({
      resourceId: "resource-1",
      mimeType: "image/png",
      data: "abc",
    }));
    workers.readImageResource = readImageResource;
    workers.value.readImageResource = readImageResource;
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const attachment = await supervisor.attach(1, input("thread", "request"), () => {});

    await expect(supervisor.readImageResource(1, attachment.attachmentId, "resource-1")).resolves.toEqual({
      resourceId: "resource-1",
      mimeType: "image/png",
      data: "abc",
    });
    expect(readImageResource).toHaveBeenCalledWith("project", "thread", "resource-1");

    await expect(supervisor.readImageResource(1, "stale-attachment", "resource-1")).rejects.toThrow(
      "Session attachment is not active",
    );
    await expect(supervisor.readImageResource(2, attachment.attachmentId, "resource-1")).rejects.toThrow(
      "Session attachment is not active",
    );
    await supervisor.dispose();
  });
});

function receive(
  supervisor: SessionSupervisor,
  payload: SessionPushPayload,
  workerInstanceId: string,
  sidecarSequence: number,
): void {
  supervisor.receive(payload, workerInstanceId, sidecarSequence, JSON.stringify(payload).length);
}

function input(threadId: string, requestId: string, replaceAttachmentId?: string): SessionAttachInput {
  return { projectId: "project", threadId, requestId, ...(replaceAttachmentId ? { replaceAttachmentId } : {}) };
}

function registryMock(): RegistryMock {
  let generation = 0;
  const attach = vi.fn(async (_projectId: string, threadId: string) => {
    generation += 1;
    return { bootstrap: bootstrap(threadId), workerInstanceId: `worker-${generation}` };
  });
  const detach = vi.fn();
  const acknowledge = vi.fn();
  const create = vi.fn(async () => bootstrap("created"));
  const close = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const readImageResource = vi.fn(async () => undefined);
  return {
    attach,
    detach,
    acknowledge,
    create,
    close,
    dispose,
    readImageResource,
    value: {
      list: vi.fn(async () => []),
      getDraftConfig: vi.fn(),
      create,
      attach,
      detach,
      acknowledge,
      close,
      dispose,
      readImageResource,
    } as unknown as ThreadWorkerRegistry,
  };
}

function projectStore(
  resolveWorktree = vi.fn(async (_projectId: string, candidate: string) => candidate),
  resolveSessionCwd = vi.fn(async (_projectId: string, candidate: string) => candidate),
): ProjectStore {
  return {
    isArchived: () => false,
    getCwd: () => "/workspace",
    resolveWorktree,
    resolveSessionCwd,
  } as unknown as ProjectStore;
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
      thinkingLevel: "off",
    },
    events: [],
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: "project",
      threadId,
      title: threadId,
      updatedAt: 0,
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

function controlPush(threadId: string) {
  return { type: "control" as const, projectId: "project", threadId, control: bootstrap(threadId).control };
}

function timelinePush(threadId: string) {
  return {
    type: "timeline" as const,
    projectId: "project",
    threadId,
    sequence: 1,
    event: { type: "agent_start" as const },
  };
}
