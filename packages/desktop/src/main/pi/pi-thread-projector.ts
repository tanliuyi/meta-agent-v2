import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUINotificationOptions,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type JsonValue,
  type PiAssistantMessage,
  type PiAssistantPart,
  type PiAssistantStatus,
  type PiPluginCallArtifact,
  type PiPluginSubCallRecord,
  type PiQueueItem,
  type PiQuote,
  type PiThreadEvent,
  type PiThreadEventBatch,
  type PiThreadEventEnvelope,
  type PiThreadPhase,
  type PiThreadSnapshot,
  type PiTimelineNode,
  type PiToolCallPart,
  type PiUserContentPart,
  PROTOCOL_VERSION,
  type SessionImageResource,
  type SessionImageResourceRef,
  type ThinkingLevel,
} from "../../shared/contracts.ts";
import { parseQuoteAttachmentData, QUOTE_ATTACHMENT_CUSTOM_TYPE, stripQuotePrefix } from "./quote-context.ts";

type AgentMessage = AgentSession["messages"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type CustomMessage = Extract<AgentMessage, { role: "custom" }>;

interface ProjectorOptions {
  projectId: string;
  session: AgentSession;
  publish(batch: PiThreadEventBatch): void;
}

interface ToolOwner {
  messageId: string;
  partId: string;
}

interface PendingPrompt {
  requestId: string;
  desiredMode?: "steer" | "followUp";
  queueEligible: boolean;
  text?: string;
  quote?: PiQuote;
  quotes?: readonly PiQuote[];
  accepted: boolean;
  createdAt: number;
}

interface PendingQuoteAttachment {
  entryId: string;
  requestId: string;
  quotes: readonly PiQuote[];
}

/** 将 Pi public session tree 与 live events 投影为 Desktop timeline。 */
export class PiThreadProjector {
  private readonly projectId: string;
  private readonly session: AgentSession;
  private readonly publish: (batch: PiThreadEventBatch) => void;
  /** user entry 落盘后回调（仅当该 prompt 带结构化引用时触发），由 adapter 注入以追加持久化引用附件。 */
  onUserEntryPersisted?: (entryId: string, requestId: string, quotes: readonly PiQuote[]) => void;
  /** requestId → 结构化引用；在 user entry 落盘（或 prompt 被拒/清空）前一直保留，覆盖 queued prompt 消费晚于 finishPrompt 的情况。 */
  private readonly pendingQuoteAttachments = new Map<string, readonly PiQuote[]>();
  /** 投影中被替换的原始图像主体（base64），worker 生命周期内持有，按 resourceId 按需读取。 */
  private readonly imageResources = new Map<string, { mimeType: string; data: string }>();
  /** 同一图像在 live、持久化和 branch rebuild 间复用 resourceId，避免重复主体与孤儿引用。 */
  private readonly imageResourceIds = new Map<string, string>();
  private readonly pluginArtifacts = new Map<
    string,
    { toolCallId: string; canonicalPath: string; size: number; sha256: string }
  >();
  private readonly registerImage = (mimeType: string, data: string) => this.registerImageResource(mimeType, data);
  private nodeIds: string[] = [];
  private nodeSnapshot: PiTimelineNode[] | undefined;
  private readonly byId = new Map<string, PiTimelineNode>();
  private readonly visibleByEntryId = new Map<string, string | null>();
  private readonly messageNodeIds = new Map<AgentMessage, string>();
  private readonly liveMessages = new Set<AgentMessage>();
  private readonly toolOwners = new Map<string, ToolOwner>();
  private readonly finalAssistantMessages = new Map<string, AssistantMessage>();
  private readonly slashResultNodes = new Map<string, string>();
  private branchIds: string[] = [];
  private queueItems: PiQueueItem[] = [];
  private pendingConsumption: PiQueueItem[] = [];
  private pendingPrompts: PendingPrompt[] = [];
  private phase: PiThreadPhase = "idle";
  private activeTurnId?: string;
  private activeAssistantId?: string;
  private sequence = 0;
  private transientCounter = 0;
  private queueCounter = 0;
  private queueClearInProgress = false;
  /** 当前 thinking 等级：live 阶段随 agent 状态/thinking_level_changed 事件推进，重建时从 "off" 回放会话入口记录。 */
  private thinkingLevel: ThinkingLevel = "off";
  private pending: PiThreadEventEnvelope[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private checkpointScheduled = false;

  constructor(options: ProjectorOptions) {
    this.projectId = options.projectId;
    this.session = options.session;
    this.publish = options.publish;
    this.rebuildBranch(false);
    // agent 状态是后续 live run 的实际依据；重建回放只负责补全历史消息的 provenance。
    this.thinkingLevel = options.session.thinkingLevel ?? "off";
    this.queueItems = reconcileQueue(
      [],
      this.session.getSteeringMessages(),
      this.session.getFollowUpMessages(),
      [],
      (mode) => this.nextQueueId(mode),
    );
    this.phase = this.session.isStreaming ? "running" : "idle";
  }

  snapshot(): PiThreadSnapshot {
    const nodes = this.nodes();
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.session.sessionId,
      cursor: this.sequence,
      headId: this.nodeIds.at(-1) ?? null,
      nodes,
      queue: this.queueItems,
      phase: this.phase,
      ...(this.activeTurnId ? { activeTurnId: this.activeTurnId } : {}),
    };
  }

  beginPrompt(
    requestId: string,
    desiredMode: "steer" | "followUp" | undefined,
    queueEligible: boolean,
    text?: string,
    quote?: PiQuote,
    quotes?: readonly PiQuote[],
  ): void {
    const pendingQuotes = quotes?.length ? [...quotes] : quote ? [quote] : undefined;
    if (pendingQuotes) this.pendingQuoteAttachments.set(requestId, pendingQuotes);
    this.pendingPrompts.push({
      requestId,
      desiredMode,
      queueEligible,
      text,
      quote,
      ...(pendingQuotes ? { quotes: pendingQuotes } : {}),
      accepted: false,
      createdAt: Date.now(),
    });
  }

  markPromptPreflight(requestId: string, accepted: boolean): void {
    const prompt = this.pendingPrompts.find((item) => item.requestId === requestId);
    if (!prompt) return;
    prompt.accepted = accepted;
    if (accepted) return;
    this.pendingQuoteAttachments.delete(requestId);
    let replaced = false;
    this.queueItems = this.queueItems.map((item) => {
      if (item.requestId !== requestId) return item;
      replaced = true;
      return {
        id: this.nextQueueId(item.mode),
        mode: item.mode,
        prompt: item.prompt,
        source: "pi-observed",
      };
    });
    this.pendingPrompts = this.pendingPrompts.filter((item) => item !== prompt);
    if (replaced) this.emit({ type: "queue-replaced", items: this.queueItems }, true);
  }

  hasQueuedRequest(requestId: string): boolean {
    return this.queueItems.some((item) => item.requestId === requestId);
  }

  finishPrompt(requestId: string): void {
    this.pendingPrompts = this.pendingPrompts.filter((item) => item.requestId !== requestId);
    this.synchronizePersistedBranch();
  }

  notify(
    message: string,
    notificationType: "info" | "warning" | "error",
    options?: ExtensionUINotificationOptions,
  ): void {
    const createdAt = Date.now();
    const customType = options?.customType.trim();
    const extensionNotification = customType
      ? {
          customType,
          ...(options?.details !== undefined ? { details: toJson(options.details) } : {}),
        }
      : undefined;
    const active = this.activeAssistantId ? this.byId.get(this.activeAssistantId) : undefined;
    if (active?.kind === "assistant") {
      this.ensurePart(active.id, {
        id: this.transientId("notification-part"),
        type: "notification",
        notificationType,
        text: message,
        ...(extensionNotification ? { extensionNotification } : {}),
        createdAt,
      });
      return;
    }

    const node = {
      id: this.transientId("notification"),
      parentId: this.nodeIds.at(-1) ?? null,
      createdAt,
      kind: "notice",
      noticeType: "notification",
      notificationType,
      ...(extensionNotification ? { extensionNotification } : {}),
      title: message,
      content: { type: "text", text: message },
    } satisfies PiTimelineNode;
    this.addNode(node);
  }

  checkpoint(): void {
    this.synchronizePersistedBranch();
  }

  resync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.rebuildBranch(true, true);
  }

  handle(event: AgentSessionEvent): void {
    this.synchronizePersistedBranch();
    switch (event.type) {
      case "agent_start":
        this.setPhase("running");
        return;
      case "agent_end":
        return;
      case "agent_settled":
        this.activeTurnId = undefined;
        this.activeAssistantId = undefined;
        this.setPhase("idle", true);
        return;
      case "turn_start":
        this.activeTurnId = `turn:${this.session.sessionId}:${++this.transientCounter}`;
        this.emit({ type: "phase-changed", phase: this.phase, activeTurnId: this.activeTurnId });
        return;
      case "turn_end":
        this.finishAssistantTurn(event.message);
        this.activeTurnId = undefined;
        return;
      case "message_start":
        if (this.phase === "retrying" && event.message.role === "assistant") this.setPhase("running");
        this.startMessage(event.message);
        return;
      case "message_update":
        this.updateAssistantMessage(event);
        return;
      case "message_end":
        this.endMessage(event.message);
        this.scheduleCheckpoint();
        return;
      case "tool_execution_start": {
        const args = toJson(event.args);
        this.replaceTool(event.toolCallId, (part) => ({
          ...part,
          args: isJsonObject(args) ? args : part.args,
          argsText: JSON.stringify(args),
          execution: "running",
        }));
        return;
      }
      case "tool_execution_update":
        this.replaceTool(event.toolCallId, (part) => ({
          ...part,
          execution: "running",
          partialResult: this.projectToolResultJson(event.partialResult),
          ...(this.projectPluginCallArtifact(event.toolCallId, event.partialResult)
            ? { pluginCall: this.projectPluginCallArtifact(event.toolCallId, event.partialResult) }
            : {}),
        }));
        return;
      case "tool_execution_end":
        this.replaceTool(event.toolCallId, (part) => ({
          ...part,
          execution: event.isError ? "error" : "complete",
          result: this.projectToolResultJson(event.result),
          ...(this.projectPluginCallArtifact(event.toolCallId, event.result)
            ? { pluginCall: this.projectPluginCallArtifact(event.toolCallId, event.result) }
            : {}),
          isError: event.isError,
        }));
        return;
      case "queue_update":
        this.replaceQueue(event.steering, event.followUp);
        return;
      case "compaction_start":
        this.setPhase("compacting", true);
        return;
      case "compaction_end":
        this.scheduleCheckpoint();
        this.setPhase(this.session.isStreaming || event.willRetry ? "running" : "idle", true);
        return;
      case "entry_appended":
        this.synchronizePersistedBranch();
        return;
      case "session_info_changed":
        return;
      case "thinking_level_changed":
        this.thinkingLevel = event.level;
        return;
      case "auto_retry_start":
        this.setPhase("retrying", true);
        return;
      case "auto_retry_end":
        this.setPhase(this.session.isStreaming ? "running" : "idle", !event.success);
        return;
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      case "bash_execution_update":
        return;
      default:
        assertNever(event);
    }
  }

  beginTreeNavigation(): void {
    this.setPhase("tree-navigation", true);
  }

  endTreeNavigation(): void {
    this.rebuildBranch(true);
    this.setPhase(this.session.isStreaming ? "running" : "idle", true);
  }

  beginQueueClear(): void {
    this.queueClearInProgress = true;
    this.pendingConsumption = [];
  }

  endQueueClear(): void {
    this.queueClearInProgress = false;
    // 清空的 prompt 由 renderer 连同引用恢复到 composer，未落盘的引用附件随之作废。
    this.pendingQuoteAttachments.clear();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    this.publish({
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.session.sessionId,
      fromSequence: events[0]?.sequence ?? this.sequence,
      toSequence: events.at(-1)?.sequence ?? this.sequence,
      events,
    });
  }

  dispose(): void {
    this.flush();
    this.imageResources.clear();
    this.pluginArtifacts.clear();
    this.imageResourceIds.clear();
  }

  private startMessage(message: AgentMessage): void {
    if (this.messageNodeIds.has(message)) return;
    const parentId = this.nodeIds.at(-1) ?? null;
    switch (message.role) {
      case "user": {
        const consumed = this.pendingConsumption.shift();
        const pending = consumed?.requestId
          ? this.pendingPrompts.find((item) => item.requestId === consumed.requestId)
          : this.pendingPrompts.find((item) => item.accepted);
        const requestId = consumed?.requestId ?? pending?.requestId;
        const pendingQuotes =
          pending?.quotes ??
          (pending?.quote ? [pending.quote] : undefined) ??
          (requestId ? this.pendingQuoteAttachments.get(requestId) : undefined);
        const id = this.transientId("user");
        const node = {
          id,
          parentId,
          createdAt: message.timestamp,
          kind: "user",
          content:
            pending?.text === undefined
              ? pendingQuotes && pendingQuotes.length > 0
                ? userContentWithQuoteStrip(message.content, pendingQuotes, this.registerImage)
                : userContent(message.content, this.registerImage)
              : userContentWithText(message.content, pending.text, this.registerImage),
          ...(pendingQuotes && pendingQuotes.length > 0 ? quoteFields(pendingQuotes) : {}),
          delivery: {
            state: "live",
            ...(requestId ? { requestId } : {}),
            ...(consumed ? { queueId: consumed.id } : {}),
          },
        } satisfies PiTimelineNode;
        this.addNode(node, message);
        this.liveMessages.add(message);
        return;
      }
      case "assistant": {
        const id = this.transientId("assistant");
        const node = assistantNode(id, parentId, message, true, undefined, undefined, this.thinkingLevel);
        this.activeAssistantId = id;
        this.addNode(node, message);
        this.liveMessages.add(message);
        return;
      }
      case "custom": {
        const canonical = this.findMatchingCustomNode(message);
        if (canonical) {
          this.messageNodeIds.set(message, canonical.id);
          return;
        }
        if (!message.display) return;
        const id = this.transientId("custom");
        const node = customNotice(id, parentId, message, this.registerImage);
        this.addNode(node, message);
        this.liveMessages.add(message);
        return;
      }
      case "toolResult":
        return;
      case "bashExecution":
      case "branchSummary":
      case "compactionSummary":
        return;
      default:
        assertNever(message);
    }
  }

  private updateAssistantMessage(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
    const messageId = this.messageNodeIds.get(event.message) ?? this.activeAssistantId;
    if (!messageId) throw new ProjectionError("assistant message_update 缺少 owner");
    const update = event.assistantMessageEvent;
    switch (update.type) {
      case "start":
      case "done":
      case "error":
        return;
      case "text_start":
        this.ensurePart(messageId, { id: partId(messageId, "text", update.contentIndex), type: "text", text: "" });
        return;
      case "text_delta":
        this.emit({
          type: "text-delta",
          messageId,
          partId: partId(messageId, "text", update.contentIndex),
          delta: update.delta,
        });
        this.applyTextDelta(messageId, partId(messageId, "text", update.contentIndex), update.delta);
        return;
      case "text_end":
        this.replaceTextPart(messageId, partId(messageId, "text", update.contentIndex), update.content);
        return;
      case "thinking_start": {
        const content = update.partial.content[update.contentIndex];
        if (content?.type === "thinking" && !content.redacted)
          this.ensurePart(messageId, {
            id: partId(messageId, "reasoning", update.contentIndex),
            type: "reasoning",
            text: "",
          });
        return;
      }
      case "thinking_delta": {
        const content = update.partial.content[update.contentIndex];
        if (!content || content.type !== "thinking" || content.redacted) return;
        const id = partId(messageId, "reasoning", update.contentIndex);
        this.emit({ type: "reasoning-delta", messageId, partId: id, delta: update.delta });
        this.applyTextDelta(messageId, id, update.delta);
        return;
      }
      case "thinking_end": {
        const content = update.partial.content[update.contentIndex];
        if (content?.type === "thinking" && !content.redacted)
          this.replaceTextPart(messageId, partId(messageId, "reasoning", update.contentIndex), update.content);
        return;
      }
      case "toolcall_start": {
        const content = update.partial.content[update.contentIndex];
        if (content?.type !== "toolCall") return;
        this.ensurePart(messageId, toolPart(messageId, update.contentIndex, content, "streaming-args"));
        return;
      }
      case "toolcall_delta": {
        const content = update.partial.content[update.contentIndex];
        if (content?.type !== "toolCall") return;
        const owner = this.toolOwners.get(content.id);
        if (!owner) throw new ProjectionError(`toolcall_delta 缺少 owner: ${content.id}`);
        const args = toJson(content.arguments);
        this.replaceTool(content.id, (part) => ({
          ...part,
          args: isJsonObject(args) ? args : part.args,
          argsText: part.argsText + update.delta,
        }));
        return;
      }
      case "toolcall_end": {
        const replacement = toolPart(messageId, update.contentIndex, update.toolCall, "waiting");
        this.replaceTool(update.toolCall.id, () => replacement);
        return;
      }
      default:
        assertNever(update);
    }
  }

  private endMessage(message: AgentMessage): void {
    switch (message.role) {
      case "user": {
        const id = this.messageNodeIds.get(message);
        if (!id) return;
        const current = this.byId.get(id);
        if (!current || current.kind !== "user") return;
        this.replaceNode({
          ...current,
          content: current.quote || current.quotes ? current.content : userContent(message.content, this.registerImage),
        });
        return;
      }
      case "assistant": {
        const id = this.messageNodeIds.get(message) ?? this.activeAssistantId;
        if (!id) throw new ProjectionError("assistant message_end 缺少 owner");
        const current = this.byId.get(id);
        if (!current || current.kind !== "assistant") throw new ProjectionError(`assistant owner 不存在: ${id}`);
        const canonical = assistantNode(id, current.parentId, message, true, undefined, undefined, this.thinkingLevel);
        canonical.sourceEntryId = current.sourceEntryId;
        canonical.content = mergeAssistantContent(canonical.content, current.content);
        this.finalAssistantMessages.set(id, message);
        this.replaceNode(canonical);
        return;
      }
      case "toolResult":
        this.foldToolResult(message);
        return;
      case "custom": {
        if (!message.display) return;
        const id = this.messageNodeIds.get(message);
        if (!id) return;
        const current = this.byId.get(id);
        if (!current) return;
        this.replaceNode(customNotice(id, current.parentId, message, this.registerImage, current.sourceEntryId));
        return;
      }
      case "bashExecution":
      case "branchSummary":
      case "compactionSummary":
        return;
      default:
        assertNever(message);
    }
  }

  private finishAssistantTurn(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const id = this.messageNodeIds.get(message) ?? this.activeAssistantId;
    if (!id) return;
    const current = this.byId.get(id);
    if (!current || current.kind !== "assistant") return;
    const finalMessage = this.finalAssistantMessages.get(id) ?? message;
    const finished = {
      ...current,
      completedAt: current.completedAt ?? Date.now(),
      status: assistantStatus(finalMessage),
    } satisfies PiAssistantMessage;
    this.replaceNode(finished, false);
    this.emit({ type: "message-finished", message: finished });
    this.finalAssistantMessages.delete(id);
    this.activeAssistantId = undefined;
  }

  private replaceQueue(steering: readonly string[], followUp: readonly string[]): void {
    const previous = this.queueItems;
    const next = reconcileQueue(previous, steering, followUp, this.pendingPrompts, (mode) => this.nextQueueId(mode));
    const nextIds = new Set(next.map((item) => item.id));
    if (!this.queueClearInProgress) this.pendingConsumption.push(...previous.filter((item) => !nextIds.has(item.id)));
    this.queueItems = next;
    this.emit({ type: "queue-replaced", items: next }, true);
  }

  private synchronizePersistedBranch(): void {
    const leafId = this.session.sessionManager.getLeafId();
    if (leafId === this.branchIds.at(-1)) return;
    const branch = this.session.sessionManager.getBranch();
    const prefixMatches = this.branchIds.every((id, index) => branch[index]?.id === id);
    if (!prefixMatches || branch.length < this.branchIds.length) {
      this.rebuildBranch(true);
      return;
    }
    const attachments: PendingQuoteAttachment[] = [];
    for (const entry of branch.slice(this.branchIds.length)) this.appendPersistedEntry(entry, attachments);
    this.branchIds = branch.map((entry) => entry.id);
    // 延后到 sync 循环结束后再追加引用附件：保证单 prompt 时 leaf 仍是被引用的 user entry，
    // 批量消费时也不会把附件插进 user/assistant 之间。
    for (const attachment of attachments) {
      this.onUserEntryPersisted?.(attachment.entryId, attachment.requestId, attachment.quotes);
    }
  }

  private appendPersistedEntry(entry: SessionEntry, attachments?: PendingQuoteAttachment[]): void {
    this.applyThinkingLevelChange(entry);
    const parentId = entry.parentId ? (this.visibleByEntryId.get(entry.parentId) ?? null) : null;
    const slashRequestId = slashResultRequestId(entry);
    const slashNodeId = slashRequestId ? this.slashResultNodes.get(slashRequestId) : undefined;
    if (entry.type === "custom_message" && !entry.display && slashNodeId) {
      const current = this.byId.get(slashNodeId);
      if (current?.kind === "notice") this.replaceNode(updateCustomNotice(current, entry, this.registerImage));
      this.visibleByEntryId.set(entry.id, slashNodeId);
      return;
    }

    // 持久化的引用附件：按 data.userEntryId 精确挂到 user node（live 路径已由 startMessage 挂载，这里幂等兜底）。
    if (entry.type === "custom" && entry.customType === QUOTE_ATTACHMENT_CUSTOM_TYPE) {
      const parsed = parseQuoteAttachmentData(entry.data);
      if (parsed) {
        const userNodeId = this.visibleByEntryId.get(parsed.userEntryId);
        const userNode = userNodeId ? this.byId.get(userNodeId) : undefined;
        if (userNode?.kind === "user" && !userNode.quote && !userNode.quotes) {
          this.replaceNode({ ...userNode, ...quoteFields(parsed.quotes) });
        }
      }
      this.visibleByEntryId.set(entry.id, parentId);
      return;
    }

    const projected = projectEntry(entry, parentId, this.thinkingLevel, this.registerImage);
    if (!projected) {
      if (entry.type === "message" && entry.message.role === "toolResult") this.foldToolResult(entry.message);
      if (entry.type === "label") this.applyLabel(entry.targetId);
      this.visibleByEntryId.set(entry.id, parentId);
      return;
    }

    const liveId =
      entry.type === "message"
        ? (this.messageNodeIds.get(entry.message) ?? this.findLiveEntryMatch(entry, projected))
        : this.findLiveEntryMatch(entry, projected);
    // rekey 会把 byId 中的节点换成 persisted 形态（delivery 不带 requestId），先捕获 live 节点的 requestId。
    const liveUser =
      entry.type === "message" && entry.message.role === "user" && liveId ? this.byId.get(liveId) : undefined;
    const requestId =
      liveUser?.kind === "user" && liveUser.delivery.state === "live" ? liveUser.delivery.requestId : undefined;
    const quotes = requestId ? this.pendingQuoteAttachments.get(requestId) : undefined;
    if (requestId && quotes && quotes.length > 0) {
      this.pendingQuoteAttachments.delete(requestId);
      attachments?.push({ entryId: entry.id, requestId, quotes });
    }
    if (liveId && this.byId.has(liveId)) {
      this.rekeyNode(liveId, projected);
    } else {
      this.addNode(projected, entry.type === "message" ? entry.message : undefined);
    }
    if (entry.type === "message") this.liveMessages.delete(entry.message);
    this.visibleByEntryId.set(entry.id, entry.id);
    if (slashRequestId) this.slashResultNodes.set(slashRequestId, entry.id);
    this.applyLabel(entry.id);
  }

  private rebuildBranch(publish: boolean, preserveLive = false): void {
    if (publish) this.flush();
    const liveOverlay = preserveLive
      ? [...this.liveMessages].flatMap((message) => {
          const id = this.messageNodeIds.get(message);
          const node = id ? this.byId.get(id) : undefined;
          return node ? [{ message, node }] : [];
        })
      : [];
    const branch = this.session.sessionManager.getBranch();
    const quoteAttachments = new Map<string, readonly PiQuote[]>();
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== QUOTE_ATTACHMENT_CUSTOM_TYPE) continue;
      const parsed = parseQuoteAttachmentData(entry.data);
      if (parsed) quoteAttachments.set(parsed.userEntryId, parsed.quotes);
    }
    this.nodeIds = [];
    this.nodeSnapshot = undefined;
    this.byId.clear();
    this.visibleByEntryId.clear();
    this.messageNodeIds.clear();
    this.toolOwners.clear();
    this.slashResultNodes.clear();
    // 等级历史只以入口为准，重建时从 off 回放，避免复用 live 阶段的当前值。
    this.thinkingLevel = "off";
    for (const entry of branch) {
      this.applyThinkingLevelChange(entry);
      const parentId = entry.parentId ? (this.visibleByEntryId.get(entry.parentId) ?? null) : null;
      const slashRequestId = slashResultRequestId(entry);
      const slashNodeId = slashRequestId ? this.slashResultNodes.get(slashRequestId) : undefined;
      if (entry.type === "custom_message" && !entry.display && slashNodeId) {
        const current = this.byId.get(slashNodeId);
        if (current?.kind === "notice") this.replaceNode(updateCustomNotice(current, entry, this.registerImage), false);
        this.visibleByEntryId.set(entry.id, slashNodeId);
        continue;
      }
      const node = projectEntry(
        entry,
        parentId,
        this.thinkingLevel,
        this.registerImage,
        quoteAttachments.get(entry.id),
      );
      if (!node) {
        if (entry.type === "message" && entry.message.role === "toolResult") this.foldToolResult(entry.message, false);
        this.visibleByEntryId.set(entry.id, parentId);
        continue;
      }
      this.nodeIds.push(node.id);
      this.byId.set(node.id, node);
      this.visibleByEntryId.set(entry.id, node.id);
      if (slashRequestId) this.slashResultNodes.set(slashRequestId, node.id);
      if (entry.type === "message") this.messageNodeIds.set(entry.message, node.id);
      this.indexTools(node);
    }
    if (preserveLive) {
      for (const { message, node } of liveOverlay) {
        if (this.messageNodeIds.has(message)) {
          this.liveMessages.delete(message);
          continue;
        }
        const canonical = this.nodes().findLast((candidate) => sameLiveProjection(candidate, node));
        if (canonical) {
          const merged = mergeCanonicalNode(node, canonical);
          this.byId.set(canonical.id, merged);
          this.nodeSnapshot = undefined;
          this.messageNodeIds.set(message, canonical.id);
          this.liveMessages.delete(message);
          this.indexTools(merged);
          continue;
        }
        const restored = { ...node, parentId: this.nodeIds.at(-1) ?? null } as PiTimelineNode;
        this.nodeIds.push(restored.id);
        this.nodeSnapshot = undefined;
        this.byId.set(restored.id, restored);
        this.messageNodeIds.set(message, restored.id);
        this.indexTools(restored);
      }
    } else {
      this.liveMessages.clear();
      this.finalAssistantMessages.clear();
      this.activeAssistantId = undefined;
    }
    for (const node of this.nodes()) this.applyLabel(node.sourceEntryId ?? node.id, false);
    this.branchIds = branch.map((entry) => entry.id);
    if (!publish) return;
    const eventSequence = this.sequence + 1;
    const snapshot = { ...this.snapshot(), cursor: eventSequence };
    this.emit({ type: "branch-replaced", snapshot }, true);
  }

  private applyThinkingLevelChange(entry: SessionEntry): void {
    if (entry.type !== "thinking_level_change") return;
    this.thinkingLevel = entry.thinkingLevel as ThinkingLevel;
  }

  private rekeyNode(previousId: string, canonical: PiTimelineNode): void {
    const current = this.byId.get(previousId);
    if (!current) throw new ProjectionError(`rekey node 不存在: ${previousId}`);
    const node = mergeCanonicalNode(current, canonical);
    const nodes = new Array<PiTimelineNode>(this.nodeIds.length);
    const nodeIds = new Array<string>(this.nodeIds.length);
    for (let index = 0; index < this.nodeIds.length; index += 1) {
      const id = this.nodeIds[index]!;
      const item = id === previousId ? current : this.byId.get(id);
      if (!item) throw new ProjectionError(`node index 不一致: ${id}`);
      const replacement =
        item.id === previousId
          ? node
          : item.parentId === previousId
            ? ({ ...item, parentId: node.id } as PiTimelineNode)
            : item;
      if (replacement !== item && item.id !== previousId) this.byId.set(replacement.id, replacement);
      nodes[index] = replacement;
      nodeIds[index] = replacement.id;
    }
    this.byId.delete(previousId);
    this.byId.set(node.id, node);
    this.nodeIds = nodeIds;
    this.nodeSnapshot = nodes;
    for (const [message, id] of this.messageNodeIds) {
      if (id !== previousId) continue;
      this.messageNodeIds.set(message, node.id);
      this.liveMessages.delete(message);
    }
    for (const [toolCallId, owner] of this.toolOwners)
      if (owner.messageId === previousId) this.toolOwners.set(toolCallId, { ...owner, messageId: node.id });
    if (this.activeAssistantId === previousId) this.activeAssistantId = node.id;
    const final = this.finalAssistantMessages.get(previousId);
    if (final) {
      this.finalAssistantMessages.delete(previousId);
      this.finalAssistantMessages.set(node.id, final);
    }
    this.indexTools(node);
    this.emit({ type: "node-rekeyed", previousId, node }, true);
  }

  private addNode(node: PiTimelineNode, message?: AgentMessage): void {
    this.nodeIds.push(node.id);
    this.nodeSnapshot = undefined;
    this.byId.set(node.id, node);
    if (message) this.messageNodeIds.set(message, node.id);
    this.indexTools(node);
    this.emit({ type: "node-added", node });
  }

  private replaceNode(node: PiTimelineNode, emit = true): void {
    if (!this.byId.has(node.id)) throw new ProjectionError(`replace node 不存在: ${node.id}`);
    this.byId.set(node.id, node);
    this.nodeSnapshot = undefined;
    this.indexTools(node);
    if (emit) this.emit({ type: "node-replaced", node });
  }

  private ensurePart(messageId: string, part: PiAssistantPart): void {
    const node = this.byId.get(messageId);
    if (!node || node.kind !== "assistant") throw new ProjectionError(`part owner 不存在: ${messageId}`);
    if (node.content.some((item) => item.id === part.id)) return;
    this.replaceNode({ ...node, content: [...node.content, part] }, false);
    this.indexTool(messageId, part);
    this.emit({ type: "part-added", messageId, part });
  }

  private applyTextDelta(messageId: string, id: string, delta: string): void {
    const node = this.byId.get(messageId);
    if (!node || node.kind !== "assistant") throw new ProjectionError(`delta owner 不存在: ${messageId}`);
    const content = node.content.map((part) =>
      part.id === id && (part.type === "text" || part.type === "reasoning")
        ? { ...part, text: part.text + delta }
        : part,
    );
    this.replaceNode({ ...node, content }, false);
  }

  private replaceTextPart(messageId: string, id: string, text: string): void {
    const node = this.byId.get(messageId);
    if (!node || node.kind !== "assistant") return;
    const content = node.content.map((part) =>
      part.id === id && (part.type === "text" || part.type === "reasoning") ? { ...part, text } : part,
    );
    this.replaceNode({ ...node, content });
  }

  private replaceTool(toolCallId: string, update: (part: PiToolCallPart) => PiToolCallPart): void {
    const owner = this.toolOwners.get(toolCallId);
    if (!owner) throw new ProjectionError(`tool owner 不存在: ${toolCallId}`);
    const node = this.byId.get(owner.messageId);
    if (!node || node.kind !== "assistant") throw new ProjectionError(`tool message 不存在: ${owner.messageId}`);
    let replacement: PiToolCallPart | undefined;
    const content = node.content.map((part) => {
      if (part.id !== owner.partId || part.type !== "tool-call") return part;
      replacement = update(part);
      return replacement;
    });
    if (!replacement) throw new ProjectionError(`tool part 不存在: ${toolCallId}`);
    this.replaceNode({ ...node, content }, false);
    this.emit({ type: "tool-call-replaced", messageId: owner.messageId, part: replacement });
  }

  private foldToolResult(message: ToolResultMessage, emit = true): void {
    const owner = this.toolOwners.get(message.toolCallId);
    if (!owner) {
      if (emit) throw new ProjectionError(`toolResult 缺少 owner: ${message.toolCallId}`);
      return;
    }
    const update = (part: PiToolCallPart): PiToolCallPart => ({
      ...part,
      execution: message.isError ? "error" : "complete",
      result: this.projectToolResultJson({
        content: message.content,
        ...(message.details !== undefined ? { details: message.details } : {}),
        ...(message.addedToolNames ? { addedToolNames: message.addedToolNames } : {}),
        ...(message.usage ? { usage: message.usage } : {}),
      }),
      ...(this.projectPluginCallArtifact(message.toolCallId, {
        content: message.content,
        details: message.details,
      })
        ? {
            pluginCall: this.projectPluginCallArtifact(message.toolCallId, {
              content: message.content,
              details: message.details,
            }),
          }
        : {}),
      isError: message.isError,
    });
    if (emit) {
      this.replaceTool(message.toolCallId, update);
      return;
    }
    const node = this.byId.get(owner.messageId);
    if (!node || node.kind !== "assistant") return;
    const content = node.content.map((part) =>
      part.id === owner.partId && part.type === "tool-call" ? update(part) : part,
    );
    const replacement = { ...node, content };
    this.replaceNode(replacement, false);
  }

  private indexTools(node: PiTimelineNode): void {
    if (node.kind !== "assistant") return;
    for (const part of node.content) this.indexTool(node.id, part);
  }

  private indexTool(messageId: string, part: PiAssistantPart): void {
    if (part.type === "tool-call") this.toolOwners.set(part.toolCallId, { messageId, partId: part.id });
  }

  private findLiveEntryMatch(entry: SessionEntry, projected: PiTimelineNode): string | undefined {
    if (entry.type === "message") {
      const candidates = [...this.liveMessages].flatMap((message) => {
        const id = this.messageNodeIds.get(message);
        const node = id ? this.byId.get(id) : undefined;
        return node && node.parentId === projected.parentId && sameLiveProjection(node, projected) ? [node] : [];
      });
      return uniqueNodeMatch(candidates, `message entry ${entry.id}`)?.id;
    }
    if (entry.type !== "custom_message") return undefined;
    const candidates = this.nodes().filter(
      (node) =>
        node.kind === "notice" &&
        node.noticeType === "custom" &&
        !node.sourceEntryId &&
        node.content.type === "custom" &&
        node.content.customType === entry.customType &&
        sameJson(node.content.content, userContent(entry.content, this.registerImage)) &&
        sameJson(node.content.details, entry.details),
    );
    return uniqueNodeMatch(candidates, `custom entry ${entry.id}`)?.id;
  }

  private findMatchingCustomNode(message: CustomMessage): PiTimelineNode | undefined {
    const boundIds = new Set(this.messageNodeIds.values());
    const candidates = this.nodes().filter(
      (node) =>
        node.kind === "notice" &&
        node.noticeType === "custom" &&
        Boolean(node.sourceEntryId) &&
        !boundIds.has(node.id) &&
        node.content.type === "custom" &&
        node.content.customType === message.customType &&
        sameJson(node.content.content, userContent(message.content, this.registerImage)) &&
        sameJson(node.content.details, message.details),
    );
    return uniqueNodeMatch(candidates, `custom message ${message.customType}`);
  }

  /** byId 是更新权威；仅在 snapshot 或低频全量查询需要时组装有序数组。 */
  private nodes(): PiTimelineNode[] {
    if (!this.nodeSnapshot) {
      this.nodeSnapshot = this.nodeIds.map((id) => {
        const node = this.byId.get(id);
        if (!node) throw new ProjectionError(`node index 不一致: ${id}`);
        return node;
      });
    }
    return this.nodeSnapshot;
  }

  private applyLabel(entryId: string, emit = true): void {
    const nodeId = this.visibleByEntryId.get(entryId) ?? entryId;
    if (!nodeId) return;
    const node = this.byId.get(nodeId);
    if (!node) return;
    const label = this.session.sessionManager.getLabel(entryId);
    if (node.label === label) return;
    const replacement = { ...node, ...(label ? { label } : { label: undefined }) } as PiTimelineNode;
    this.replaceNode(replacement, emit);
  }

  private setPhase(phase: PiThreadPhase, immediate = false): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit(
      { type: "phase-changed", phase, ...(this.activeTurnId ? { activeTurnId: this.activeTurnId } : {}) },
      immediate,
    );
  }

  private scheduleCheckpoint(): void {
    if (this.checkpointScheduled) return;
    this.checkpointScheduled = true;
    queueMicrotask(() => {
      this.checkpointScheduled = false;
      this.synchronizePersistedBranch();
      this.flush();
    });
  }

  private emit(event: PiThreadEvent, immediate = false): void {
    this.sequence += 1;
    this.pending.push({
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.session.sessionId,
      sequence: this.sequence,
      event,
    });
    if (immediate) {
      this.flush();
      return;
    }
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, 16);
  }

  private transientId(kind: string): string {
    return `live:${this.session.sessionId}:${kind}:${++this.transientCounter}`;
  }

  /** 登记投影中遇到的原始图像主体（base64），返回 worker 生命周期内稳定的轻量引用。 */
  private registerImageResource(mimeType: string, data: string): SessionImageResourceRef {
    const digest = createHash("sha256").update(mimeType).update("\0").update(data).digest("hex");
    const existingId = this.imageResourceIds.get(digest);
    const existing = existingId ? this.imageResources.get(existingId) : undefined;
    if (existingId && existing?.mimeType === mimeType && existing.data === data) {
      return { resourceId: existingId, mimeType };
    }

    const resourceId = randomUUID();
    this.imageResources.set(resourceId, { mimeType, data });
    this.imageResourceIds.set(digest, resourceId);
    return { resourceId, mimeType };
  }

  /** 读取 timeline 引用的图像资源主体；未知或 worker 已结束的 ID 返回 undefined。 */
  readImageResource(resourceId: string): SessionImageResource | undefined {
    const resource = this.imageResources.get(resourceId);
    return resource ? { resourceId, ...resource } : undefined;
  }

  async resolvePluginCallArtifact(toolCallId: string, artifactId: string): Promise<string | undefined> {
    const artifact = this.pluginArtifacts.get(artifactId);
    if (artifact?.toolCallId !== toolCallId) return undefined;
    try {
      const info = await lstat(artifact.canonicalPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size) return undefined;
      return (await hashPluginArtifact(artifact.canonicalPath)) === artifact.sha256
        ? artifact.canonicalPath
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** 将 toolResult 载荷中的图像主体替换为资源引用：content image parts 与 details 截图。 */
  private projectToolResultJson(value: unknown): JsonValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) return toJson(value);
    const record = value as Record<string, unknown>;
    const { details: rawDetails, ...publicRecord } = record;
    const details = isPlainRecord(rawDetails) ? rawDetails : undefined;
    return toJson({
      ...publicRecord,
      ...(Array.isArray(record.content) ? { content: this.projectContentImages(record.content) } : {}),
      ...(details && details.kind !== "plugin-call-details-v1" ? { details: this.projectDetailsImages(details) } : {}),
    });
  }

  private projectPluginCallArtifact(toolCallId: string, value: unknown): PiPluginCallArtifact | undefined {
    if (!isPlainRecord(value) || !isPlainRecord(value.details)) return undefined;
    const details = value.details;
    if (
      details.kind !== "plugin-call-details-v1" ||
      typeof details.description !== "string" ||
      typeof details.generation !== "string" ||
      !Array.isArray(details.calls) ||
      !Array.isArray(details.logs) ||
      !Array.isArray(details.attachments)
    ) {
      return undefined;
    }
    const content = Array.isArray(value.content) ? value.content : [];
    const attachments: PiPluginCallArtifact["attachments"] = [];
    for (const candidate of details.attachments) {
      if (!isPlainRecord(candidate)) continue;
      if (candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string") {
        attachments.push({
          type: "image",
          ...this.registerImageResource(candidate.mimeType, candidate.data),
          ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
        });
      } else if (
        candidate.type === "image" &&
        typeof candidate.contentIndex === "number" &&
        isPlainRecord(content[candidate.contentIndex]) &&
        content[candidate.contentIndex].type === "image" &&
        typeof content[candidate.contentIndex].data === "string" &&
        typeof content[candidate.contentIndex].mimeType === "string"
      ) {
        const image = content[candidate.contentIndex];
        attachments.push({
          type: "image",
          ...this.registerImageResource(image.mimeType as string, image.data as string),
          ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
        });
      } else if (
        candidate.type === "file" &&
        typeof candidate.artifactId === "string" &&
        typeof candidate.canonicalPath === "string" &&
        typeof candidate.name === "string" &&
        typeof candidate.size === "number" &&
        typeof candidate.sha256 === "string"
      ) {
        this.pluginArtifacts.set(candidate.artifactId, {
          toolCallId,
          canonicalPath: candidate.canonicalPath,
          size: candidate.size,
          sha256: candidate.sha256,
        });
        attachments.push({
          type: "file",
          artifactId: candidate.artifactId,
          name: candidate.name,
          size: candidate.size,
          displayPath: candidate.name,
          ...(typeof candidate.mimeType === "string" ? { mimeType: candidate.mimeType } : {}),
        });
      }
    }
    return {
      kind: "plugin-call",
      description: details.description,
      generation: details.generation,
      calls: details.calls.filter(isPluginSubCallRecord) as PiPluginSubCallRecord[],
      logs: details.logs.flatMap((log) =>
        isPlainRecord(log) &&
        typeof log.sequence === "number" &&
        typeof log.level === "string" &&
        typeof log.text === "string"
          ? [{ sequence: log.sequence, level: log.level, text: log.text }]
          : [],
      ),
      attachments,
    };
  }

  /** 替换 content 数组中 {type:image,data,mimeType} 图像主体的 data 为资源引用。 */
  private projectContentImages(content: readonly unknown[]): unknown[] {
    return content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const record = part as Record<string, unknown>;
      if (record.type !== "image" || typeof record.data !== "string" || typeof record.mimeType !== "string") {
        return part;
      }
      const ref = this.registerImageResource(record.mimeType, record.data);
      return { type: "image", ...ref };
    });
  }

  /** 替换 details 中已知截图字段（screenshot / snapshot.screenshot）的 data URL 为资源引用。 */
  private projectDetailsImages(details: Record<string, unknown>): Record<string, unknown> {
    const projected = { ...details };
    projected.screenshot = this.projectScreenshot(details.screenshot);
    const snapshot = details.snapshot;
    if (isPlainRecord(snapshot)) {
      projected.snapshot = { ...snapshot, screenshot: this.projectScreenshot(snapshot.screenshot) };
    }
    return projected;
  }

  /** 将 data URL 截图替换为资源引用；非 data URL 原样返回。 */
  private projectScreenshot(value: unknown): unknown {
    if (typeof value === "string") {
      const ref = dataUrlToImageResourceRef(value, (mimeType, data) => this.registerImageResource(mimeType, data));
      return ref ?? value;
    }
    if (isPlainRecord(value) && typeof value.dataUrl === "string") {
      const ref = dataUrlToImageResourceRef(value.dataUrl, (mimeType, data) =>
        this.registerImageResource(mimeType, data),
      );
      return ref ? { ...value, dataUrl: ref } : value;
    }
    return value;
  }

  private nextQueueId(mode: "steer" | "followUp"): string {
    return `queue:${this.session.sessionId}:${mode}:${++this.queueCounter}`;
  }
}

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

