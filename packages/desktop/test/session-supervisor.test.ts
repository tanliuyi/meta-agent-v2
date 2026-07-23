import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSupervisor } from "../src/main/pi/session-supervisor.ts";
import type { ThreadWorkerRegistry } from "../src/main/sidecar/thread-worker-registry.ts";
import type { ProjectStore } from "../src/main/store/project-store.ts";
import type { SessionAttachInput, SessionBootstrap, SessionPush } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

interface RegistryMock {
  value: ThreadWorkerRegistry;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

describe("SessionSupervisor attachment leases", () => {
  let workers: RegistryMock;

  beforeEach(() => {
    workers = registryMock();
  });

  it("keeps independent A/B leases for one renderer window and routes pushes by identity", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const aPush = vi.fn<(update: SessionPush) => void>();
    const bPush = vi.fn<(update: SessionPush) => void>();
    const a = await supervisor.attach(1, input("a", "request-a"), aPush);
    const b = await supervisor.attach(1, input("b", "request-b"), bPush);

    supervisor.receive(controlPush("a"), "worker-a", 1);
    supervisor.receive(controlPush("b"), "worker-b", 1);

    expect(aPush).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: a.attachmentId, threadId: "a" }));
    expect(bPush).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: b.attachmentId, threadId: "b" }));
    expect(aPush).toHaveBeenCalledTimes(1);
    expect(bPush).toHaveBeenCalledTimes(1);
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
    supervisor.receive(controlPush("thread"), "worker", 1);

    expect(firstPush).not.toHaveBeenCalled();
    expect(secondPush).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: second.attachmentId }));
    expect(workers.detach).toHaveBeenCalledWith("project", "thread");
    await supervisor.dispose();
  });

  it("does not allow a stale replacement token to detach a current lease", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const first = await supervisor.attach(1, input("thread", "first"), vi.fn());
    const second = await supervisor.attach(1, input("thread", "second", first.attachmentId), vi.fn());

    await expect(supervisor.attach(1, input("thread", "stale", first.attachmentId), vi.fn())).rejects.toThrow("Stale");
    supervisor.receive(controlPush("thread"), "worker", 1);
    supervisor.acknowledge(1, second.attachmentId, "worker", 1);
    expect(workers.acknowledge).toHaveBeenCalledWith("worker", 1);
    await supervisor.dispose();
  });

  it("waits for every lease consumer before returning worker credit", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    const one = await supervisor.attach(1, input("thread", "one"), vi.fn());
    const two = await supervisor.attach(2, input("thread", "two"), vi.fn());

    supervisor.receive(timelinePush("thread"), "worker", 8);
    supervisor.acknowledge(1, one.attachmentId, "worker", 8);
    expect(workers.acknowledge).not.toHaveBeenCalled();
    supervisor.acknowledge(2, two.attachmentId, "worker", 8);
    expect(workers.acknowledge).toHaveBeenCalledWith("worker", 8);
    await supervisor.dispose();
  });

  it("removes every owner lease on window teardown", async () => {
    const supervisor = new SessionSupervisor(projectStore(), workers.value);
    await supervisor.attach(1, input("a", "a"), vi.fn());
    await supervisor.attach(1, input("b", "b"), vi.fn());
    supervisor.detachAll(1);
    supervisor.receive(controlPush("a"), "worker", 1);
    expect(workers.detach).toHaveBeenCalledTimes(2);
    expect(workers.acknowledge).toHaveBeenCalledWith("worker", 1);
    await supervisor.dispose();
  });
});

function input(threadId: string, requestId: string, replaceAttachmentId?: string): SessionAttachInput {
  return { projectId: "project", threadId, requestId, ...(replaceAttachmentId ? { replaceAttachmentId } : {}) };
}

function registryMock(): RegistryMock {
  const attach = vi.fn(async (_projectId: string, threadId: string) => bootstrap(threadId));
  const detach = vi.fn();
  const acknowledge = vi.fn();
  const dispose = vi.fn(async () => {});
  return {
    attach,
    detach,
    acknowledge,
    dispose,
    value: {
      list: vi.fn(async () => []),
      getDraftConfig: vi.fn(),
      create: vi.fn(),
      attach,
      detach,
      acknowledge,
      dispose,
    } as unknown as ThreadWorkerRegistry,
  };
}

function projectStore(): ProjectStore {
  return { isArchived: () => false } as unknown as ProjectStore;
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
      extensionSet: { generation: "extensions-generation", diagnostics: [], reloadRequired: false },
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
    batch: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId,
      fromSequence: 1,
      toSequence: 1,
      events: [
        {
          protocolVersion: PROTOCOL_VERSION,
          projectId: "project",
          threadId,
          sequence: 1,
          event: { type: "queue-replaced" as const, items: [] },
        },
      ],
    },
  };
}
