import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiSessionBus } from "../src/renderer/src/runtime/pi-session-bus.ts";
import type { SessionBootstrap, SessionPushPayload } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

describe("PiSessionBus", () => {
  let push: ((update: SessionPushPayload) => void) | undefined;
  let attach: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    push = undefined;
    attach = vi.fn(async (projectId: string, threadId: string, listener: (update: SessionPushPayload) => void) => {
      push = listener;
      return bootstrap(projectId, threadId);
    });
    vi.stubGlobal("window", {
      setTimeout: (...arguments_: Parameters<typeof setTimeout>) => setTimeout(...arguments_),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
      desktop: {
        sessions: {
          attach,
          detach: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("转发所有 keyed control 供 catalog 更新，不把它写入 active timeline", async () => {
    const bus = new PiSessionBus();
    const listener = vi.fn();
    bus.onControl(listener);
    const attached = await bus.attach("project", "thread");
    expect(listener).not.toHaveBeenCalled();
    expect(bus.store.getSnapshot().threadId).toBe("");
    bus.commit(attached);
    expect(bus.store.getSnapshot().threadId).toBe("thread");
    listener.mockClear();

    push?.({
      type: "control",
      projectId: "other-project",
      threadId: "other-thread",
      control: { ...bootstrap().control, projectId: "other-project", threadId: "other-thread" },
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "other-project", threadId: "other-thread" }),
    );

    listener.mockClear();
    push?.({ type: "control", projectId: "project", threadId: "thread", control: bootstrap().control });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("切换 attachment 后忽略旧 generation 的延迟恢复与 in-flight resync", async () => {
    vi.useFakeTimers();
    const bus = new PiSessionBus();
    const initial = await bus.attach("project", "thread");
    bus.commit(initial);

    push?.({
      type: "runtime-availability",
      projectId: "project",
      threadId: "thread",
      availability: { state: "recovering", unknownOutcome: false },
    });
    bus.commit(bootstrap("new-project", "new-thread"));
    await vi.advanceTimersByTimeAsync(250);

    expect(attach).toHaveBeenCalledTimes(1);
    expect(bus.store.getSnapshot()).toMatchObject({ projectId: "new-project", threadId: "new-thread" });

    let resolveResync: ((value: SessionBootstrap) => void) | undefined;
    attach.mockImplementationOnce(
      (_projectId: string, _threadId: string, listener: (update: SessionPushPayload) => void) => {
        push = listener;
        return new Promise<SessionBootstrap>((resolve) => {
          resolveResync = resolve;
        });
      },
    );
    const resync = bus.resync("new-project", "new-thread");
    bus.commit(bootstrap("latest-project", "latest-thread"));
    resolveResync?.(bootstrap("new-project", "new-thread"));
    await resync;

    expect(bus.store.getSnapshot()).toMatchObject({ projectId: "latest-project", threadId: "latest-thread" });
  });

  it("新 attachment 正在 prepare 时不允许旧 session 启动恢复", async () => {
    vi.useFakeTimers();
    const bus = new PiSessionBus();
    const initial = await bus.attach("project", "thread");
    bus.commit(initial);
    push?.({
      type: "runtime-availability",
      projectId: "project",
      threadId: "thread",
      availability: { state: "recovering", unknownOutcome: false },
    });

    let resolveNext: ((value: SessionBootstrap) => void) | undefined;
    attach.mockImplementationOnce(
      (_projectId: string, _threadId: string, listener: (update: SessionPushPayload) => void) => {
        push = listener;
        return new Promise<SessionBootstrap>((resolve) => {
          resolveNext = resolve;
        });
      },
    );
    const pending = bus.attach("new-project", "new-thread");
    await vi.advanceTimersByTimeAsync(250);

    expect(attach).toHaveBeenCalledTimes(2);
    resolveNext?.(bootstrap("new-project", "new-thread"));
    const prepared = await pending;
    bus.commit(prepared);
    expect(bus.store.getSnapshot()).toMatchObject({ projectId: "new-project", threadId: "new-thread" });
  });

  it("新 attachment prepare 失败后恢复原 session 的 recovery eligibility", async () => {
    vi.useFakeTimers();
    const bus = new PiSessionBus();
    const initial = await bus.attach("project", "thread");
    bus.commit(initial);
    push?.({
      type: "runtime-availability",
      projectId: "project",
      threadId: "thread",
      availability: { state: "recovering", unknownOutcome: false },
    });

    let rejectNext: ((reason: Error) => void) | undefined;
    attach.mockImplementationOnce(
      (_projectId: string, _threadId: string, listener: (update: SessionPushPayload) => void) => {
        push = listener;
        return new Promise<SessionBootstrap>((_resolve, reject) => {
          rejectNext = reject;
        });
      },
    );
    const pending = bus.attach("new-project", "new-thread");
    await vi.advanceTimersByTimeAsync(250);
    expect(attach).toHaveBeenCalledTimes(2);

    rejectNext?.(new Error("attach failed"));
    await expect(pending).rejects.toThrow("attach failed");
    await vi.advanceTimersByTimeAsync(250);

    expect(attach).toHaveBeenCalledTimes(3);
    expect(attach).toHaveBeenLastCalledWith("project", "thread", expect.any(Function));
    expect(bus.store.getSnapshot()).toMatchObject({ projectId: "project", threadId: "thread" });
  });
});

function bootstrap(projectId = "project", threadId = "thread"): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId,
    threadId,
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId,
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
      projectId,
      threadId,
      title: "Thread",
      updatedAt: 0,
      cwd: "C:/workspace",
      running: false,
      queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionUi: { statuses: {}, workingVisible: true, editorRevision: 0, toolsExpanded: false, widgets: [] },
    },
  };
}