function isPluginSubCallRecord(value: unknown): value is PiPluginSubCallRecord {
  return (
    isPlainRecord(value) &&
    typeof value.sequence === "number" &&
    typeof value.callId === "string" &&
    typeof value.pluginId === "string" &&
    typeof value.method === "string" &&
    ["builtin", "curated", "marketplace", "development"].includes(String(value.source)) &&
    ["queued", "running", "complete", "error", "aborted"].includes(String(value.state))
  );
}

async function hashPluginArtifact(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function slashResultRequestId(entry: SessionEntry): string | undefined {
  if (entry.type !== "custom_message" || entry.customType !== "subagent-slash-result") return undefined;
  if (!entry.details || typeof entry.details !== "object" || Array.isArray(entry.details)) return undefined;
  const requestId = Reflect.get(entry.details, "requestId");
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

function updateCustomNotice(
  current: Extract<PiTimelineNode, { kind: "notice" }>,
  entry: Extract<SessionEntry, { type: "custom_message" }>,
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
): PiTimelineNode {
  return {
    ...current,
    title: entry.customType,
    content: {
      type: "custom",
      customType: entry.customType,
      content: userContent(entry.content, registerImageResource),
      ...(entry.details !== undefined ? { details: toJson(entry.details) } : {}),
    },
  };
}

function projectEntry(
  entry: SessionEntry,
  parentId: string | null,
  thinkingLevel: ThinkingLevel,
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
  quotes?: readonly PiQuote[],
): PiTimelineNode | undefined {
  const createdAt = timestamp(entry.timestamp);
  switch (entry.type) {
    case "message":
      return projectPersistedMessage(
        entry.id,
        parentId,
        createdAt,
        entry.message,
        thinkingLevel,
        registerImageResource,
        quotes,
      );
    case "custom_message":
      return entry.display
        ? {
            id: entry.id,
            sourceEntryId: entry.id,
            parentId,
            createdAt,
            kind: "notice",
            noticeType: "custom",
            title: entry.customType,
            content: {
              type: "custom",
              customType: entry.customType,
              content: userContent(entry.content, registerImageResource),
              ...(entry.details !== undefined ? { details: toJson(entry.details) } : {}),
            },
          }
        : undefined;
    case "compaction":
      return {
        id: entry.id,
        sourceEntryId: entry.id,
        parentId,
        createdAt,
        kind: "notice",
        noticeType: "compaction",
        title: "上下文压缩",
        content: { type: "text", text: entry.summary },
        metadata: toJson({
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          fromHook: entry.fromHook ?? false,
          ...(entry.details !== undefined ? { details: entry.details } : {}),
        }),
      };
    case "branch_summary":
      return {
        id: entry.id,
        sourceEntryId: entry.id,
        parentId,
        createdAt,
        kind: "notice",
        noticeType: "branch-summary",
        title: "分支摘要",
        content: { type: "text", text: entry.summary },
        metadata: toJson({
          fromId: entry.fromId,
          fromHook: entry.fromHook ?? false,
          ...(entry.details !== undefined ? { details: entry.details } : {}),
        }),
      };
    case "thinking_level_change":
    case "model_change":
    case "custom":
    case "label":
    case "session_info":
      return undefined;
    default:
      return assertNever(entry);
  }
}

function projectPersistedMessage(
  id: string,
  parentId: string | null,
  completedAt: number,
  message: AgentMessage,
  thinkingLevel: ThinkingLevel,
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
  quotes?: readonly PiQuote[],
): PiTimelineNode | undefined {
  switch (message.role) {
    case "user":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "user",
        content: quotes?.length
          ? userContentWithQuoteStrip(message.content, quotes, registerImageResource)
          : userContent(message.content, registerImageResource),
        delivery: { state: "persisted" },
        ...(quotes?.length ? quoteFields(quotes) : {}),
      };
    case "assistant":
      return assistantNode(id, parentId, message, false, id, completedAt, thinkingLevel);
    case "bashExecution":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "notice",
        noticeType: "bash",
        title: message.command,
        content: {
          type: "command",
          command: message.command,
          output: message.output,
          ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
          cancelled: message.cancelled,
          truncated: message.truncated,
          ...(message.fullOutputPath ? { fullOutputPath: message.fullOutputPath } : {}),
          ...(message.excludeFromContext !== undefined ? { excludeFromContext: message.excludeFromContext } : {}),
        },
      };
    case "custom":
      return message.display ? customNotice(id, parentId, message, registerImageResource, id, completedAt) : undefined;
    case "compactionSummary":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "notice",
        noticeType: "compaction",
        title: "上下文压缩",
        content: { type: "text", text: message.summary },
        metadata: toJson({ tokensBefore: message.tokensBefore }),
      };
    case "branchSummary":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "notice",
        noticeType: "branch-summary",
        title: "分支摘要",
        content: { type: "text", text: message.summary },
        metadata: toJson({ fromId: message.fromId }),
      };
    case "toolResult":
      return undefined;
    default:
      return assertNever(message);
  }
}

