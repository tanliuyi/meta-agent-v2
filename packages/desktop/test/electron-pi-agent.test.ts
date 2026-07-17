import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronPiAgent } from "../src/renderer/src/runtime/electron-pi-agent.ts";
import { sessionEventBus } from "../src/renderer/src/runtime/session-event-bus.ts";
import type { SessionBootstrap, SessionPushPayload } from "../src/shared/contracts.ts";
import { CONSUMED_USER_MESSAGE_EVENT, PROTOCOL_VERSION } from "../src/shared/contracts.ts";

const originalWindow = globalThis.window;

afterEach(() => {
  sessionEventBus.detach();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  vi.restoreAllMocks();
});

describe("ElectronPiAgent", () => {
  it("active run attach 在历史基线后 replay，且不会重新调用 main run", async () => {
    const run = vi.fn(async () => {});
    installWindow({ run });
    const replay: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "thread", runId: "canonical-run" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant", delta: "partial" },
    ];
    const agent = new ElectronPiAgent();
    await agent.attach({ ...bootstrap(3), activeRun: { runId: "canonical-run", events: replay } });
    const received: BaseEvent[] = [];
    agent.run(runInput()).subscribe({ next: (event) => received.push(event), error: () => {} });

    expect(agent.messages).toEqual(bootstrap(3).messages);
    expect(received).toEqual(replay);
    expect(run).not.toHaveBeenCalled();
    agent.cancelActive();
  });

  it("active run replay 到消费事件时才通知 renderer 插入 user message", async () => {
    installWindow({ run: vi.fn(async () => {}) });
    const consumed = { id: "queued", role: "user" as const, content: "排队消息" };
    const replay: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "thread", runId: "canonical-run" },
      { type: EventType.CUSTOM, name: CONSUMED_USER_MESSAGE_EVENT, value: consumed },
    ];
    const onConsumed = vi.fn();
    const agent = new ElectronPiAgent(undefined, onConsumed);
    await agent.attach({ ...bootstrap(2), activeRun: { runId: "canonical-run", events: replay } });
    agent.run(runInput()).subscribe({ error: () => {} });

    expect(onConsumed).toHaveBeenCalledWith(consumed);
    agent.cancelActive();
  });

  it("live 消费事件立即通知 renderer 插入 user message", async () => {
    let push: ((update: SessionPushPayload) => void) | undefined;
    installWindow({
      run: vi.fn(async () => {}),
      attach: async (_projectId, _threadId, listener) => {
        push = listener;
        return bootstrap(0);
      },
    });
    const attached = await sessionEventBus.attach("project", "thread");
    const onConsumed = vi.fn();
    const agent = new ElectronPiAgent(undefined, onConsumed);
    await agent.attach(attached);
    agent.run(runInput()).subscribe({ error: () => {} });
    const consumed = { id: "queued", role: "user" as const, content: "引导消息" };

    push?.(consumedUserPush(1, consumed));

    expect(onConsumed).toHaveBeenCalledWith(consumed);
    agent.cancelActive();
  });

  it("preload flush 在 replay 后交付 cursor 之后的 live delta", async () => {
    let push: ((update: SessionPushPayload) => void) | undefined;
    const continued = eventPush(4, "continued");
    const flush = vi.fn(() => push?.(continued));
    installWindow({
      run: vi.fn(async () => {}),
      flush,
      attach: async (_projectId, _threadId, listener) => {
        push = listener;
        return { ...bootstrap(3), activeRun: { runId: "canonical-run", events: replayEvents() } };
      },
    });
    const attached = await sessionEventBus.attach("project", "thread");
    const agent = new ElectronPiAgent();
    await agent.attach(attached);
    const received: BaseEvent[] = [];
    agent.run(runInput()).subscribe({ next: (event) => received.push(event), error: () => {} });

    expect(received).toEqual([...replayEvents(), continued.batch.events[0]?.event]);
    expect(flush).toHaveBeenCalledTimes(1);
    agent.cancelActive();
  });

  it("detach active run 只释放本地事件订阅，不调用 Pi cancel", async () => {
    const cancel = vi.fn(async () => {});
    const flush = vi.fn();
    installWindow({ cancel, flush });
    const agent = new ElectronPiAgent();
    await agent.attach({ ...bootstrap(3), activeRun: { runId: "canonical-run", events: replayEvents() } });
    const running = agent.runAgent(runInput());
    await vi.waitFor(() => expect(flush).toHaveBeenCalled());
    await agent.detach();
    await running;

    expect(cancel).not.toHaveBeenCalled();
    expect(agent.attachedSession).toBeUndefined();
  });

  it("sequence gap 触发 single-flight atomic reattach 并以 AbortError 结束本地流", async () => {
    let push: ((update: SessionPushPayload) => void) | undefined;
    const attach = vi
      .fn<Window["desktop"]["sessions"]["attach"]>()
      .mockImplementationOnce(async (_projectId, _threadId, listener) => {
        push = listener;
        return bootstrap(5);
      })
      .mockImplementationOnce(async () => bootstrap(9));
    installWindow({ run: vi.fn(async () => {}), attach });
    const initial = await sessionEventBus.attach("project", "thread");
    const agent = new ElectronPiAgent();
    await agent.attach(initial);
    const error = new Promise<unknown>((resolve) => agent.run(runInput()).subscribe({ error: resolve }));
    push?.(eventPush(7, "lost"));

    await expect(error).resolves.toMatchObject({ name: "AbortError" });
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("终态 snapshot 不进入 AG-UI 聚合器并在 run 完成后交给 canonical importer", async () => {
    let push: ((update: SessionPushPayload) => void) | undefined;
    installWindow({
      run: vi.fn(async () => {}),
      attach: async (_projectId, _threadId, listener) => {
        push = listener;
        return bootstrap(0);
      },
    });
    const attached = await sessionEventBus.attach("project", "thread");
    const onSnapshot = vi.fn();
    const agent = new ElectronPiAgent(onSnapshot);
    await agent.attach(attached);
    const received: BaseEvent[] = [];
    const completed = new Promise<void>((resolve) =>
      agent.run(runInput()).subscribe({ next: (event) => received.push(event), complete: resolve }),
    );
    push?.(terminalPush());
    await completed;

    expect(received.map(({ type }) => type)).toEqual([EventType.RUN_FINISHED]);
    expect(onSnapshot).toHaveBeenCalledWith([{ id: "user", role: "user", content: "question" }]);
    expect(agent.messages).toEqual([{ id: "user", role: "user", content: "question" }]);
  });

  it("畸形终态 snapshot 触发 resync 而不是进入 canonical importer", async () => {
    let push: ((update: SessionPushPayload) => void) | undefined;
    const attach = vi
      .fn<Window["desktop"]["sessions"]["attach"]>()
      .mockImplementationOnce(async (_projectId, _threadId, listener) => {
        push = listener;
        return bootstrap(0);
      })
      .mockImplementationOnce(async () => bootstrap(1));
    installWindow({ run: vi.fn(async () => {}), attach });
    const attached = await sessionEventBus.attach("project", "thread");
    const onSnapshot = vi.fn();
    const agent = new ElectronPiAgent(onSnapshot);
    await agent.attach(attached);
    const error = new Promise<unknown>((resolve) => agent.run(runInput()).subscribe({ error: resolve }));
    push?.(invalidSnapshotPush());

    await expect(error).resolves.toMatchObject({ name: "AbortError" });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(2);
  });
});

