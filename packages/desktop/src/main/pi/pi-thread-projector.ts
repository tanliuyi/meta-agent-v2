import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type JsonValue,
  type PiAssistantMessage,
  type PiAssistantPart,
  type PiAssistantStatus,
  type PiQueueItem,
  type PiThreadEvent,
  type PiThreadEventBatch,
  type PiThreadEventEnvelope,
  type PiThreadPhase,
  type PiThreadSnapshot,
  type PiTimelineNode,
  type PiToolCallPart,
  type PiUserContentPart,
  PROTOCOL_VERSION,
} from "../../shared/contracts.ts";

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
  accepted: boolean;
  createdAt: number;
}

/** 将 Pi public session tree 与 live events 投影为 Desktop timeline。 */
export class PiThreadProjector {
  private readonly projectId: string;
  private readonly session: AgentSession;
  private readonly publish: (batch: PiThreadEventBatch) => void;
  private nodes: PiTimelineNode[] = [];
  private readonly byId = new Map<string, PiTimelineNode>();
  private readonly visibleByEntryId = new Map<string, string | null>();
  private readonly messageNodeIds = new Map<AgentMessage, string>();
  private readonly liveMessages = new Set<AgentMessage>();
  private readonly toolOwners = new Map<string, ToolOwner>();
  private readonly finalAssistantMessages = new Map<string, AssistantMessage>();
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
  private pending: PiThreadEventEnvelope[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private checkpointScheduled = false;

  constructor(options: ProjectorOptions) {
    this.projectId = options.projectId;
    this.session = options.session;
    this.publish = options.publish;
    this.rebuildBranch(false);
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
    return {
      protocolVersion: PROTOCOL_VERSION,
      projectId: this.projectId,
      threadId: this.session.sessionId,
      cursor: this.sequence,
      headId: this.nodes.at(-1)?.id ?? null,
      nodes: this.nodes,
      queue: this.queueItems,
      phase: this.phase,
      ...(this.activeTurnId ? { activeTurnId: this.activeTurnId } : {}),
    };
  }

  beginPrompt(requestId: string, desiredMode: "steer" | "followUp" | undefined, queueEligible: boolean): void {
    this.pendingPrompts.push({ requestId, desiredMode, queueEligible, accepted: false, createdAt: Date.now() });
  }

  markPromptPreflight(requestId: string, accepted: boolean): void {
    const prompt = this.pendingPrompts.find((item) => item.requestId === requestId);
    if (!prompt) return;
    prompt.accepted = accepted;
    if (accepted) return;
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

  notify(message: string, notificationType: "info" | "warning" | "error"): void {
    const createdAt = Date.now();
    const active = this.activeAssistantId ? this.byId.get(this.activeAssistantId) : undefined;
    if (active?.kind === "assistant") {
      this.ensurePart(active.id, {
        id: this.transientId("notification-part"),
        type: "notification",
        notificationType,
        text: message,
        createdAt,
      });
      return;
    }

    const node = {
      id: this.transientId("notification"),
      parentId: this.nodes.at(-1)?.id ?? null,
      createdAt,
      kind: "notice",
      noticeType: "notification",
      notificationType,
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
          partialResult: toJson(event.partialResult),
        }));
        return;
      case "tool_execution_end":
        this.replaceTool(event.toolCallId, (part) => ({
          ...part,
          execution: event.isError ? "error" : "complete",
          result: toJson(event.result),
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
      case "thinking_level_changed":
        return;
      case "auto_retry_start":
        this.setPhase("retrying", true);
        return;
      case "auto_retry_end":
        this.setPhase(this.session.isStreaming ? "running" : "idle", !event.success);
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
  }

  private startMessage(message: AgentMessage): void {
    if (this.messageNodeIds.has(message)) return;
    const parentId = this.nodes.at(-1)?.id ?? null;
    switch (message.role) {
      case "user": {
        const consumed = this.pendingConsumption.shift();
        const pending = consumed?.requestId
          ? this.pendingPrompts.find((item) => item.requestId === consumed.requestId)
          : this.pendingPrompts.find((item) => item.accepted);
        const id = this.transientId("user");
        const node = {
          id,
          parentId,
          createdAt: message.timestamp,
          kind: "user",
          content: userContent(message.content),
          delivery: {
            state: "live",
            ...(pending ? { requestId: pending.requestId } : {}),
            ...(consumed ? { queueId: consumed.id } : {}),
          },
        } satisfies PiTimelineNode;
        this.addNode(node, message);
        this.liveMessages.add(message);
        return;
      }
      case "assistant": {
        const id = this.transientId("assistant");
        const node = assistantNode(id, parentId, message, true);
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
        const node = customNotice(id, parentId, message);
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
        this.replaceNode({ ...current, content: userContent(message.content) });
        return;
      }
      case "assistant": {
        const id = this.messageNodeIds.get(message) ?? this.activeAssistantId;
        if (!id) throw new ProjectionError("assistant message_end 缺少 owner");
        const current = this.byId.get(id);
        if (!current || current.kind !== "assistant") throw new ProjectionError(`assistant owner 不存在: ${id}`);
        const canonical = assistantNode(id, current.parentId, message, true);
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
        this.replaceNode(customNotice(id, current.parentId, message, current.sourceEntryId));
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
    for (const entry of branch.slice(this.branchIds.length)) this.appendPersistedEntry(entry);
    this.branchIds = branch.map((entry) => entry.id);
  }

  private appendPersistedEntry(entry: SessionEntry): void {
    const parentId = entry.parentId ? (this.visibleByEntryId.get(entry.parentId) ?? null) : null;
    const projected = projectEntry(entry, parentId);
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
    if (liveId && this.byId.has(liveId)) {
      this.rekeyNode(liveId, projected);
    } else {
      this.addNode(projected, entry.type === "message" ? entry.message : undefined);
    }
    if (entry.type === "message") this.liveMessages.delete(entry.message);
    this.visibleByEntryId.set(entry.id, entry.id);
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
    this.nodes = [];
    this.byId.clear();
    this.visibleByEntryId.clear();
    this.messageNodeIds.clear();
    this.toolOwners.clear();
    for (const entry of branch) {
      const parentId = entry.parentId ? (this.visibleByEntryId.get(entry.parentId) ?? null) : null;
      const node = projectEntry(entry, parentId);
      if (!node) {
        if (entry.type === "message" && entry.message.role === "toolResult") this.foldToolResult(entry.message, false);
        this.visibleByEntryId.set(entry.id, parentId);
        continue;
      }
      this.nodes.push(node);
      this.byId.set(node.id, node);
      this.visibleByEntryId.set(entry.id, node.id);
      if (entry.type === "message") this.messageNodeIds.set(entry.message, node.id);
      this.indexTools(node);
    }
    if (preserveLive) {
      for (const { message, node } of liveOverlay) {
        if (this.messageNodeIds.has(message)) {
          this.liveMessages.delete(message);
          continue;
        }
        const restored = { ...node, parentId: this.nodes.at(-1)?.id ?? null } as PiTimelineNode;
        this.nodes.push(restored);
        this.byId.set(restored.id, restored);
        this.messageNodeIds.set(message, restored.id);
        this.indexTools(restored);
      }
    } else {
      this.liveMessages.clear();
      this.finalAssistantMessages.clear();
      this.activeAssistantId = undefined;
    }
    for (const node of this.nodes) this.applyLabel(node.sourceEntryId ?? node.id, false);
    this.branchIds = branch.map((entry) => entry.id);
    if (!publish) return;
    const eventSequence = this.sequence + 1;
    const snapshot = { ...this.snapshot(), cursor: eventSequence };
    this.emit({ type: "branch-replaced", snapshot }, true);
  }

  private rekeyNode(previousId: string, canonical: PiTimelineNode): void {
    const current = this.byId.get(previousId);
    if (!current) throw new ProjectionError(`rekey node 不存在: ${previousId}`);
    const node = mergeCanonicalNode(current, canonical);
    this.byId.delete(previousId);
    this.byId.set(node.id, node);
    this.nodes = this.nodes.map((item) => {
      if (item.id === previousId) return node;
      if (item.parentId === previousId) {
        const child = { ...item, parentId: node.id } as PiTimelineNode;
        this.byId.set(child.id, child);
        return child;
      }
      return item;
    });
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
    this.nodes = [...this.nodes, node];
    this.byId.set(node.id, node);
    if (message) this.messageNodeIds.set(message, node.id);
    this.indexTools(node);
    this.emit({ type: "node-added", node });
  }

  private replaceNode(node: PiTimelineNode, emit = true): void {
    if (!this.byId.has(node.id)) throw new ProjectionError(`replace node 不存在: ${node.id}`);
    this.byId.set(node.id, node);
    this.nodes = this.nodes.map((item) => (item.id === node.id ? node : item));
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
      result: toJson({
        content: message.content,
        ...(message.details !== undefined ? { details: message.details } : {}),
        ...(message.addedToolNames ? { addedToolNames: message.addedToolNames } : {}),
      }),
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
    this.byId.set(node.id, replacement);
    this.nodes = this.nodes.map((item) => (item.id === node.id ? replacement : item));
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
    const candidates = this.nodes.filter(
      (node) =>
        node.kind === "notice" &&
        node.noticeType === "custom" &&
        !node.sourceEntryId &&
        node.content.type === "custom" &&
        node.content.customType === entry.customType &&
        sameJson(node.content.content, userContent(entry.content)) &&
        sameJson(node.content.details, entry.details),
    );
    return uniqueNodeMatch(candidates, `custom entry ${entry.id}`)?.id;
  }

  private findMatchingCustomNode(message: CustomMessage): PiTimelineNode | undefined {
    const boundIds = new Set(this.messageNodeIds.values());
    const candidates = this.nodes.filter(
      (node) =>
        node.kind === "notice" &&
        node.noticeType === "custom" &&
        Boolean(node.sourceEntryId) &&
        !boundIds.has(node.id) &&
        node.content.type === "custom" &&
        node.content.customType === message.customType &&
        sameJson(node.content.content, userContent(message.content)) &&
        sameJson(node.content.details, message.details),
    );
    return uniqueNodeMatch(candidates, `custom message ${message.customType}`);
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

function projectEntry(entry: SessionEntry, parentId: string | null): PiTimelineNode | undefined {
  const createdAt = timestamp(entry.timestamp);
  switch (entry.type) {
    case "message":
      return projectPersistedMessage(entry.id, parentId, createdAt, entry.message);
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
              content: userContent(entry.content),
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
): PiTimelineNode | undefined {
  switch (message.role) {
    case "user":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "user",
        content: userContent(message.content),
        delivery: { state: "persisted" },
      };
    case "assistant":
      return assistantNode(id, parentId, message, false, id, completedAt);
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
      return message.display ? customNotice(id, parentId, message, id, completedAt) : undefined;
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
      content: userContent(message.content),
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
      return { type: "complete", reason: "unknown" };
    case "length":
      return { type: "incomplete", reason: "length" };
    case "aborted":
      return { type: "incomplete", reason: "cancelled" };
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

function mergeCanonicalNode(current: PiTimelineNode, canonical: PiTimelineNode): PiTimelineNode {
  if (current.kind === "assistant" && canonical.kind === "assistant") {
    return {
      ...canonical,
      content: mergeAssistantContent(canonical.content, current.content),
      status: current.status,
    };
  }
  if (current.kind === "user" && canonical.kind === "user") return canonical;
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

function userContent(content: string | readonly unknown[]): PiUserContentPart[] {
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
      return [{ type: "image", data: part.data, mimeType: part.mimeType }];
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