function assistantNode(
  id: string,
  parentId: string | null,
  message: AssistantMessage,
  running: boolean,
  sourceEntryId?: string,
  completedAt?: number,
  thinkingLevel?: ThinkingLevel,
): PiAssistantMessage {
  return {
    id,
    ...(sourceEntryId ? { sourceEntryId } : {}),
    parentId,
    createdAt: message.timestamp,
    ...(completedAt !== undefined ? { completedAt } : {}),
    kind: "assistant",
    content: message.content.flatMap((content, index): PiAssistantPart[] => {
      if (content.type === "text") return [{ id: partId(id, "text", index), type: "text", text: content.text }];
      if (content.type === "thinking")
        return content.redacted
          ? []
          : [{ id: partId(id, "reasoning", index), type: "reasoning", text: content.thinking }];
      if (content.type === "toolCall") return [toolPart(id, index, content, "waiting")];
      return assertNever(content);
    }),
    status: running ? { type: "running" } : assistantStatus(message),
    provenance: {
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(message.responseModel ? { responseModel: message.responseModel } : {}),
      ...(message.responseId ? { responseId: message.responseId } : {}),
    },
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      ...(message.usage.cacheWrite1h !== undefined ? { cacheWrite1h: message.usage.cacheWrite1h } : {}),
      ...(message.usage.reasoning !== undefined ? { reasoning: message.usage.reasoning } : {}),
      totalTokens: message.usage.totalTokens,
      cost: { ...message.usage.cost },
    },
    ...(message.diagnostics ? { diagnostics: toJson(message.diagnostics) } : {}),
  };
}