interface WindowOverrides {
  run?: Window["desktop"]["sessions"]["run"];
  attach?: Window["desktop"]["sessions"]["attach"];
  cancel?: Window["desktop"]["sessions"]["cancel"];
  flush?: Window["desktop"]["sessions"]["flush"];
}

function installWindow(overrides: WindowOverrides): void {
  const sessions = {
    run: overrides.run ?? (async () => {}),
    attach: overrides.attach ?? (async () => bootstrap(0)),
    cancel: overrides.cancel ?? (async () => {}),
    flush: overrides.flush ?? (() => {}),
    detach: () => {},
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { desktop: { sessions } },
  });
}

function bootstrap(cursor: number): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId: "thread",
    cursor,
    messages: [{ id: "user", role: "user", content: "question" }],
    state: {},
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: "project",
      threadId: "thread",
      title: "thread",
      cwd: "/workspace",
      running: true,
      compacting: false,
      queue: { steering: [], followUp: [] },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionUi: { statuses: {}, workingVisible: true, toolsExpanded: false, widgets: [] },
    },
  };
}

function runInput(): RunAgentInput {
  return {
    threadId: "thread",
    runId: "generated-run",
    state: {},
    messages: [{ id: "user", role: "user", content: "question" }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

function replayEvents(): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId: "thread", runId: "canonical-run" },
    { type: EventType.TEXT_MESSAGE_START, messageId: "assistant", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant", delta: "partial" },
  ];
}

function eventPush(cursor: number, delta: string): Extract<SessionPushPayload, { type: "events" }> {
  return {
    type: "events",
    projectId: "project",
    threadId: "thread",
    batch: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId: "thread",
      fromSequence: cursor,
      toSequence: cursor,
      events: [
        {
          protocolVersion: PROTOCOL_VERSION,
          projectId: "project",
          threadId: "thread",
          runId: "canonical-run",
          sequence: cursor,
          event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant", delta },
        },
      ],
    },
  };
}

function consumedUserPush(
  cursor: number,
  message: { id: string; role: "user"; content: string },
): Extract<SessionPushPayload, { type: "events" }> {
  return {
    type: "events",
    projectId: "project",
    threadId: "thread",
    batch: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId: "thread",
      fromSequence: cursor,
      toSequence: cursor,
      events: [
        {
          protocolVersion: PROTOCOL_VERSION,
          projectId: "project",
          threadId: "thread",
          runId: "generated-run",
          sequence: cursor,
          event: { type: EventType.CUSTOM, name: CONSUMED_USER_MESSAGE_EVENT, value: message },
        },
      ],
    },
  };
}

function terminalPush(): Extract<SessionPushPayload, { type: "events" }> {
  return {
    type: "events",
    projectId: "project",
    threadId: "thread",
    batch: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId: "thread",
      fromSequence: 1,
      toSequence: 2,
      events: [
        {
          protocolVersion: PROTOCOL_VERSION,
          projectId: "project",
          threadId: "thread",
          runId: "generated-run",
          sequence: 1,
          event: {
            type: EventType.MESSAGES_SNAPSHOT,
            messages: [{ id: "user", role: "user", content: "question" }],
          },
        },
        {
          protocolVersion: PROTOCOL_VERSION,
          projectId: "project",
          threadId: "thread",
          runId: "generated-run",
          sequence: 2,
          event: { type: EventType.RUN_FINISHED, threadId: "thread", runId: "generated-run" },
        },
      ],
    },
  };
}

function invalidSnapshotPush(): Extract<SessionPushPayload, { type: "events" }> {
  return {
    type: "events",
    projectId: "project",
    threadId: "thread",
    batch: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: "project",
      threadId: "thread",
      fromSequence: 1,
      toSequence: 1,
      events: [
        {
          protocolVersion: PROTOCOL_VERSION,
          projectId: "project",
          threadId: "thread",
          runId: "generated-run",
          sequence: 1,
          event: { type: EventType.MESSAGES_SNAPSHOT, messages: [{}] },
        },
      ],
    },
  };
}
