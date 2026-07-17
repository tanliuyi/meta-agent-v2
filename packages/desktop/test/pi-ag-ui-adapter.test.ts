import { EventType, type RunAgentInput } from "@ag-ui/core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { piMessageId } from "../src/main/pi/message-projector.ts";
import { PiAgUiAdapter } from "../src/main/pi/pi-ag-ui-adapter.ts";
import {
  CONSUMED_USER_MESSAGE_EVENT,
  type SessionEventBatch,
  type SessionToolUpdate,
} from "../src/shared/contracts.ts";

describe("PiAgUiAdapter", () => {
  it("按标准顺序映射 text、reasoning、tool 和最终快照", () => {
    vi.useFakeTimers();
    const session = createSession();
    const batches: SessionEventBatch[] = [];
    const tools: SessionToolUpdate[] = [];
    const adapter = new PiAgUiAdapter({
      projectId: "project",
      session,
      onEvents: (batch) => batches.push(batch),
      onTool: (update) => tools.push(update),
    });
    adapter.start(runInput());
    const assistant = createAssistant();
    session.messages.push(assistant);
    adapter.handle({ type: "message_start", message: assistant });
    adapter.handle(messageUpdate(assistant, { type: "thinking_start", contentIndex: 0, partial: assistant }));
    adapter.handle(
      messageUpdate(assistant, { type: "thinking_delta", contentIndex: 0, delta: "分析", partial: assistant }),
    );
    adapter.handle(
      messageUpdate(assistant, { type: "thinking_end", contentIndex: 0, content: "分析", partial: assistant }),
    );
    adapter.handle(messageUpdate(assistant, { type: "text_start", contentIndex: 1, partial: assistant }));
    adapter.handle(
      messageUpdate(assistant, { type: "text_delta", contentIndex: 1, delta: "完成", partial: assistant }),
    );
    adapter.handle(
      messageUpdate(assistant, { type: "text_end", contentIndex: 1, content: "完成", partial: assistant }),
    );
    adapter.handle({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: true,
    });
    adapter.handle({ type: "agent_settled" });

    const events = batches.flatMap((batch) => batch.events.map(({ event }) => event));
    expect(events.map(({ type }) => type)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_RESULT,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    expect(tools.at(-1)).toEqual({ toolCallId: "tool-1", status: "error", result: "ok" });
    expect(events.at(-2)?.type).toBe(EventType.MESSAGES_SNAPSHOT);
    vi.useRealTimers();
  });

  it("pi 消费尚未写入 history 的排队 user message 时发送插入事件", () => {
    const session = createSession();
    const batches: SessionEventBatch[] = [];
    const adapter = new PiAgUiAdapter({
      projectId: "project",
      session,
      onEvents: (batch) => batches.push(batch),
      onTool: () => {},
    });
    adapter.start(runInput());
    adapter.handle({ type: "message_start", message: session.messages[0]! });
    adapter.handle({ type: "queue_update", steering: ["排队消息"], followUp: [] });
    adapter.handle({ type: "queue_update", steering: [], followUp: [] });

    const queued: Extract<AgentSession["messages"][number], { role: "user" }> = {
      role: "user",
      content: "排队消息",
      timestamp: 2,
    };
    adapter.handle({ type: "message_start", message: queued });

    const events = batches.flatMap((batch) => batch.events.map(({ event }) => event));
    expect(events.filter(({ type }) => type === EventType.CUSTOM)).toEqual([
      {
        type: EventType.CUSTOM,
        name: CONSUMED_USER_MESSAGE_EVENT,
        value: { id: "thread:2:1", role: "user", content: "排队消息" },
      },
    ]);
  });

  it("agent_end 在 retry 边界不会提前结束 run", () => {
    const session = createSession();
    const batches: SessionEventBatch[] = [];
    const adapter = new PiAgUiAdapter({
      projectId: "project",
      session,
      onEvents: (batch) => batches.push(batch),
      onTool: () => {},
    });
    adapter.start(runInput());
    adapter.handle({ type: "agent_end", messages: [], willRetry: true });
    adapter.handle({ type: "agent_end", messages: [], willRetry: false });
    expect(adapter.activeRunBootstrap).toBeDefined();
    adapter.handle({ type: "agent_settled" });
    expect(batches.flatMap((batch) => batch.events).at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
  });

  it("provider 错误在 agent_settled 时产生 RUN_ERROR 并保留错误快照", () => {
    const session = createSession();
    const batches: SessionEventBatch[] = [];
    const adapter = new PiAgUiAdapter({
      projectId: "project",
      session,
      onEvents: (batch) => batches.push(batch),
      onTool: () => {},
    });
    adapter.start(runInput());
    const failure = {
      ...createAssistant(),
      content: [{ type: "text" as const, text: "" }],
      stopReason: "error" as const,
      errorMessage: "provider unavailable",
    };
    session.messages.push(failure);
    adapter.handle({ type: "message_start", message: { ...failure } });
    adapter.handle({ type: "message_end", message: failure });
    adapter.handle({ type: "agent_settled" });

    const events = batches.flatMap((batch) => batch.events.map(({ event }) => event));
    const snapshot = events.find((event) => event.type === EventType.MESSAGES_SNAPSHOT);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: "provider unavailable" });
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
    expect(snapshot?.messages.at(-1)).toMatchObject({ role: "assistant", content: "provider unavailable" });
  });

  it("同毫秒 assistant 浅拷贝使用各自的 session 索引", () => {
    const session = createSession();
    const first = createAssistant(2);
    session.messages.push(first);
    const firstId = piMessageId(session, { ...first });
    const second = createAssistant(2);
    session.messages.push(second);
    const secondId = piMessageId(session, { ...second });

    expect(firstId).toBe("thread:2:1");
    expect(secondId).toBe("thread:2:2");
  });

  it("压缩 active run replay，但不把历史消息放入每个 delta", () => {
    const session = createSession();
    const adapter = new PiAgUiAdapter({ projectId: "project", session, onEvents: () => {}, onTool: () => {} });
    adapter.start(runInput());
    const assistant = createAssistant();
    session.messages.push(assistant);
    adapter.handle({ type: "message_start", message: assistant });
    for (let index = 0; index < 1_000; index += 1) {
      adapter.handle(messageUpdate(assistant, { type: "text_delta", contentIndex: 1, delta: "x", partial: assistant }));
    }
    const bootstrap = adapter.activeRunBootstrap;
    expect(bootstrap?.messages).toHaveLength(1);
    expect(bootstrap?.events.length).toBeLessThan(10);
    const content = bootstrap?.events.find(({ type }) => type === EventType.TEXT_MESSAGE_CONTENT);
    expect(content && "delta" in content ? content.delta : "").toHaveLength(1_000);
  });
});

function createSession(): AgentSession {
  return {
    sessionId: "thread",
    messages: [{ role: "user", content: "问题", timestamp: 1 }],
  } as unknown as AgentSession;
}

function createAssistant(timestamp = 2): Extract<AgentSession["messages"][number], { role: "assistant" }> {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "分析" },
      { type: "text", text: "完成" },
    ],
    timestamp,
    stopReason: "stop",
    api: "openai-responses",
    provider: "openai",
    model: "faux",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function runInput(): RunAgentInput {
  return {
    threadId: "thread",
    runId: "run",
    state: {},
    messages: [{ id: "user", role: "user", content: "问题" }],
    tools: [],
    context: [],
    forwardedProps: {},
  };
}

function messageUpdate(
  message: AgentSession["messages"][number],
  assistantMessageEvent: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
): Extract<AgentSessionEvent, { type: "message_update" }> {
  return { type: "message_update", message, assistantMessageEvent };
}