function customNotice(
  id: string,
  parentId: string | null,
  message: CustomMessage,
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
  sourceEntryId?: string,
  createdAt = message.timestamp,
): PiTimelineNode {
  return {
    id,
    ...(sourceEntryId ? { sourceEntryId } : {}),
    parentId,
    createdAt,
    kind: "notice",
    noticeType: "custom",
    title: message.customType,
    content: {
      type: "custom",
      customType: message.customType,
      content: userContent(message.content, registerImageResource),
      ...(message.details !== undefined ? { details: toJson(message.details) } : {}),
    },
  };
}

function toolPart(
  messageId: string,
  index: number,
  content: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
  execution: PiToolCallPart["execution"],
): PiToolCallPart {
  const args = toJson(content.arguments);
  return {
    id: partId(messageId, "tool", index),
    type: "tool-call",
    toolCallId: content.id,
    toolName: content.name,
    args: isJsonObject(args) ? args : {},
    argsText: execution === "streaming-args" ? "" : JSON.stringify(args),
    execution,
  };
}

function assistantStatus(message: AssistantMessage): PiAssistantStatus {
  switch (message.stopReason) {
    case "stop":
      return { type: "complete", reason: "stop" };
    case "toolUse":
    case "deferred":
      return { type: "complete", reason: "unknown" };
    case "length":
      return { type: "incomplete", reason: "length" };
    case "aborted":
      return { type: "incomplete", reason: "cancelled" };
    case "pending":
      // Partial streaming message that has not reached a terminal state yet.
      return { type: "incomplete", reason: "other" };
    case "error":
      return {
        type: "incomplete",
        reason: "error",
        ...(message.errorMessage ? { error: message.errorMessage } : {}),
      };
    default:
      return assertNever(message.stopReason);
  }
}

