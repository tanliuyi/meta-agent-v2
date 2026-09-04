import { describe, expect, it, vi } from "vitest";
import type { SessionSupervisor } from "../src/main/pi/session-supervisor.ts";
import { SessionEventRouter } from "../src/main/session/session-event-router.ts";
import type { SessionPushPayload } from "../src/shared/contracts.ts";

const payload = { type: "session", event: {} } as unknown as SessionPushPayload;

describe("SessionEventRouter", () => {
  it("acks through the originating registry before supervisor binding", () => {
    const acknowledgeThread = vi.fn();
    const acknowledgeSubagent = vi.fn();
    const router = new SessionEventRouter({
      publishCatalogChanged: vi.fn(),
    });
    router.bindThreadAcknowledger(acknowledgeThread);
    router.bindSubagentAcknowledger(acknowledgeSubagent);

    router.threadEvent(payload, "thread-worker", 1);
    router.subagentEvent(payload, "subagent-worker", 2);

    expect(acknowledgeThread).toHaveBeenCalledWith("thread-worker", 1);
    expect(acknowledgeSubagent).toHaveBeenCalledWith("subagent-worker", 2);
  });

  it("forwards events and lifecycle failures after supervisor binding", () => {
    const supervisor = {
      receive: vi.fn(),
      workerFailed: vi.fn(),
      resyncRequired: vi.fn(),
    } as unknown as SessionSupervisor;
    const router = new SessionEventRouter({
      publishCatalogChanged: vi.fn(),
    });

    router.bindSupervisor(supervisor);
    router.threadEvent(payload, "worker", 7);
    router.subagentEvent(payload, "worker", 8);
    router.workerFailed("project", "thread", new Error("failed"));
    router.resyncRequired("project", "thread", "gap");

    expect(supervisor.receive).toHaveBeenNthCalledWith(1, payload, "worker", 7);
    expect(supervisor.receive).toHaveBeenNthCalledWith(2, payload, "worker", 8);
    expect(supervisor.workerFailed).toHaveBeenCalledWith("project", "thread", expect.any(Error));
    expect(supervisor.resyncRequired).toHaveBeenCalledWith("project", "thread", "gap");
  });

  it("rejects a second supervisor binding", () => {
    const router = new SessionEventRouter({
      publishCatalogChanged: vi.fn(),
    });
    const supervisor = {} as SessionSupervisor;

    router.bindSupervisor(supervisor);

    expect(() => router.bindSupervisor(supervisor)).toThrow("already bound");
  });
});
