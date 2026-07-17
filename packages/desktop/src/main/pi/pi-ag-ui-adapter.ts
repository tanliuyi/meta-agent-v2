import { type BaseEvent, compactEvents, EventType, type Message, type RunAgentInput } from "@ag-ui/client";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  CONSUMED_USER_MESSAGE_EVENT,
  PROTOCOL_VERSION,
  type SessionEventBatch,
  type SessionEventEnvelope,
  type SessionToolUpdate,
} from "../../shared/contracts.ts";
import { piMessageId, projectMessages, projectUserMessage, resultText } from "./message-projector.ts";

interface AdapterOptions {
  projectId: string;
  session: AgentSession;
  onEvents(batch: SessionEventBatch): void;
  onTool(update: SessionToolUpdate): void;
}

interface ActiveRun {
  runId: string;
  baseline: Message[];
  events: BaseEvent[];
}

/** 将 Pi AgentSessionEvent 转为 AG-UI 标准事件和 Desktop tool override。 */
export class PiAgUiAdapter {
  private readonly projectId: string;
  private readonly session: AgentSession;
  private readonly onEvents: (batch: SessionEventBatch) => void;
  private readonly onTool: (update: SessionToolUpdate) => void;
  private activeRun?: ActiveRun;
  private sequence = 0;
  private pending: SessionEventEnvelope[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly pendingTools = new Map<string, SessionToolUpdate>();
  private toolTimer?: ReturnType<typeof setTimeout>;
  private assistantMessageId?: string;
  private terminalError?: string;
  private turn = 0;
  private queuedUserMessages: string[] = [];
  private consumedUserMessages: string[] = [];

  constructor(options: AdapterOptions) {
    this.projectId = options.projectId;
    this.session = options.session;
    this.onEvents = options.onEvents;
    this.onTool = options.onTool;
  }

  get currentSequence(): number {
    return this.sequence;
  }

  get activeRunBootstrap(): { runId: string; messages: Message[]; events: BaseEvent[] } | undefined {
    if (!this.activeRun) return undefined;
    return {
      runId: this.activeRun.runId,
      messages: this.activeRun.baseline,
      events: compactEvents(this.activeRun.events),
    };
  }

  start(input: RunAgentInput): void {
    if (this.activeRun) throw new Error("当前 Pi session 已有运行中的 AG-UI run");
    this.activeRun = { runId: input.runId, baseline: [...input.messages], events: [] };
    this.terminalError = undefined;
    this.turn = 0;
    this.queuedUserMessages = [];
    this.consumedUserMessages = [];
    this.emit({ type: EventType.RUN_STARTED, threadId: this.session.sessionId, runId: input.runId });
  }

  handle(event: AgentSessionEvent): void {
    if (event.type === "queue_update") {
      this.consumedUserMessages = removedMessages(this.queuedUserMessages, [...event.steering, ...event.followUp]);
      this.queuedUserMessages = [...event.steering, ...event.followUp];
      return;
    }
    if (event.type === "turn_start") {
      this.turn += 1;
      this.emit({ type: EventType.STEP_STARTED, stepName: `turn-${this.turn}` });
      return;
    }
    if (event.type === "turn_end") {
      this.emit({ type: EventType.STEP_FINISHED, stepName: `turn-${this.turn}` });
      return;
    }
    if (event.type === "message_start" && event.message.role === "user") {
      const text = userMessageText(event.message);
      const consumedIndex = this.consumedUserMessages.indexOf(text);
      if (consumedIndex === -1) return;
      this.consumedUserMessages.splice(consumedIndex, 1);
      this.emit(
        {
          type: EventType.CUSTOM,
          name: CONSUMED_USER_MESSAGE_EVENT,
          value: projectUserMessage(this.session, event.message),
        },
        true,
      );
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.assistantMessageId = piMessageId(this.session, event.message);
      return;
    }
    if (event.type === "message_update") {
      this.handleAssistantEvent(event);
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.terminalError =
        event.message.stopReason === "error" ? (event.message.errorMessage ?? "Pi run failed") : undefined;
      return;
    }
    if (event.type === "tool_execution_start") {
      this.queueTool({ toolCallId: event.toolCallId, status: "running" });
      return;
    }
    if (event.type === "tool_execution_update") {
      this.queueTool({ toolCallId: event.toolCallId, status: "running", result: resultText(event.partialResult) });
      return;
    }
    if (event.type === "tool_execution_end") {
      const result = resultText(event.result);
      this.queueTool({ toolCallId: event.toolCallId, status: event.isError ? "error" : "complete", result }, true);
      this.emit({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${event.toolCallId}:tool`,
        toolCallId: event.toolCallId,
        content: result,
        role: "tool",
      });
      return;
    }
    if (event.type === "agent_settled") {
      if (this.terminalError) this.fail(this.terminalError);
      else this.finish();
    }
  }

  fail(error: unknown): void {
    if (!this.activeRun) return;
    this.emit({ type: EventType.MESSAGES_SNAPSHOT, messages: projectMessages(this.session) }, true);
    this.emit(
      {
        type: EventType.RUN_ERROR,
        message: error instanceof Error ? error.message : String(error),
        code: "PI_RUN_ERROR",
      },
      true,
    );
    this.activeRun = undefined;
    this.assistantMessageId = undefined;
    this.terminalError = undefined;
  }

  complete(): void {
    this.finish();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.toolTimer) clearTimeout(this.toolTimer);
    this.timer = undefined;
    this.toolTimer = undefined;
    this.flush();
    this.flushTools();
  }

  private handleAssistantEvent(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
    const update = event.assistantMessageEvent;
    const messageId = this.assistantMessageId ?? piMessageId(this.session, event.message);
    if (update.type === "text_start") {
      this.emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
    } else if (update.type === "text_delta") {
      this.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: update.delta });
    } else if (update.type === "text_end") {
      this.emit({ type: EventType.TEXT_MESSAGE_END, messageId });
    } else if (update.type === "thinking_start") {
      const part = update.partial.content[update.contentIndex];
      if (part?.type === "thinking" && !part.redacted) {
        const reasoningId = `${messageId}:reasoning:${update.contentIndex}`;
        this.emit({ type: EventType.REASONING_START, messageId: reasoningId });
        this.emit({ type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning" });
      }
    } else if (update.type === "thinking_delta") {
      const part = update.partial.content[update.contentIndex];
      if (part?.type === "thinking" && !part.redacted) {
        this.emit({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: `${messageId}:reasoning:${update.contentIndex}`,
          delta: update.delta,
        });
      }
    } else if (update.type === "thinking_end") {
      const part = update.partial.content[update.contentIndex];
      if (part?.type === "thinking" && !part.redacted) {
        const reasoningId = `${messageId}:reasoning:${update.contentIndex}`;
        this.emit({ type: EventType.REASONING_MESSAGE_END, messageId: reasoningId });
        this.emit({ type: EventType.REASONING_END, messageId: reasoningId });
      }
    } else if (update.type === "toolcall_start") {
      const part = update.partial.content[update.contentIndex];
      if (part?.type === "toolCall") {
        this.emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: part.id,
          toolCallName: part.name,
          parentMessageId: messageId,
        });
      }
    } else if (update.type === "toolcall_delta") {
      const part = update.partial.content[update.contentIndex];
      if (part?.type === "toolCall") {
        this.emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: part.id, delta: update.delta });
      }
    } else if (update.type === "toolcall_end") {
      this.emit({ type: EventType.TOOL_CALL_END, toolCallId: update.toolCall.id });
    }
  }

  private finish(): void {
    if (!this.activeRun) return;
    const runId = this.activeRun.runId;
    this.emit({ type: EventType.MESSAGES_SNAPSHOT, messages: projectMessages(this.session) }, true);
    this.emit(
      {
        type: EventType.RUN_FINISHED,
        threadId: this.session.sessionId,
        runId,
        outcome: { type: "success" },
      },
      true,
    );
    this.activeRun = undefined;
    this.assistantMessageId = undefined;
    this.terminalError = undefined;
  }

  private emit(event: BaseEvent, immediate = false): void {
    if (!this.activeRun && event.type !== EventType.RUN_STARTED) return;
    this.sequence += 1;
    this.activeRun?.events.push(event);
    this.pending.push({
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.session.sessionId,
      runId: this.activeRun?.runId,
      sequence: this.sequence,
      event,
    });
    if (immediate || event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.flush();
      return;
    }
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, 16);
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    this.onEvents({
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.session.sessionId,
      fromSequence: events[0]?.sequence ?? this.sequence,
      toSequence: events.at(-1)?.sequence ?? this.sequence,
      events,
    });
  }

  private queueTool(update: SessionToolUpdate, immediate = false): void {
    this.pendingTools.set(update.toolCallId, update);
    if (immediate) {
      if (this.toolTimer) clearTimeout(this.toolTimer);
      this.toolTimer = undefined;
      this.flushTools();
      return;
    }
    if (!this.toolTimer) {
      this.toolTimer = setTimeout(() => {
        this.toolTimer = undefined;
        this.flushTools();
      }, 16);
    }
  }

  private flushTools(): void {
    if (this.pendingTools.size === 0) return;
    const updates = [...this.pendingTools.values()];
    this.pendingTools.clear();
    for (const update of updates) this.onTool(update);
  }
}

function removedMessages(previous: readonly string[], current: readonly string[]): string[] {
  const remaining = [...current];
  return previous.filter((message) => {
    const index = remaining.indexOf(message);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

function userMessageText(message: Extract<AgentSession["messages"][number], { role: "user" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