function quoteFields(quotes: readonly PiQuote[]): { quote?: PiQuote; quotes?: PiQuote[] } {
  const first = quotes[0];
  if (!first) return {};
  return quotes.length === 1 ? { quote: first } : { quotes: [...quotes] };
}

function mergeCanonicalNode(current: PiTimelineNode, canonical: PiTimelineNode): PiTimelineNode {
  if (current.kind === "assistant" && canonical.kind === "assistant") {
    return {
      ...canonical,
      content: mergeAssistantContent(canonical.content, current.content),
      status: current.status,
    };
  }
  if (current.kind === "user" && canonical.kind === "user") {
    if (current.quotes) return { ...canonical, content: current.content, quotes: current.quotes };
    return current.quote ? { ...canonical, content: current.content, quote: current.quote } : canonical;
  }
  if (current.kind === "notice" && canonical.kind === "notice") return canonical;
  throw new ProjectionError(`rekey kind 不匹配: ${current.kind}/${canonical.kind}`);
}

function mergeAssistantContent(canonical: PiAssistantPart[], current: PiAssistantPart[]): PiAssistantPart[] {
  const canonicalByKey = new Map(
    canonical.flatMap((part) => {
      const key = assistantPartKey(part);
      return key ? ([[key, part]] as const) : [];
    }),
  );
  const retainedCanonicalKeys = new Set<string>();
  const merged = current.flatMap((part): PiAssistantPart[] => {
    if (part.type === "notification") return [part];
    const key = assistantPartKey(part);
    const replacement = key ? canonicalByKey.get(key) : undefined;
    if (!key || !replacement) return [];
    retainedCanonicalKeys.add(key);
    if (replacement.type !== "tool-call" || part.type !== "tool-call") return [replacement];
    return [
      {
        ...replacement,
        // Renderer 将 part.id 用作 tool DOM identity；assistant node rekey 时必须保持稳定。
        id: part.id,
        execution: part.execution,
        ...(part.partialResult !== undefined ? { partialResult: part.partialResult } : {}),
        ...(part.result !== undefined ? { result: part.result } : {}),
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
      },
    ];
  });
  merged.push(
    ...canonical.filter((part) => {
      const key = assistantPartKey(part);
      return key !== undefined && !retainedCanonicalKeys.has(key);
    }),
  );
  return merged;
}

function assistantPartKey(part: PiAssistantPart): string | undefined {
  if (part.type === "notification") return undefined;
  if (part.type === "tool-call") return `tool:${part.toolCallId}`;
  const contentIndex = part.id.slice(part.id.lastIndexOf(":") + 1);
  return `${part.type}:${contentIndex}`;
}

function userContentWithQuoteStrip(
  content: string | readonly unknown[],
  quotes: readonly PiQuote[],
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
): PiUserContentPart[] {
  const parts = userContent(content, registerImageResource);
  const first = parts[0];
  if (!first || first.type !== "text") return parts;
  const stripped = stripQuotePrefix(first.text, quotes);
  if (stripped === first.text) return parts;
  const rest = parts.slice(1);
  return stripped.length === 0 ? rest : [{ type: "text", text: stripped }, ...rest];
}

function userContentWithText(
  content: string | readonly unknown[],
  text: string,
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
): PiUserContentPart[] {
  return [
    { type: "text", text },
    ...userContent(content, registerImageResource).filter((part) => part.type === "image"),
  ];
}

function userContent(
  content: string | readonly unknown[],
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
): PiUserContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.flatMap((part): PiUserContentPart[] => {
    if (!part || typeof part !== "object" || !("type" in part)) return [];
    if (part.type === "text" && "text" in part && typeof part.text === "string")
      return [{ type: "text", text: part.text }];
    if (
      part.type === "image" &&
      "data" in part &&
      typeof part.data === "string" &&
      "mimeType" in part &&
      typeof part.mimeType === "string"
    )
      return [{ type: "image", ...registerImageResource(part.mimeType, part.data) }];
    return [];
  });
}

function reconcileQueue(
  previous: readonly PiQueueItem[],
  steering: readonly string[],
  followUp: readonly string[],
  pendingPrompts: readonly PendingPrompt[],
  createObservedId: (mode: "steer" | "followUp") => string,
): PiQueueItem[] {
  const available = new Map<"steer" | "followUp", Map<string, PiQueueItem[]>>();
  const prepare = (mode: "steer" | "followUp", prompts: readonly string[]) => {
    const byPrompt = new Map<string, PiQueueItem[]>();
    for (const item of previous.filter((candidate) => candidate.mode === mode)) {
      const items = byPrompt.get(item.prompt) ?? [];
      items.push(item);
      byPrompt.set(item.prompt, items);
    }
    const counts = new Map<string, number>();
    for (const prompt of prompts) counts.set(prompt, (counts.get(prompt) ?? 0) + 1);
    for (const [prompt, items] of byPrompt) {
      const retained = counts.get(prompt) ?? 0;
      if (retained < items.length) byPrompt.set(prompt, items.slice(items.length - retained));
    }
    available.set(mode, byPrompt);
  };
  prepare("steer", steering);
  prepare("followUp", followUp);
  const used = new Set<string>();
  const usedRequestIds = new Set<string>();
  const build = (prompts: readonly string[], mode: "steer" | "followUp") =>
    prompts.map((prompt) => {
      const existing = available
        .get(mode)
        ?.get(prompt)
        ?.find((item) => !used.has(item.id));
      if (existing) {
        used.add(existing.id);
        return existing;
      }
      const pending = pendingPrompts.find(
        (item) =>
          item.queueEligible &&
          (item.desiredMode ?? "followUp") === mode &&
          !usedRequestIds.has(item.requestId) &&
          !previous.some((queue) => queue.requestId === item.requestId),
      );
      if (pending) usedRequestIds.add(pending.requestId);
      const item: PiQueueItem = {
        id: pending?.requestId ? `queue:${pending.requestId}` : createObservedId(mode),
        mode,
        prompt,
        source: pending ? "desktop" : "pi-observed",
        ...(pending ? { requestId: pending.requestId, createdAt: pending.createdAt } : {}),
      };
      used.add(item.id);
      return item;
    });
  return [...build(steering, "steer"), ...build(followUp, "followUp")];
}

function partId(messageId: string, kind: string, index: number): string {
  return `${messageId}:${kind}:${index}`;
}

function timestamp(value: string): number {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(toJson(left)) === JSON.stringify(toJson(right));
}

function sameLiveProjection(left: PiTimelineNode, right: PiTimelineNode): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "user" && right.kind === "user") return sameJson(left.content, right.content);
  if (left.kind === "notice" && right.kind === "notice")
    return left.noticeType === right.noticeType && left.title === right.title && sameJson(left.content, right.content);
  if (left.kind !== "assistant" || right.kind !== "assistant") return false;
  const stableParts = (parts: readonly PiAssistantPart[]): JsonValue[] => {
    const stable: JsonValue[] = [];
    for (const part of parts) {
      if (part.type === "text" || part.type === "reasoning") stable.push({ type: part.type, text: part.text });
      else if (part.type === "tool-call")
        stable.push({ type: part.type, toolCallId: part.toolCallId, toolName: part.toolName, args: part.args });
    }
    return stable;
  };
  return sameJson(stableParts(left.content), stableParts(right.content));
}

function uniqueNodeMatch(candidates: readonly PiTimelineNode[], description: string): PiTimelineNode | undefined {
  if (candidates.length > 1) throw new ProjectionError(`${description} 存在多个 canonical identity 候选`);
  return candidates[0];
}

/** 将未知数据收窄为可安全传输的 JSON。 */
export function toJson(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === undefined)
    return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toJson(item, seen));
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) result[key] = toJson(item, seen);
  return result;
}

function assertNever(value: never): never {
  throw new ProjectionError(`不支持的 Pi discriminator: ${String(value)}`);
}

const DATA_URL_PATTERN = /^data:image\/([A-Za-z0-9.+-]+);base64,(.+)$/s;

/** 将 image/png 等 data URL 拆为资源引用；非图像 data URL 返回 undefined 保持原样。 */
function dataUrlToImageResourceRef(
  value: string,
  register: (mimeType: string, data: string) => SessionImageResourceRef,
): SessionImageResourceRef | undefined {
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) return undefined;
  return register(`image/${match[1]}`, match[2] ?? "");
}
